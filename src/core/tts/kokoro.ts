import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle } from './engine';
import { ENGINE_LABELS } from './engine';
import { AudioTtsEngine } from './audio';

/**
 * Kokoro-82M, synthesized in the main process (src/main/kokoro) and played here through the same
 * HTMLAudioElement path as the cloud voices. The main process returns a WAV plus word timings taken from the
 * model's duration predictor, so `onWord` fires on real word boundaries. The first use downloads the model
 * (about 190 MB); the main process reports progress on the 'kokoro:progress' channel.
 */
export class KokoroTtsEngine implements TtsEngine {
  readonly id = 'kokoro' as const;
  readonly kind = 'local' as const;
  readonly label = ENGINE_LABELS.kokoro.label;
  readonly costNote = ENGINE_LABELS.kokoro.cost;
  readonly wordBoundaries = true;
  private inner: AudioTtsEngine;

  constructor() {
    this.inner = new AudioTtsEngine('kokoro', (engine, text, voiceId, rate) => window.readalong.ttsSynthesize(engine, text, voiceId, rate), (engine) => window.readalong.ttsListVoices(engine), true);
  }
  get paused(): boolean { return this.inner.paused; }
  listVoices(): Promise<TtsVoice[]> { return this.inner.listVoices(); }
  speak(text: string, opts: SpeakOptions): SpeakHandle { return this.inner.speak(text, opts); }
  prefetch(text: string, voiceId: string, rate: number): void { this.inner.prefetch(text, voiceId, rate); }
  pause(): void { this.inner.pause(); }
  resume(): void { this.inner.resume(); }
  cancelAll(): void { this.inner.cancelAll(); }
  setRate(rate: number): void { this.inner.setRate(rate); }
  /** Synthesizes a short phrase (downloading the model on first use); the reason is the main process error. */
  async probe(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const r = await window.readalong.ttsSynthesize('kokoro', 'Hello.', 'bf_emma', 1);
      return r.audio.byteLength > 0 ? { ok: true } : { ok: false, reason: 'The Kokoro voice returned no audio.' };
    } catch (e) { return { ok: false, reason: (e as Error).message }; }
  }
}
