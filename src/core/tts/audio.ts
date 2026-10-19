import type { TtsEngineId } from '@shared/settings';
import type { CloudTtsResult, WordTiming } from '@shared/api';
import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome } from './engine';
import { ENGINE_LABELS } from './engine';
import { estimateWordTimes } from './timing';
import { synthesisSegments, PRIORITY, type SynthesisSegment } from './segments';

type Synthesize = (engine: TtsEngineId, text: string, voiceId: string, rate: number) => Promise<CloudTtsResult>;
type ListVoices = (engine: TtsEngineId) => Promise<{ id: string; name: string; lang: string; gender?: string; quality?: string; note?: string }[]>;

/** an item of the main process's kokoro:prepare channel (src/main/kokoro/ipc.ts) */
export interface PrepareItem { text: string; voice?: string; speed?: number; priority?: number; wait?: boolean; replace?: boolean; release?: boolean }
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

/**
 * Engine for voices synthesized elsewhere (cloud providers or the local neural model), which return an
 * audio file plus optional word timings. Audio plays through an HTMLAudioElement so the speed slider can
 * change playbackRate live (pitch preserved; Web Audio buffers would change the pitch). Word highlights come
 * from the provider's timings when present, otherwise from a character-based estimate over the real audio
 * duration.
 *
 * Gaps between sentences: synthesized audio is cached (LRU) and the next sentence is fetched and pre-decoded (an
 * audio element loaded ahead of time) while the current one plays, so starting it is just play(). With `segment`,
 * a long sentence is requested as clause segments that play back to back; word timings are shifted to the
 * sentence's offsets, so the highlighter sees one sentence.
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
   */
  readAhead(texts: string[], voiceId: string, _rate: number): void {
    const gen = ++this.aheadGen;
    const next = texts[0];
    const prepare = this.opts.prepare;
    if (!prepare) {
      texts.slice(0, CLOUD_PREFETCH).forEach((t) => this.prefetch(t, voiceId, 1));
      if (next) this.predecode(next, voiceId, gen);
      return;
    }
    const items: PrepareItem[] = [{ text: '', replace: true }];
    texts.forEach((text, i) => { if (text.trim()) items.push({ text, voice: voiceId, speed: 1, priority: PRIORITY.ahead - (i + 1) }); });
    void prepare(items).catch(() => undefined);
    if (!next?.trim()) return;
    // ask to be told when the next sentence is ready rather than requesting it as 'now': an explanation the
    // learner is waiting for must not queue behind it
    prepare([{ text: next, voice: voiceId, speed: 1, priority: PRIORITY.next, wait: true }]).then((ok) => {
      if (ok !== false && gen === this.aheadGen) this.predecode(next, voiceId, gen);
    }).catch(() => undefined);
  }

  /** Playback paused or stopped: drop the read-ahead (local synthesis stops working for nothing). */
  stopReadAhead(): void {
    this.aheadGen++;
    void this.opts.prepare?.([{ text: '', replace: true }])?.catch(() => undefined);
  }

  /** Fetches every segment of `text` and loads an audio element for each, so speak() only has to call play(). */
  private predecode(text: string, voiceId: string, gen: number): void {
    for (const s of this.segmentsOf(text)) {
      const k = this.key(s.text, voiceId);
      if (this.preloaded.has(k)) continue;
      this.fetch(s.text, voiceId).then((res) => {
        if (gen !== this.aheadGen || this.preloaded.has(k)) return;
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
    let cleanup: (() => void) | null = null;
    const handle: SpeakHandle = { done, cancel: () => finish('cancelled') };
    const finish = (o: SpeakOutcome) => {
      if (finished) return;
      finished = true;
      this.pending.delete(handle);
      cleanup?.(); cleanup = null;
      if (this.current?.cancel === handle.cancel) this.current = null;
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
        raf = requestAnimationFrame(tick);
      };
      const end = (o: SpeakOutcome) => {
        if (over) return;
        over = true;
        cancelAnimationFrame(raf);
        audio.onplaying = audio.onended = audio.onerror = null;
        audio.pause(); audio.src = ''; URL.revokeObjectURL(url);
        segDone(o);
      };
      cleanup = () => end('cancelled');
      audio.onplaying = () => {
        if (!started) { started = true; this.lastStartDelayMs = performance.now() - t0; opts.onStart?.(); }
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      };
      audio.onended = () => {
        // words whose start the last frame did not reach are still announced, in order
        while (timings && nextWord < timings.length) { opts.onWord?.(timings[nextWord].charIndex, timings[nextWord].charLength); nextWord++; }
        end('ended');
      };
      audio.onerror = () => { handle.error = new Error('audio playback failed'); end('error'); };
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
