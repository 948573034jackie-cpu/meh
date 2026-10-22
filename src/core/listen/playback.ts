import type { Book, Position } from '@core/model';
import { sentenceKey } from '@core/model';
import type { TtsEngine, SpeakHandle } from '@core/tts/engine';
import { getSentence, nextPosition, prevPosition, paragraphStart, firstPosition } from '@core/nav';
import { tokenIndexAtChar } from '@core/tts/timing';
import { toOriginalRange, type StrippedText } from '@core/import/skip';

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'explaining';

export interface PlaybackHooks {
  /**
   * Called before a sentence is spoken. Return the token index of the first word the reading must stop at,
   * 'end' to stop after the sentence, or null to read normally.
   */
  stopAt?(pos: Position): number | 'end' | null;
  /**
   * The texts a stop in the sentence at `pos` would say first (its hard words, in order), so the engine synthesizes
   * them before the cut instead of after it: asked when a sentence starts and stopAt() stops it, and for the sentence
   * after it. Must not change any state (unlike stopAt, which ends the re-read guard).
   */
  stopTargets?(pos: Position): string[];
  /** Called when a sentence stopped (at a word or at its end because stopAt asked). Return what to do next. */
  onStop?(pos: Position, stoppedAtToken: number | null): Promise<'next' | 'stop'>;
}

export interface PlaybackEvents {
  state: (s: PlaybackState) => void;
  sentence: (pos: Position) => void;
  word: (pos: Position, tokenIndex: number) => void;
  sentenceEnd: (pos: Position) => void;
  finished: () => void;
  error: (e: Error) => void;
}

export interface TimelineEntry { pos: Position; start: number; end: number }

/**
 * Reads a book aloud sentence by sentence through a TtsEngine, emitting sentence/word events for the
 * highlighter, with hooks for the listening controller to stop at hard words and run explanations.
 * Pause works at sentence granularity: pausing cancels the current utterance and resuming re-reads the
 * sentence from its start, which keeps every engine (system voices, cloud audio) consistent.
 */
export class Playback {
  private _state: PlaybackState = 'idle';
  private _pos: Position;
  private gen = 0;
  private handle: SpeakHandle | null = null;
  /** the sentence currently being spoken (recorded in the timeline when it ends or is interrupted) */
  private speaking: TimelineEntry | null = null;
  /** speak handles that resolved 'error' back to back; one is retried, two stop the reading with the engine's message */
  private consecutiveErrors = 0;
  private listeners = new Map<keyof PlaybackEvents, Set<(...args: never[]) => void>>();
  readonly timeline: TimelineEntry[] = [];
  hooks: PlaybackHooks = {};

  constructor(
    private book: Book,
    private deps: {
      engine: () => TtsEngine; voice: () => { voiceId: string; rate: number }; pauseMs: () => number;
      /** Skip panel: sentences that are never read aloud (page numbers, footnotes, …) */
      shouldSkip?: (pos: Position) => boolean;
      /** Skip panel: removes brackets, citations, URLs … from the spoken text (offset map back to the page text) */
      strip?: (text: string) => StrippedText | null;
    },
    start?: Position,
  ) {
    this._pos = start ?? firstPosition(book) ?? { chapter: 0, paragraph: 0, sentence: 0 };
  }

  get state(): PlaybackState { return this._state; }
  get position(): Position { return this._pos; }

  on<K extends keyof PlaybackEvents>(ev: K, cb: PlaybackEvents[K]): () => void {
    let set = this.listeners.get(ev);
    if (!set) { set = new Set(); this.listeners.set(ev, set); }
    set.add(cb as (...args: never[]) => void);
    return () => { this.listeners.get(ev)?.delete(cb as (...args: never[]) => void); };
  }
  private emit<K extends keyof PlaybackEvents>(ev: K, ...args: Parameters<PlaybackEvents[K]>): void {
    for (const cb of this.listeners.get(ev) ?? []) (cb as (...a: unknown[]) => void)(...args);
  }
  private setState(s: PlaybackState): void { if (this._state !== s) { this._state = s; this.emit('state', s); } }

