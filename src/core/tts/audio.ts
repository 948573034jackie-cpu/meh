import type { TtsEngineId } from '@shared/settings';
import type { CloudTtsResult, WordTiming } from '@shared/api';
import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome } from './engine';
import { ENGINE_LABELS } from './engine';
import { estimateWordTimes } from './timing';

type Synthesize = (engine: TtsEngineId, text: string, voiceId: string, rate: number) => Promise<CloudTtsResult>;
type ListVoices = (engine: TtsEngineId) => Promise<{ id: string; name: string; lang: string; gender?: string; quality?: string; note?: string }[]>;

/**
 * Engine for voices synthesized elsewhere (cloud providers or the local neural model), which return an
 * audio file plus optional word timings. Audio plays through an HTMLAudioElement so the speed slider can
 * change playbackRate live (pitch preserved). Word highlights come from the provider's timings when
 * present, otherwise from a character-based estimate over the real audio duration.
 * Synthesized sentences are cached (LRU) so prefetching the next sentence makes playback seamless.
 */
export class AudioTtsEngine implements TtsEngine {
  readonly kind = 'cloud' as const;
  readonly label: string;
  readonly costNote: string;
  readonly wordBoundaries: boolean;
  private cache = new Map<string, Promise<CloudTtsResult>>();
  private current: { audio: HTMLAudioElement; cancel: () => void } | null = null;
  private _paused = false;
  constructor(readonly id: TtsEngineId, private synthesize: Synthesize, private voices: ListVoices, wordBoundaries: boolean) {
    this.label = ENGINE_LABELS[id].label;
    this.costNote = ENGINE_LABELS[id].cost;
    this.wordBoundaries = wordBoundaries;
  }
  get paused(): boolean { return this._paused; }

  async listVoices(): Promise<TtsVoice[]> {
    return (await this.voices(this.id)).map((v) => ({ ...v, engine: this.id }));
  }

  private key(text: string, voiceId: string): string { return `${voiceId}\u0000${text}`; }

  private fetch(text: string, voiceId: string, rate: number): Promise<CloudTtsResult> {
    const k = this.key(text, voiceId);
    let p = this.cache.get(k);
    if (!p) {
      // audio is synthesized at rate 1 and sped up on playback so cached audio is reusable at any speed
      p = this.synthesize(this.id, text, voiceId, 1).catch((e) => { this.cache.delete(k); throw e; });
      this.cache.set(k, p);
      if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value as string);
    }
    void rate;
    return p;
  }

  prefetch(text: string, voiceId: string, rate: number): void { void this.fetch(text, voiceId, rate).catch(() => undefined); }

  speak(text: string, opts: SpeakOptions): SpeakHandle {
    let resolve!: (o: SpeakOutcome) => void;
    const done = new Promise<SpeakOutcome>((r) => { resolve = r; });
    let finished = false;
    let cleanup: (() => void) | null = null;
    const handle: SpeakHandle = { done, cancel: () => finish('cancelled') };
    const finish = (o: SpeakOutcome) => { if (finished) return; finished = true; cleanup?.(); if (this.current?.cancel === handle.cancel) this.current = null; resolve(o); };
    (async () => {
      let res: CloudTtsResult;
      try { res = await this.fetch(text, opts.voiceId, opts.rate); } catch (e) { handle.error = e as Error; finish('error'); return; }
      if (finished) return;
      const blob = new Blob([res.audio], { type: res.mime });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.preservesPitch = true;
      audio.playbackRate = Math.min(4, Math.max(0.25, opts.rate));
      let raf = 0;
      let timings: WordTiming[] | null = res.timings;
      let nextWord = 0;
      const tick = () => {
        if (finished) return;
        const t = audio.currentTime;
        if (!timings && Number.isFinite(audio.duration) && audio.duration > 0) {
          timings = estimateWordTimes(text, audio.duration).map((w) => ({ start: w.at, end: w.at, charIndex: w.charIndex, charLength: w.charLength }));
        }
        while (timings && nextWord < timings.length && timings[nextWord].start <= t) {
          opts.onWord?.(timings[nextWord].charIndex, timings[nextWord].charLength);
          nextWord++;
        }
        raf = requestAnimationFrame(tick);
      };
      cleanup = () => { cancelAnimationFrame(raf); audio.pause(); audio.src = ''; URL.revokeObjectURL(url); };
      audio.onplaying = () => { opts.onStart?.(); raf = requestAnimationFrame(tick); };
      audio.onended = () => finish('ended');
      audio.onerror = () => { handle.error = new Error('audio playback failed'); finish('error'); };
      this.current = { audio, cancel: handle.cancel };
      try { await audio.play(); } catch (e) { handle.error = e as Error; finish('error'); }
    })();
    return handle;
  }

  pause(): void { if (this.current) { this.current.audio.pause(); this._paused = true; } }
  resume(): void { if (this.current) void this.current.audio.play(); this._paused = false; }
  cancelAll(): void { this._paused = false; this.current?.cancel(); this.current = null; }
  setRate(rate: number): void { if (this.current) this.current.audio.playbackRate = Math.min(4, Math.max(0.25, rate)); }
}
