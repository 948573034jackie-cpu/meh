import type { TtsEngineId } from '@shared/settings';
import type { CloudTtsResult, WordTiming } from '@shared/api';
import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome, PrepareHandle } from './engine';
import { ENGINE_LABELS } from './engine';
import { estimateWordTimes } from './timing';
import { synthesisSegments, pauseAfter, PRIORITY, type SynthesisSegment } from './segments';

type Synthesize = (engine: TtsEngineId, text: string, voiceId: string, rate: number) => Promise<CloudTtsResult>;
type ListVoices = (engine: TtsEngineId) => Promise<{ id: string; name: string; lang: string; gender?: string; quality?: string; note?: string }[]>;

/** an item of the main process's kokoro:prepare channel (src/main/kokoro/ipc.ts) */
export interface PrepareItem { text: string; voice?: string; speed?: number; priority?: number; wait?: boolean; replace?: boolean; release?: boolean; drop?: string[] }
/** kokoro:prepare; with `wait` items it resolves true when they are ready, false when they were dropped */
export type Prepare = (items: PrepareItem[]) => Promise<unknown>;

export interface AudioEngineOptions {
  /**
   * Local synthesis queue (Kokoro): read-ahead goes to the main process's priority queue instead of being
   * fetched here, and the next sentence is fetched once the main process reports it ready.
   */
  prepare?: Prepare;
  /** speak long texts as clause segments played back to back (synthesisSegments), so the first one starts sooner */
  segment?: boolean;
}

/** cloud voices cost money per character: never fetch further ahead than this */
const CLOUD_PREFETCH = 2;
/** decoded audio elements kept for upcoming segments */
const PRELOAD_MAX = 8;
/** a speak() cancelled with `fade` ramps its volume down over this many ms (in FADE_STEP_MS steps) before it stops */
const FADE_MS = 25;
const FADE_STEP_MS = 5;
/**
 * a hidden page gets no animation frames: the word highlights (and the stop at a hard word, which waits for its word)
 * are then polled this often instead of all coming at the end of the clip
 */
const WORD_TICK_HIDDEN_MS = 50;

function pageHidden(): boolean { return typeof document !== 'undefined' && document.visibilityState === 'hidden'; }

/**
 * Engine for voices synthesized elsewhere (cloud providers or the local neural model), which return an
 * audio file plus optional word timings. Audio plays through an HTMLAudioElement so the speed slider can
 * change playbackRate live (pitch preserved; Web Audio buffers would change the pitch). Word highlights come
 * from the provider's timings when present, otherwise from a character-based estimate over the real audio
 * duration. They are checked every animation frame, and every WORD_TICK_HIDDEN_MS while the page is hidden (no
 * frames then), so a Listening stop still cuts at its word behind another window.
 *
 * Gaps between sentences: synthesized audio is cached (LRU) and the next sentence is fetched and pre-decoded (an
 * audio element loaded ahead of time) while the current one plays, so starting it is just play(). With `segment`,
 * a long sentence is requested as clause segments that play back to back; word timings are shifted to the
 * sentence's offsets, so the highlighter sees one sentence. A segment whose result names its end punctuation (the
 * local voice, whose audio is trimmed to the speech) is followed by the pause that punctuation asks for
 * (SEGMENT_PAUSE_MS); other voices keep the silence they synthesized.
 */
export class AudioTtsEngine implements TtsEngine {
  readonly kind = 'cloud' as const;
  readonly label: string;
  readonly costNote: string;
  readonly wordBoundaries: boolean;
  private cache = new Map<string, Promise<CloudTtsResult>>();
  /** requests not answered yet (their cache entries are forgotten when the speech that wanted them is cancelled) */
  private unresolved = new Set<string>();
  /** audio elements already loaded for upcoming segments, by cache key */
  private preloaded = new Map<string, { audio: HTMLAudioElement; url: string; durationSec: number | null }>();
  private current: { audio: HTMLAudioElement; cancel: () => void } | null = null;
  /** every unfinished speak(), including those still waiting for synthesis */
  private pending = new Set<SpeakHandle>();
  private _paused = false;
  private resumeWaiters: (() => void)[] = [];
  private liveRate = 1;
  /** bumped by stopReadAhead()/readAhead(): a read-ahead chain from before stops */
  private aheadGen = 0;
  /** ms from speak() to the audio playing, for the last speak() (diagnostics and tests) */
  lastStartDelayMs: number | null = null;
  private opts: AudioEngineOptions;