  play(from?: Position): void {
    if (from) this._pos = from;
    this.cancelCurrent();
    this.consecutiveErrors = 0;
    this.setState('playing');
    void this.run(++this.gen);
  }

  pause(): void {
    if (this._state === 'idle') return;
    this.gen++;
    this.cancelCurrent();
    this.deps.engine().stopReadAhead?.();
    this.setState('paused');
  }

  resume(): void { if (this._state === 'paused') this.play(); }

  stop(): void {
    this.gen++;
    this.cancelCurrent();
    this.deps.engine().stopReadAhead?.();
    this.setState('idle');
  }

  /** Moves the position; keeps playing from there if currently playing. */
  seek(pos: Position): void {
    const wasPlaying = this._state === 'playing' || this._state === 'explaining';
    this.gen++;
    this.cancelCurrent();
    this._pos = pos;
    this.emit('sentence', pos);
    if (wasPlaying) this.play();
    else this.setState(this._state === 'idle' ? 'idle' : 'paused');
  }

  next(): void { const p = nextPosition(this.book, this._pos); if (p) this.seek(p); }
  prev(): void { const p = prevPosition(this.book, this._pos); if (p) this.seek(p); }
  nextParagraph(): void { const p = paragraphStart(this.book, this._pos, 1); if (p) this.seek(p); }
  prevParagraph(): void { const p = paragraphStart(this.book, this._pos, -1); if (p) this.seek(p); }
  replay(): void { this.seek(this._pos); if (this._state !== 'playing') this.play(); }

  /**
   * The reading speed changed. Playing: an engine that can change the rate of the utterance playing goes on at the new
   * rate without starting the sentence again; one that cannot (Web Speech) re-speaks the sentence at the new rate.
   * During an explanation nothing changes (it keeps its own rate; the next sentence uses the new one).
   */
  rateChanged(): void {
    if (this._state !== 'playing') return;
    const engine = this.deps.engine();
    if (engine.setRate) engine.setRate(this.deps.voice().rate);
    else this.play();
  }

  /**
   * Not playing (a book just opened, a seek while paused): the sentence at `pos` (default: the current position) and the
   * two after it go to the engine's read-ahead, the first one at 'next' priority and pre-decoded, so Play starts from
   * the cache once the learner has waited about one synthesis time (and a short first sentence, such as a heading,
   * is not followed by a wait). While playing, Playback does this itself at every sentence. Local voices only: a cloud
   * voice costs money per character, and the learner may never press Play.
   */
  prime(pos: Position = this._pos): void {
    if (this._state === 'playing' || this._state === 'explaining') return;
    const engine = this.deps.engine();
    if (!engine.readAhead || engine.kind !== 'local') return;
    // as run() does: a position without a sentence (an empty first paragraph) reads from the next real one
    const start = getSentence(this.book, pos) ? pos : nextPosition(this.book, pos.sentence > 0 ? pos : { ...pos, sentence: -1 });
    if (!start) return;
    const texts = this.spokenTexts(start, true, PRIME_SENTENCES);
    if (!texts.length) return;
    const voice = this.deps.voice();
    engine.readAhead(texts, voice.voiceId, voice.rate);
  }

  /** Positions of the sentences spoken during the last `seconds`, oldest first, extended to whole sentences. */
  sentencesInLast(seconds: number): Position[] {
    const now = performance.now();
    const cutoff = now - seconds * 1000;
    const entries = this.speaking ? [...this.timeline, { ...this.speaking, end: now }] : this.timeline;
    let hits = entries.filter((t) => t.end >= cutoff);
    if (hits.length === 0 && entries.length) hits = [entries[entries.length - 1]];
    // a sentence restarted after a pause or a speed change appears once
    const seen = new Set<string>();
    const out: Position[] = [];
    for (const t of hits) { const k = sentenceKey(t.pos); if (!seen.has(k)) { seen.add(k); out.push(t.pos); } }
    return out;
  }

