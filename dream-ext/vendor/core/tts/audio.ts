import type { TtsEngineId } from '@shared/settings';
import type { CloudTtsResult, WordTiming } from '@shared/api';
import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome, WordTime } from './engine';
import { ENGINE_LABELS } from './engine';
import { estimateWordTimes } from './timing';
import { synthesisSegments, PRIORITY, type SynthesisSegment } from './segments';
import { bakeVolume, bakeFailed, bakeOk, elementVolumeIgnored, speechOf } from './gain';

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
  /**
   * (YouTube side) cloud voices: how many of the read-ahead texts are fetched before they are needed (default
   * CLOUD_PREFETCH). The Speechify voice takes 1: only the very next sentence, so almost nothing is made that is not heard.
   */
  ahead?: number;
  /** (YouTube side) the name and cost note of an engine that is not in ENGINE_LABELS (the Speechify voice) */
  label?: string;
  costNote?: string;
}

/** cloud voices cost money per character: never fetch further ahead than this */
const CLOUD_PREFETCH = 2;
/** how the cloud voice's clips went (the 🩺 check and tests): made again at the learner's volume and played, that
 *  failed and the original played instead, sounds started in all */
export const voiceStats = { baked: 0, bakeFails: 0, started: 0 };
/** a clip made again at the learner's volume starts within this time, or the original plays instead */
const BAKED_START_MS = 2500;
/** decoded audio elements kept for upcoming segments */
const PRELOAD_MAX = 8;
/** the clip that just ended is kept this long: the same text said again at once (a word's repeats) is just play() */
const AGAIN_MS = 20_000;

/**
 * A clip ready to play: its audio element is loaded. `baked` = the volume put into its sound (an iPhone, gain.ts);
 * not set = the clip as the voice service made it. `vol` = the volume it was last played at.
 */
interface Loaded { audio: HTMLAudioElement; url: string; durationSec: number | null; baked?: number; bytes?: number; vol?: number }

/**
 * Engine for voices synthesized elsewhere (cloud providers or the local neural model), which return an
 * audio file plus optional word timings. Audio plays through an HTMLAudioElement so the speed slider can
 * change playbackRate live (pitch preserved; Web Audio buffers would change the pitch). Word highlights come
 * from the provider's timings when present, otherwise from a character-based estimate over the real audio
 * duration.
 *
 * Gaps between sentences: synthesized audio is cached (LRU) and the next sentence is fetched and pre-decoded (an
 * audio element loaded ahead of time) while the current one plays, so starting it is just play(). On an iPhone the
 * clip loaded ahead is already the one made at the learner's volume (gain.ts), and a clip that just ended is kept for
 * a moment, so a word said three times uses one audio element. With `segment`,
 * a long sentence is requested as clause segments that play back to back; word timings are shifted to the
 * sentence's offsets, so the highlighter sees one sentence.
 */
/**
 * The learner's volume for one audio element. An iPhone ignores `audio.volume` (it stays 1), so there the sound goes
 * through a gain instead; when that cannot sound right now, the element plays as it is (never silent).
 */
let gainCtx: AudioContext | null = null;
function setVolume(audio: HTMLAudioElement, volume: number): void {
  audio.volume = volume;
  if (volume >= 0.999 || Math.abs(audio.volume - volume) < 0.01) return;
  try {
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    gainCtx ??= new AC();
    if (gainCtx.state !== 'running') { void gainCtx.resume().catch(() => undefined); return; }
    const gain = gainCtx.createGain();
    gain.gain.value = volume;
    gainCtx.createMediaElementSource(audio).connect(gain).connect(gainCtx.destination);
  } catch { /* the element plays as it is */ }
}

export class AudioTtsEngine implements TtsEngine {
  readonly kind = 'cloud' as const;
  readonly label: string;
  readonly costNote: string;
  readonly wordBoundaries: boolean;
  private cache = new Map<string, Promise<CloudTtsResult>>();
  /** requests not answered yet (their cache entries are forgotten when the speech that wanted them is cancelled) */
  private unresolved = new Set<string>();
  /** audio elements already loaded for upcoming segments, by cache key */
  private preloaded = new Map<string, Loaded>();
  /** clips being made ready now, by cache key (the same clip is not made twice) */
  private making = new Set<string>();
  /** the clip that just played to its end, kept for AGAIN_MS */
  private again: { k: string; clip: Loaded; timer: ReturnType<typeof setTimeout> } | null = null;
  /** the volume of the last speak(): clips loaded ahead are made at it, unless the caller names another */
  private lastVolume: number | null = null;
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
  /** the last clip whose volume was put into its sound (an iPhone): the volume and the size (diagnostics and tests) */
  lastBaked: { volume: number; bytes: number } | null = null;
  /** clips made again at the learner's volume that would not play (the original played instead) */
  bakeFails = 0;
  private opts: AudioEngineOptions;