  constructor(readonly id: TtsEngineId, private synthesize: Synthesize, private voices: ListVoices, wordBoundaries: boolean, opts: AudioEngineOptions = {}) {
    this.label = ENGINE_LABELS[id].label;
    this.costNote = ENGINE_LABELS[id].cost;
    this.wordBoundaries = wordBoundaries;
    this.opts = opts;
  }
  get paused(): boolean { return this._paused; }

  async listVoices(): Promise<TtsVoice[]> {
    return (await this.voices(this.id)).map((v) => ({ ...v, engine: this.id }));
  }

  private key(text: string, voiceId: string): string { return `${voiceId}\u0000${text}`; }

  private segmentsOf(text: string): SynthesisSegment[] { return this.opts.segment ? synthesisSegments(text) : [{ text, start: 0 }]; }

  private fetch(text: string, voiceId: string): Promise<CloudTtsResult> {
    const k = this.key(text, voiceId);
    let p = this.cache.get(k);
    if (!p) {
      // audio is synthesized at rate 1 and sped up on playback so cached audio is reusable at any speed
      const req: Promise<CloudTtsResult> = this.synthesize(this.id, text, voiceId, 1).then(
        (r) => { this.unresolved.delete(k); return r; },
        (e) => { this.unresolved.delete(k); if (this.cache.get(k) === req) this.cache.delete(k); throw e; },
      );
      p = req;
      this.cache.set(k, p);
      this.unresolved.add(k);
      while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value as string);
    } else { this.cache.delete(k); this.cache.set(k, p); }
    return p;
  }

  prefetch(text: string, voiceId: string, _rate: number): void {
    for (const s of this.segmentsOf(text)) void this.fetch(s.text, voiceId).catch(() => undefined);
  }

  /**
   * The sentences after the one being spoken, nearest first. The next one is fetched and pre-decoded as soon as
   * possible. Local synthesis (prepare): all of them go to the main process's read-ahead queue (replacing the
   * previous list), the next one at 'next' priority. Cloud voices: only the next two are fetched (they cost money).
   * `urgent` (the hard word a Listening stop will say 3 times): local synthesis asks for it at 'soon' priority with
   * `wait` in the same call that replaces the list (a separate call would be dropped by that replace), so it is
   * synthesized before the read-ahead; it is pre-decoded once ready. Cloud voices fetch it at once (a few characters).
   * `upcoming` (the hard words of the next sentence): local synthesis only, at 'nextWords' priority, right after the
   * next sentence; when that sentence starts they come again as `urgent` and are found ready.
   */
  readAhead(texts: string[], voiceId: string, _rate: number, urgent: string[] = [], upcoming: string[] = []): void {
    const gen = ++this.aheadGen;
    const alive = () => gen === this.aheadGen;
    const next = texts[0];
    const words = [...new Set(urgent.filter((t) => t.trim()))];
    const later = [...new Set(upcoming.filter((t) => t.trim() && !words.includes(t)))];
    const prepare = this.opts.prepare;
    if (!prepare) {
      for (const w of words) this.predecode(w, voiceId, alive);
      texts.slice(0, CLOUD_PREFETCH).forEach((t) => this.prefetch(t, voiceId, 1));
      if (next) this.predecode(next, voiceId, alive);
      return;
    }
    const items: PrepareItem[] = [{ text: '', replace: true }];
    texts.forEach((text, i) => { if (text.trim()) items.push({ text, voice: voiceId, speed: 1, priority: PRIORITY.ahead - (i + 1) }); });
    for (const text of later) items.push({ text, voice: voiceId, speed: 1, priority: PRIORITY.nextWords });
    for (const text of words) items.push({ text, voice: voiceId, speed: 1, priority: PRIORITY.soon, wait: true });
    prepare(items).then((ok) => {
      // resolves once the urgent items are synthesized (false: dropped meanwhile, a pause or a seek)
      if (words.length && ok !== false && alive()) for (const w of words) this.predecode(w, voiceId, alive);
    }).catch(() => undefined);
    if (!next?.trim()) return;
    // ask to be told when the next sentence is ready rather than requesting it as 'now': an explanation the
    // learner is waiting for must not queue behind it
    prepare([{ text: next, voice: voiceId, speed: 1, priority: PRIORITY.next, wait: true }]).then((ok) => {
      if (ok !== false && gen === this.aheadGen) this.predecode(next, voiceId, () => gen === this.aheadGen);
    }).catch(() => undefined);
  }

  /**
   * An explanation the learner will hear in a few seconds. Local synthesis (Kokoro): every text goes to the main
   * process's queue at 'soon' priority (after any speak() waiting now, before the book's next sentence and read-ahead)
   * and is pre-decoded once it is ready, so its speak() only has to play(). Cloud voices cost money per character and
   * the explanation may still be dropped: only the first two are fetched. release() (the explanation was dropped)
   * removes the queued jobs (a running one finishes) and frees the audio loaded for them.
   *
   * Invariant (main process): a read-ahead `replace` (pause, stop, the next sentence list) also drops these jobs while
   * no speak() waits for them. During a Listening stop the reading loop sends none (it waits in onStop), so they
   * survive; anything that has to survive a `replace` must go into the same kokoro:prepare call.
   */
  prepareSoon(texts: string[], voiceId: string): PrepareHandle {
    const list = texts.filter((t) => t.trim());
    let released = false;
    const alive = () => !released;
    const prepare = this.opts.prepare;
    if (prepare) {
      for (const text of list) {
        prepare([{ text, voice: voiceId, speed: 1, priority: PRIORITY.soon, wait: true }]).then((ok) => {
          if (ok !== false && alive()) this.predecode(text, voiceId, alive);
        }).catch(() => undefined);
      }
    } else {
      for (const text of list.slice(0, CLOUD_PREFETCH)) this.predecode(text, voiceId, alive);
    }
    return {
      release: () => {
        if (released) return;
        released = true;
        if (prepare && list.length) void prepare([{ text: '', voice: voiceId, speed: 1, drop: list }]).catch(() => undefined);
        for (const text of list) {
          for (const s of this.segmentsOf(text)) {
            const k = this.key(s.text, voiceId);
            const p = this.preloaded.get(k);
            if (p) { this.preloaded.delete(k); URL.revokeObjectURL(p.url); }
            // a request nobody will play: forgotten, so a later speak() asks again rather than waiting for a dropped job
            if (this.unresolved.has(k)) { this.unresolved.delete(k); this.cache.delete(k); }
          }
        }
      },
    };
  }

  /**
   * A speak() was cut: its segments still being synthesized are forgotten here, and the local queue is told that nobody
   * waits for them any more (they drop to read-ahead; held jobs such as the stop word keep their place).
   */
  private releaseUnplayed(segs: SynthesisSegment[], voiceId: string): void {
    let any = false;
    for (const s of segs) {
      const k = this.key(s.text, voiceId);
      if (this.unresolved.has(k)) { this.unresolved.delete(k); this.cache.delete(k); any = true; }
    }
    if (any) void this.opts.prepare?.([{ text: '', release: true }])?.catch(() => undefined);
  }

  /** Playback paused or stopped: drop the read-ahead (local synthesis stops working for nothing). */
  stopReadAhead(): void {
    this.aheadGen++;
    void this.opts.prepare?.([{ text: '', replace: true }])?.catch(() => undefined);
  }

  /**
   * Fetches every segment of `text` and loads an audio element for each, so speak() only has to call play(). `alive`
   * = still wanted when the audio arrives (the read-ahead list was not replaced, the explanation was not dropped).
   */
  private predecode(text: string, voiceId: string, alive: () => boolean): void {
    for (const s of this.segmentsOf(text)) {
      const k = this.key(s.text, voiceId);
      if (this.preloaded.has(k)) continue;
      this.fetch(s.text, voiceId).then((res) => {
        if (!alive() || this.preloaded.has(k)) return;
        this.preloaded.set(k, this.load(res));
        while (this.preloaded.size > PRELOAD_MAX) {
          const oldest = this.preloaded.keys().next().value as string;
          const p = this.preloaded.get(oldest)!;
          this.preloaded.delete(oldest);
          URL.revokeObjectURL(p.url);
        }
      }).catch(() => undefined);
    }
  }

  private load(res: CloudTtsResult): { audio: HTMLAudioElement; url: string; durationSec: number | null } {
    const url = URL.createObjectURL(new Blob([res.audio], { type: res.mime }));
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.preservesPitch = true;
    audio.load?.();
    return { audio, url, durationSec: res.durationSec };
  }

  speak(text: string, opts: SpeakOptions): SpeakHandle {
    let resolve!: (o: SpeakOutcome) => void;
    const done = new Promise<SpeakOutcome>((r) => { resolve = r; });
    let finished = false;
    /** stops what runs now: the segment playing (`fade`: ramped down) or the pause between two segments */
    let cleanup: ((fade?: boolean) => void) | null = null;
    const handle: SpeakHandle = { done, cancel: (o) => finish('cancelled', o?.fade === true) };
    const finish = (o: SpeakOutcome, fade = false) => {
      if (finished) return;
      finished = true;
      this.pending.delete(handle);
      cleanup?.(fade); cleanup = null;
      if (this.current?.cancel === handle.cancel) this.current = null;
      // the stop at a hard word cuts the sentence without a cancelAll(): its segments not synthesized yet are not needed
      // now (the re-read after the stop asks again), so the local queue must not keep them before the stop word and the
      // explanation (they wait at 'now' for this speak() otherwise)
      if (fade) this.releaseUnplayed(segs, opts.voiceId);
      resolve(o);
    };
    this.pending.add(handle);
    this.liveRate = opts.rate;
    const t0 = performance.now();
    const segs = this.segmentsOf(text);
    // every segment is requested now, in order: the main process synthesizes them one after the other
    const results = segs.map((s) => { const p = this.fetch(s.text, opts.voiceId); p.catch(() => undefined); return p; });
    let started = false;
    const playSegment = (seg: SynthesisSegment, res: CloudTtsResult): Promise<SpeakOutcome> => new Promise<SpeakOutcome>((segDone) => {
      const k = this.key(seg.text, opts.voiceId);
      const ready = this.preloaded.get(k);
      if (ready) this.preloaded.delete(k);
      const { audio, url } = ready ?? this.load(res);
      audio.playbackRate = clampRate(this.liveRate);
      // provider timings index the text it synthesized (trimmed by the main process); shift them to this text
      const offset = seg.start + (seg.text.length - seg.text.trimStart().length);
      let timings: WordTiming[] | null = res.timings?.length ? res.timings.map((w) => ({ ...w, charIndex: w.charIndex + offset })) : null;
      let nextWord = 0;
      let raf = 0;
      let hiddenTick: ReturnType<typeof setInterval> | null = null;
      let playing = false;
      let over = false;
      const tick = () => {
        if (over) return;
        const t = audio.currentTime;
        if (!timings && Number.isFinite(audio.duration) && audio.duration > 0) {
          timings = estimateWordTimes(seg.text, audio.duration).map((w) => ({ start: w.at, end: w.at, charIndex: w.charIndex + seg.start, charLength: w.charLength }));
        }
        while (timings && nextWord < timings.length && timings[nextWord].start <= t) {
          opts.onWord?.(timings[nextWord].charIndex, timings[nextWord].charLength);
          nextWord++;
        }
      };
      const frame = () => { if (over) return; tick(); raf = requestAnimationFrame(frame); };
      // hidden page: the frames stop (and resume by themselves when it shows again), a timer ticks meanwhile
      const onVisibility = () => {
        if (over || !playing) return;
        if (pageHidden()) { if (hiddenTick === null) hiddenTick = setInterval(tick, WORD_TICK_HIDDEN_MS); }
        else if (hiddenTick !== null) { clearInterval(hiddenTick); hiddenTick = null; }
      };
      const end = (o: SpeakOutcome, fade = false) => {
        if (over) return;
        over = true;
        cancelAnimationFrame(raf);
        if (hiddenTick !== null) { clearInterval(hiddenTick); hiddenTick = null; }
        if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisibility);
        audio.onplaying = audio.onended = audio.onerror = null;
        const release = () => { audio.pause(); audio.src = ''; URL.revokeObjectURL(url); };
        // the stop at a hard word: a short fade instead of a click (the outcome is reported at once)
        if (fade && !audio.paused) fadeOut(audio, release); else release();
        segDone(o);
      };
      cleanup = (fade) => end('cancelled', fade);
      audio.onplaying = () => {
        if (!started) { started = true; this.lastStartDelayMs = performance.now() - t0; opts.onStart?.(); }
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(frame);
        playing = true;
        onVisibility();
      };
      audio.onended = () => {
        // words whose start the last frame did not reach are still announced, in order
        while (timings && nextWord < timings.length) { opts.onWord?.(timings[nextWord].charIndex, timings[nextWord].charLength); nextWord++; }
        end('ended');
      };
      audio.onerror = () => { handle.error = new Error('audio playback failed'); end('error'); };
      if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisibility);
      this.current = { audio, cancel: handle.cancel };
      audio.play().catch((e: Error) => { if (!over) { handle.error = e; end('error'); } });
    });

    (async () => {
      for (let i = 0; i < segs.length; i++) {
        let res: CloudTtsResult;
        try { res = await results[i]; } catch (e) { handle.error = e as Error; finish('error'); return; }
        if (finished) return;
        if (this._paused) await new Promise<void>((r) => this.resumeWaiters.push(r));
        if (finished) return;
        // load the following segment while this one plays
        if (i + 1 < segs.length) {
          const nk = this.key(segs[i + 1].text, opts.voiceId);
          results[i + 1].then((r) => { if (!finished && !this.preloaded.has(nk)) this.preloaded.set(nk, this.load(r)); }).catch(() => undefined);
        }
        const o = await playSegment(segs[i], res);
        if (o !== 'ended') { finish(o); return; }
        // the pause after a clause or sentence inside the text (trimmed local audio); the next segment, requested at
        // the start, is synthesized meanwhile
        const gap = i + 1 < segs.length ? pauseAfter(res.endPunct) : 0;
        if (gap > 0) {
          await new Promise<void>((r) => { const t = setTimeout(() => { cleanup = null; r(); }, gap); cleanup = () => { clearTimeout(t); r(); }; });
          if (finished) return;
        }
      }
      finish('ended');
    })();
    return handle;
  }

  pause(): void { if (this.current) { this.current.audio.pause(); } this._paused = true; }
  resume(): void {
    if (this.current) this.current.audio.play().catch(() => undefined);
    this._paused = false;
    const w = this.resumeWaiters; this.resumeWaiters = [];
    w.forEach((r) => r());
  }
  cancelAll(): void {
    this._paused = false;
    const w = this.resumeWaiters; this.resumeWaiters = [];
    w.forEach((r) => r());
    for (const h of [...this.pending]) h.cancel();
    this.current = null;
    // requests nobody waits for any more: forget them here and tell the local queue they are no longer urgent
    for (const k of this.unresolved) this.cache.delete(k);
    this.unresolved.clear();
    void this.opts.prepare?.([{ text: '', release: true }])?.catch(() => undefined);
  }
  setRate(rate: number): void { this.liveRate = rate; if (this.current) this.current.audio.playbackRate = clampRate(rate); }
}

function clampRate(rate: number): number { return Math.min(4, Math.max(0.25, rate)); }

/** Ramps the element's volume to 0 over FADE_MS, then `done` (it stops and frees the element). */
function fadeOut(audio: HTMLAudioElement, done: () => void): void {
  const steps = Math.max(1, Math.round(FADE_MS / FADE_STEP_MS));
  const from = audio.volume ?? 1;
  let i = 0;
  const step = () => {
    i++;
    try { audio.volume = Math.max(0, from * (1 - i / steps)); } catch { /* volume not settable: stop at once */ i = steps; }
    if (i >= steps) done(); else setTimeout(step, FADE_STEP_MS);
  };
  setTimeout(step, FADE_STEP_MS);
}