  private recordSpoken(): void {
    const sp = this.speaking;
    if (!sp) return;
    this.speaking = null;
    this.timeline.push({ ...sp, end: performance.now() });
    if (this.timeline.length > 200) this.timeline.shift();
  }

  private cancelCurrent(): void {
    const h = this.handle;
    this.handle = null;
    h?.cancel();
    this.recordSpoken();
    this.deps.engine().cancelAll();
  }

  private async run(gen: number): Promise<void> {
    while (gen === this.gen) {
      let pos = this._pos;
      let cur = getSentence(this.book, pos);
      if (!cur) {
        // e.g. a chapter whose first paragraph has no sentences: continue with the next real sentence
        const alt = nextPosition(this.book, pos.sentence > 0 ? pos : { ...pos, sentence: -1 });
        cur = alt ? getSentence(this.book, alt) : null;
        if (!alt || !cur) { this.setState('idle'); this.emit('finished'); return; }
        pos = alt; this._pos = alt;
      }
      if (this.deps.shouldSkip?.(pos)) {
        const n = nextPosition(this.book, pos);
        if (!n) { this.setState('idle'); this.emit('finished'); return; }
        this._pos = n;
        continue;
      }
      const st = this.deps.strip?.(cur.text) ?? null;
      const text = st ? st.text : cur.text;
      this.emit('sentence', pos);
      const stopAt = this.hooks.stopAt?.(pos) ?? null;
      // the words the stop will say: synthesized before the read-ahead, which shrinks to the next sentence (the
      // explanation asked for at the stop must not wait behind book work either)
      const urgent = stopAt !== null ? (this.hooks.stopTargets?.(pos) ?? []) : [];
      const engine = this.deps.engine();
      const voice = this.deps.voice();
      this.speaking = { pos, start: performance.now(), end: 0 };
      let stoppedAtToken: number | null = null;
      let lastToken = -1;
      let outcome: 'ended' | 'cancelled' | 'error' = 'ended';
      let handle: SpeakHandle | null = null;
      if (!text.trim()) this.prefetchAhead(engine, voice, urgent);
      if (text.trim()) {
        handle = engine.speak(text, {
          voiceId: voice.voiceId,
          rate: voice.rate,
          onWord: (charIndex) => {
            if (gen !== this.gen) return;
            const orig = st ? toOriginalRange(st, charIndex, 1).charIndex : charIndex;
            const idx = tokenIndexAtChar(cur.sentence, orig);
            if (idx === lastToken) return;
            lastToken = idx;
            if (typeof stopAt === 'number' && idx > stopAt && cur.sentence.tokens.slice(stopAt + 1, idx + 1).some((t) => t.kind === 'word')) {
              // the word after the hard word has started: stop here
              stoppedAtToken = stopAt;
              handle?.cancel({ fade: true });
              return;
            }
            this.emit('word', pos, idx);
          },
        });
        this.handle = handle;
        // after speak(): the sentence needed now is requested before the read-ahead
        this.prefetchAhead(engine, voice, urgent);
        outcome = await handle.done;
        if (this.handle === handle) this.handle = null;
      }
      if (gen !== this.gen) return;
      this.recordSpoken();
      if (outcome === 'error') {
        // one failure may be a hiccup the engine has already cleared (a stuck synthesizer it reset): re-read the
        // sentence once; a second failure in a row is a real problem the learner has to hear about
        if (++this.consecutiveErrors < 2) continue;
        this.emit('error', handle?.error ?? new Error('speech failed'));
        this.setState('paused');
        return;
      }
      this.consecutiveErrors = 0;
      if (outcome === 'cancelled' && stoppedAtToken === null) return; // paused/stopped externally
      // The hard word was the last word of the sentence, or the engine gave no word boundaries at all:
      // the sentence has been read completely, so the stop happens at its end.
      if (outcome === 'ended' && typeof stopAt === 'number' && stoppedAtToken === null && cur.sentence.tokens[stopAt]) stoppedAtToken = stopAt;
      this.emit('sentenceEnd', pos);
      if (stoppedAtToken !== null || stopAt === 'end') {
        this.setState('explaining');
        const action = (await this.hooks.onStop?.(pos, stoppedAtToken)) ?? 'next';
        if (gen !== this.gen) return;
        if (action === 'stop') { this.setState('paused'); return; }
        this.setState('playing');
      } else {
        await sleep(this.deps.pauseMs());
        if (gen !== this.gen) return;
      }
      const nextPos = nextPosition(this.book, pos);
      if (!nextPos) { this.setState('idle'); this.emit('finished'); return; }
      this._pos = nextPos;
    }
  }

