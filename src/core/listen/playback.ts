import type { Book, Position } from '@core/model';
import { sentenceKey } from '@core/model';
import type { TtsEngine, SpeakHandle } from '@core/tts/engine';
import { getSentence, nextPosition, prevPosition, paragraphStart, firstPosition } from '@core/nav';
import { tokenIndexAtChar } from '@core/tts/timing';

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'explaining';

export interface PlaybackHooks {
  /**
   * Called before a sentence is spoken. Return the token index of the first word the reading must stop at,
   * 'end' to stop after the sentence, or null to read normally.
   */
  stopAt?(pos: Position): number | 'end' | null;
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
  private listeners = new Map<keyof PlaybackEvents, Set<(...args: never[]) => void>>();
  readonly timeline: TimelineEntry[] = [];
  hooks: PlaybackHooks = {};

  constructor(
    private book: Book,
    private deps: { engine: () => TtsEngine; voice: () => { voiceId: string; rate: number }; pauseMs: () => number },
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
    this.setState('playing');
    void this.run(++this.gen);
  }

  pause(): void {
    if (this._state === 'idle') return;
    this.gen++;
    this.cancelCurrent();
    this.setState('paused');
  }

  resume(): void { if (this._state === 'paused') this.play(); }

  stop(): void {
    this.gen++;
    this.cancelCurrent();
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

  /** Re-speaks the current sentence at the new rate when playing (engines cannot change rate mid-utterance). */
  rateChanged(): void { if (this._state === 'playing') this.play(); }

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
      const text = cur.text;
      this.emit('sentence', pos);
      const stopAt = this.hooks.stopAt?.(pos) ?? null;
      const engine = this.deps.engine();
      const voice = this.deps.voice();
      this.prefetchAhead(engine, voice);
      this.speaking = { pos, start: performance.now(), end: 0 };
      let stoppedAtToken: number | null = null;
      let lastToken = -1;
      let outcome: 'ended' | 'cancelled' | 'error' = 'ended';
      let handle: SpeakHandle | null = null;
      if (text.trim()) {
        handle = engine.speak(text, {
          voiceId: voice.voiceId,
          rate: voice.rate,
          onWord: (charIndex) => {
            if (gen !== this.gen) return;
            const idx = tokenIndexAtChar(cur.sentence, charIndex);
            if (idx === lastToken) return;
            lastToken = idx;
            if (typeof stopAt === 'number' && idx > stopAt && cur.sentence.tokens.slice(stopAt + 1, idx + 1).some((t) => t.kind === 'word')) {
              // the word after the hard word has started: stop here
              stoppedAtToken = stopAt;
              handle?.cancel();
              return;
            }
            this.emit('word', pos, idx);
          },
        });
        this.handle = handle;
        outcome = await handle.done;
        if (this.handle === handle) this.handle = null;
      }
      if (gen !== this.gen) return;
      this.recordSpoken();
      if (outcome === 'error') {
        this.emit('error', handle?.error ?? new Error('speech failed'));
        this.setState('paused');
        return;
      }
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

  private prefetchAhead(engine: TtsEngine, voice: { voiceId: string; rate: number }): void {
    if (!engine.prefetch) return;
    let p: Position | null = this._pos;
    for (let i = 0; i < 2 && p; i++) {
      p = nextPosition(this.book, p);
      if (!p) break;
      const s = getSentence(this.book, p);
      if (s?.text.trim()) engine.prefetch(s.text, voice.voiceId, voice.rate);
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