  constructor(readonly id: TtsEngineId, private synthesize: Synthesize, private voices: ListVoices, wordBoundaries: boolean, opts: AudioEngineOptions = {}) {
    this.label = opts.label ?? ENGINE_LABELS[id]?.label ?? String(id);
    this.costNote = opts.costNote ?? ENGINE_LABELS[id]?.cost ?? '';
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

  /** asks for the sound of `text` (nothing is loaded or played) */
  private warm(text: string, voiceId: string): void {
    for (const s of this.segmentsOf(text)) void this.fetch(s.text, voiceId).catch(() => undefined);
  }

  /** the volume a clip made ahead will be played at: the caller's, else the last one spoken at */
  private aheadVolume(volume?: number): number | null { return volume === undefined ? this.lastVolume : Math.max(0, Math.min(1, volume)); }

  /**
   * One text made ready ahead without playing it: fetched, its audio element loaded, and on an iPhone already made at
   * the learner's volume, so that speak() of the same text is just play(). (A local synthesis queue only gets the request.)
   */
  prefetch(text: string, voiceId: string, _rate: number, volume?: number): void {
    this.warm(text, voiceId);
    if (!this.opts.prepare) this.predecode(text, voiceId, null, this.aheadVolume(volume));
  }

  /**
   * The sentences after the one being spoken, nearest first. The next one is fetched and pre-decoded as soon as
   * possible. Local synthesis (prepare): all of them go to the main process's read-ahead queue (replacing the
   * previous list), the next one at 'next' priority. Cloud voices: only the next two are fetched (they cost money).
   */
  readAhead(texts: string[], voiceId: string, _rate: number, volume?: number): void {
    const gen = ++this.aheadGen;
    const next = texts[0];
    const prepare = this.opts.prepare;
    const vol = this.aheadVolume(volume);
    if (!prepare) {
      const ahead = Math.max(0, this.opts.ahead ?? CLOUD_PREFETCH);
      texts.slice(0, ahead).forEach((t) => this.warm(t, voiceId));
      if (next && ahead > 0) this.predecode(next, voiceId, gen, vol);
      return;
    }
    const items: PrepareItem[] = [{ text: '', replace: true }];
    texts.forEach((text, i) => { if (text.trim()) items.push({ text, voice: voiceId, speed: 1, priority: PRIORITY.ahead - (i + 1) }); });
    void prepare(items).catch(() => undefined);
    if (!next?.trim()) return;
    // ask to be told when the next sentence is ready rather than requesting it as 'now': an explanation the
    // learner is waiting for must not queue behind it
    prepare([{ text: next, voice: voiceId, speed: 1, priority: PRIORITY.next, wait: true }]).then((ok) => {
      if (ok !== false && gen === this.aheadGen) this.predecode(next, voiceId, gen, vol);
    }).catch(() => undefined);
  }

  /** Playback paused or stopped: drop the read-ahead (local synthesis stops working for nothing). */
  stopReadAhead(): void {
    this.aheadGen++;
    void this.opts.prepare?.([{ text: '', replace: true }])?.catch(() => undefined);
  }

  /**
   * Fetches every segment of `text` and loads an audio element for each, so speak() only has to call play(). `gen`:
   * the read-ahead this belongs to (a newer one drops it); null = asked for by prefetch(), it stays. `volume`: the
   * volume it will be played at (an iPhone: the clip is made at it now, not when it should start).
   */
  private predecode(text: string, voiceId: string, gen: number | null, volume: number | null): void {
    const stale = () => gen !== null && gen !== this.aheadGen;
    for (const s of this.segmentsOf(text)) {
      const k = this.key(s.text, voiceId);
      if (this.preloaded.has(k) || this.making.has(k)) continue;
      this.making.add(k);
      this.fetch(s.text, voiceId).then((res) => (stale() || this.preloaded.has(k) ? null : this.ready(k, res, volume))).then((clip) => {
        this.making.delete(k);
        if (!clip) return;
        if (stale() || this.preloaded.has(k)) { this.drop(clip); return; }
        this.keep(k, clip);
      }).catch(() => { this.making.delete(k); });
    }
  }

  /** a clip loaded for later; the oldest go when there are too many */
  private keep(k: string, clip: Loaded): void {
    this.preloaded.set(k, clip);
    while (this.preloaded.size > PRELOAD_MAX) {
      const oldest = this.preloaded.keys().next().value as string;
      const p = this.preloaded.get(oldest)!;
      this.preloaded.delete(oldest);
      this.drop(p);
    }
  }

  /** a loaded clip that is not needed any more */
  private drop(clip: Loaded): void {
    try { clip.audio.pause(); clip.audio.src = ''; } catch { /* already gone */ }
    URL.revokeObjectURL(clip.url);
  }

  /** the clip that just played to its end, back at its start and kept for AGAIN_MS */
  private keepAgain(k: string, clip: Loaded): void {
    this.dropAgain();
    try { clip.audio.currentTime = 0; } catch { this.drop(clip); return; }
    const timer = setTimeout(() => { if (this.again?.clip === clip) this.dropAgain(); }, AGAIN_MS);
    this.again = { k, clip, timer };
  }

  private dropAgain(): void {
    const a = this.again;
    if (!a) return;
    this.again = null;
    clearTimeout(a.timer);
    this.drop(a.clip);
  }

  private element(blob: Blob): { audio: HTMLAudioElement; url: string } {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.preservesPitch = true;
    audio.load?.();
    return { audio, url };
  }

  private load(res: CloudTtsResult): Loaded {
    return { ...this.element(new Blob([res.audio], { type: res.mime })), durationSec: res.durationSec };
  }

  /**
   * The clip loaded for playing at `volume`: where the element's own volume is ignored (an iPhone) and the volume is
   * below full, the clip made again with the volume in its sound; else (or when that cannot be made) the clip as it is.
   */
  private async ready(k: string, res: CloudTtsResult, volume: number | null): Promise<Loaded> {
    if (volume !== null && volume < 0.999 && elementVolumeIgnored()) {
      const blob = await bakeVolume(res.audio, volume, k);
      if (blob) return { ...this.element(blob), durationSec: res.durationSec, baked: volume, bytes: blob.size };
    }
    return this.load(res);
  }

  speak(text: string, opts: SpeakOptions): SpeakHandle {
    let resolve!: (o: SpeakOutcome) => void;
    const done = new Promise<SpeakOutcome>((r) => { resolve = r; });
    let finished = false;
    let cleanup: (() => void) | null = null;
    /** the clip of this speech that is loaded or playing now (for clock()) */
    let live: { audio: HTMLAudioElement; k: string } | null = null;
    const handle: SpeakHandle = {
      done, cancel: () => finish('cancelled'),
      clock: () => {
        const d = live?.audio.duration;
        if (!live || d === undefined || !Number.isFinite(d) || d <= 0) return null;
        return { t: live.audio.currentTime, d, ...(speechOf(live.k) ?? {}) };
      },
    };
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
    const volume = Math.max(0, Math.min(1, opts.volume ?? 1));
    this.lastVolume = volume;
    const t0 = performance.now();
    const segs = this.segmentsOf(text);
    // every segment is requested now, in order: the main process synthesizes them one after the other
    const results = segs.map((s) => { const p = this.fetch(s.text, opts.voiceId); p.catch(() => undefined); return p; });
    // the service's own word times (ElevenLabs), at this text's offsets; a text said in several pieces has none
    handle.words = segs.length === 1
      ? results[0].then((r): WordTime[] | null => {
        const offset = segs[0].start + (segs[0].text.length - segs[0].text.trimStart().length);
        return r.timings?.length ? r.timings.map((w) => lettersOf(text, w.start, w.end, w.charIndex + offset, w.charIndex + w.charLength + offset)).filter((w): w is WordTime => !!w) : null;
      }, () => null)
      : Promise.resolve(null);
    let started = false;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const playSegment = (seg: SynthesisSegment, res: CloudTtsResult): Promise<SpeakOutcome> => new Promise<SpeakOutcome>((segDone) => {
      const k = this.key(seg.text, opts.voiceId);
      // an iPhone ignores the element's volume: there the clip is made again with the volume in its sound (gain.ts);
      // when that cannot be done the clip plays as it is, through the gain when that works (never silent)
      const bake = volume < 0.999 && elementVolumeIgnored();
      // loaded ahead (readAhead / prefetch), or the clip that just ended (the same text again: a word's repeats)
      let ready = this.preloaded.get(k);
      if (ready) this.preloaded.delete(k);
      else if (this.again?.k === k && Math.abs((this.again.clip.vol ?? -1) - volume) < 0.001) { ready = this.again.clip; clearTimeout(this.again.timer); this.again = null; }
      // (another text now: the clip kept for a repeat is not needed)
      this.dropAgain();
      // (made at another volume, the slider moved; or made again where that is not wanted any more: not this one)
      if (ready && ready.baked !== undefined && (!bake || Math.abs(ready.baked - volume) > 0.001)) { this.drop(ready); ready = undefined; }
      if (bake) {
        // the clip as the voice service made it (when the new one cannot be made, or will not play)
        const plain = () => { const src = ready && ready.baked === undefined ? ready : this.load(res); ready = undefined; run(src, false); };
        const failed = () => { bakeFailed(); this.lastBaked = null; this.bakeFails++; voiceStats.bakeFails++; plain(); };
        // made ahead at this volume: starting it is just play()
        if (ready && ready.baked !== undefined) {
          const clip = ready;
          ready = undefined;
          this.lastBaked = { volume, bytes: clip.bytes ?? 0 };
          run(clip, true, failed);
          return;
        }
        let dropped = false;
        cleanup = () => { dropped = true; if (ready) this.drop(ready); segDone('cancelled'); };
        void bakeVolume(res.audio, volume, k).then((blob) => {
          if (dropped) return;
          cleanup = null;
          if (!blob) { plain(); return; }
          const clip: Loaded = { ...this.element(blob), durationSec: res.durationSec, baked: volume, bytes: blob.size };
          this.lastBaked = { volume, bytes: blob.size };
          // (it plays: the clip loaded ahead is not needed any more)
          const old = ready;
          if (old) clip.audio.addEventListener('playing', () => { if (ready === old) ready = undefined; this.drop(old); }, { once: true });
          run(clip, true, failed);
        });
        return;
      }
      run(ready ?? this.load(res), false);

      /** `orElse` (a clip made again at the learner's volume): should it not start, or fail, the original plays instead */
      function run(this: void, clip: Loaded, isBaked: boolean, orElse?: () => void): void {
      const { audio, url } = clip;
      live = { audio, k };
      let startWatch: ReturnType<typeof setTimeout> | null = null;
      let swapped = false;
      const swap = (): boolean => {
        if (!orElse || swapped || over || started0) return false;
        swapped = true; over = true;
        if (startWatch) clearTimeout(startWatch);
        cancelAnimationFrame(raf);
        audio.onplaying = audio.onended = audio.onerror = null;
        audio.pause(); audio.src = ''; URL.revokeObjectURL(url);
        if (live?.audio === audio) live = null;
        cleanup = null;
        orElse();
        return true;
      };
      let started0 = false;
      audio.playbackRate = clampRate(self.liveRate);
      if (!isBaked) setVolume(audio, volume);
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
        if (startWatch) { clearTimeout(startWatch); startWatch = null; }
        cancelAnimationFrame(raf);
        audio.onplaying = audio.onended = audio.onerror = null;
        if (live?.audio === audio) live = null;
        // played to its end: kept for a moment, so the same text said again at once is just play() on this element
        if (o === 'ended') self.keepAgain(k, { ...clip, vol: volume });
        else { audio.pause(); audio.src = ''; URL.revokeObjectURL(url); }
        segDone(o);
      };
      cleanup = () => end('cancelled');
      audio.onplaying = () => {
        if (!started0) { voiceStats.started++; if (isBaked) { voiceStats.baked++; bakeOk(); } }
        started0 = true;
        if (startWatch) { clearTimeout(startWatch); startWatch = null; }
        if (!started) { started = true; self.lastStartDelayMs = performance.now() - t0; opts.onStart?.(); }
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      };
      audio.onended = () => {
        // words whose start the last frame did not reach are still announced, in order
        while (timings && nextWord < timings.length) { opts.onWord?.(timings[nextWord].charIndex, timings[nextWord].charLength); nextWord++; }
        end('ended');
      };
      audio.onerror = () => { if (swap()) return; handle.error = new Error('audio playback failed'); end('error'); };
      self.current = { audio, cancel: handle.cancel };
      if (orElse) startWatch = setTimeout(() => { startWatch = null; if (!self._paused) swap(); }, BAKED_START_MS);
      audio.play().catch((e: Error) => { if (swap()) return; if (!over) { handle.error = e; end('error'); } });
      }
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
          if (!this.making.has(nk)) results[i + 1].then((r) => (finished || this.preloaded.has(nk) ? null : this.ready(nk, r, volume))).then((c) => { if (!c) return; if (finished || this.preloaded.has(nk)) this.drop(c); else this.preloaded.set(nk, c); }).catch(() => undefined);
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

/**
 * One timed word at its letters: a sound kept from before may count the quotation mark or comma beside a word as
 * part of it (“Hello,”); the line goes under the letters only. null = no letter or digit in it (a dash on its own).
 */
function lettersOf(text: string, start: number, end: number, from: number, to: number): WordTime | null {
  const letter = /[\p{L}\p{N}]/u;
  let a = Math.max(0, from), b = Math.min(text.length, to);
  while (a < b && !letter.test(text[a])) a++;
  while (b > a && !letter.test(text[b - 1])) b--;
  return b > a ? { start, end, charStart: a, charEnd: b } : null;
}