  /**
   * Hands the engine the sentences after the current one: up to READ_AHEAD_SENTENCES or about READ_AHEAD_SECONDS
   * of speech, Skip-panel sentences left out, stripped text. Engines with readAhead() decide how far to go (the
   * local voice synthesizes all of them in the background, cloud voices only the next two); others get the next
   * two through prefetch(). A sentence that will stop (`urgent`: its hard words) hands over only the next sentence:
   * the stop's word and explanation then never wait behind book work, and the re-read of the sentence after the stop
   * hands over the whole list again. The hard words of the next sentence go along too (`upcoming`), so they are ready
   * when it starts even if a long read-ahead job is running then (a running job is never interrupted).
   */
  private prefetchAhead(engine: TtsEngine, voice: { voiceId: string; rate: number }, urgent: string[] = []): void {
    if (!engine.readAhead && !engine.prefetch) return;
    const texts = this.spokenTexts(this._pos, false, urgent.length ? 1 : READ_AHEAD_SENTENCES);
    if (!engine.readAhead) { for (const t of texts.slice(0, 2)) engine.prefetch!(t, voice.voiceId, voice.rate); return; }
    const next = this.hooks.stopTargets ? this.nextSpoken(this._pos) : null;
    engine.readAhead(texts, voice.voiceId, voice.rate, urgent, next ? (this.hooks.stopTargets!(next) ?? []) : []);
  }

  /** The next sentence that is read aloud (Skip-panel sentences and empty texts left out), as spokenTexts walks. */
  private nextSpoken(from: Position): Position | null {
    let p: Position | null = from;
    for (let guard = 0; p && guard < 200; guard++) {
      p = nextPosition(this.book, p);
      if (!p) return null;
      if (this.deps.shouldSkip?.(p)) continue;
      const s = getSentence(this.book, p);
      if (s && (this.deps.strip?.(s.text)?.text ?? s.text).trim()) return p;
    }
    return null;
  }

  /**
   * The spoken texts of up to `max` sentences from `from` (itself included or not), at most about READ_AHEAD_SECONDS
   * of speech: Skip-panel sentences left out, the Skip panel's stripped text, exactly as speak() will be asked.
   */
  private spokenTexts(from: Position, include: boolean, max: number): string[] {
    const texts: string[] = [];
    let seconds = 0;
    let p: Position | null = from;
    for (let guard = 0; p && texts.length < max && seconds < READ_AHEAD_SECONDS && guard < 200; guard++) {
      if (guard > 0 || !include) p = nextPosition(this.book, p);
      if (!p) break;
      if (this.deps.shouldSkip?.(p)) continue;
      const s = getSentence(this.book, p);
      const t = s ? (this.deps.strip?.(s.text)?.text ?? s.text) : '';
      if (!t.trim()) continue;
      texts.push(t);
      seconds += t.length / CHARS_PER_SECOND;
    }
    return texts;
  }
}

/** read-ahead limits: about a minute of speech, at most this many sentences */
export const READ_AHEAD_SENTENCES = 8;
export const READ_AHEAD_SECONDS = 60;
/** prime(): the start sentence and the two after it */
const PRIME_SENTENCES = 3;
/** speech at rate 1 is about 15 characters a second (150 words a minute) */
const CHARS_PER_SECOND = 15;

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
