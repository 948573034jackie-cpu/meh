import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome } from './engine';
import { estimateWordTimes } from './timing';

/**
 * Deterministic engine for tests and for CI machines without voices: "speaks" by emitting word
 * boundaries on a timer. `msPerChar` controls speed (0 makes everything finish on the next tick).
 */
export class FakeTtsEngine implements TtsEngine {
  readonly id = 'webspeech' as const;
  readonly label = 'Fake voice (testing)';
  readonly kind = 'local' as const;
  readonly costNote = 'Free';
  readonly wordBoundaries = true;
  spoken: { text: string; rate: number; voiceId: string }[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private active: SpeakHandle[] = [];
  private _paused = false;
  constructor(public msPerChar = 4) {}
  get paused(): boolean { return this._paused; }
  async listVoices(): Promise<TtsVoice[]> {
    return [{ id: 'fake-gb', name: 'Fake Daniel', lang: 'en-GB', engine: 'webspeech' }, { id: 'fake-zh', name: 'Fake Tingting', lang: 'zh-CN', engine: 'webspeech' }];
  }
  speak(text: string, opts: SpeakOptions): SpeakHandle {
    this.spoken.push({ text, rate: opts.rate, voiceId: opts.voiceId });
    let resolve!: (o: SpeakOutcome) => void;
    const done = new Promise<SpeakOutcome>((r) => { resolve = r; });
    const timers: ReturnType<typeof setTimeout>[] = [];
    let finished = false;
    const finish = (o: SpeakOutcome) => { if (finished) return; finished = true; timers.forEach((t) => { clearTimeout(t); this.timers.delete(t); }); this.active = this.active.filter((h) => h !== handle); resolve(o); };
    const handle: SpeakHandle = { done, cancel: () => finish('cancelled') };
    const durationMs = Math.max(1, text.length * this.msPerChar / Math.max(0.1, opts.rate));
    const words = estimateWordTimes(text, durationMs / 1000);
    const at = (ms: number, fn: () => void) => { const t = setTimeout(() => { this.timers.delete(t); if (!finished) fn(); }, ms); timers.push(t); this.timers.add(t); };
    at(0, () => opts.onStart?.());
    for (const w of words) at(w.at * 1000, () => opts.onWord?.(w.charIndex, w.charLength));
    at(durationMs, () => finish('ended'));
    this.active.push(handle);
    return handle;
  }
  pause(): void { this._paused = true; }
  resume(): void { this._paused = false; }
  cancelAll(): void { this._paused = false; for (const h of [...this.active]) h.cancel(); }
}
