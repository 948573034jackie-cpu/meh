/**
 * The tutor's cloud voice (Microsoft, OpenAI, ElevenLabs) on a web page of the app's browser: the sound is made by
 * the voice service as always ('dream-tts', the key stays in the private world), but it is PLAYED BY THE APP
 * (AVAudioPlayer), not by an audio element of the page. A website's own rules (its Content-Security-Policy) can
 * forbid sounds the page did not make itself; the app's player is not the page, so the voice works on every site.
 * The app answers "audioPlay" with { ok, duration } and tells the start and the end through window.__ytcAudio.
 */
import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome } from '@core/tts/engine';
import { appPost } from './native-bridge';

type Sound = { b64: string; mime: string };
type AudioEvent = { id?: number; event?: string };
const waiting = new Map<number, (ev: string) => void>();
let nextId = 0;
let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  (window as unknown as { __ytcAudio?: (ev: AudioEvent) => void }).__ytcAudio = (ev) => { if (ev && typeof ev.id === 'number' && typeof ev.event === 'string') waiting.get(ev.id)?.(ev.event); };
}

export class NativeAudioEngine implements TtsEngine {
  readonly kind = 'cloud' as const;
  readonly label = 'The tutor\'s voice (played by the app)';
  readonly costNote = '';
  readonly wordBoundaries = false;
  readonly paused = false;
  private cache = new Map<string, Promise<Sound>>();
  private live = new Set<SpeakHandle>();

  constructor(readonly id: 'openai' | 'elevenlabs' | 'azure', private lang: 'en' | 'zh' = 'en') { wire(); }

  async listVoices(): Promise<TtsVoice[]> { return []; }

  private fetch(text: string, voiceId: string): Promise<Sound> {
    const key = `${voiceId}\u0000${text}`;
    let p = this.cache.get(key);
    if (!p) {
      p = (chrome.runtime.sendMessage({ type: 'dream-tts', engine: this.id, text, voice: voiceId, lang: this.lang }) as Promise<{ b64?: string; mime?: string; error?: string } | undefined>).then((r) => {
        if (!r || r.error || !r.b64) throw new Error(r?.error ?? 'The voice service did not answer.');
        return { b64: r.b64, mime: r.mime ?? 'audio/mpeg' };
      });
      p.catch(() => { if (this.cache.get(key) === p) this.cache.delete(key); });
      this.cache.set(key, p);
      while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value as string);
    }
    return p;
  }

  /** the next sentence is made while this one is said (one sentence ahead, no more: it costs characters) */
  prefetch(text: string, voiceId: string, _rate: number): void { void this.fetch(text, voiceId).catch(() => undefined); }

  speak(text: string, opts: SpeakOptions): SpeakHandle {
    const id = ++nextId;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolve!: (o: SpeakOutcome) => void;
    const done = new Promise<SpeakOutcome>((r) => { resolve = r; });
    const handle: SpeakHandle = { done, cancel: () => { if (!finished) { void appPost({ kind: 'audioStop', id }); finish('cancelled'); } } };
    const finish = (o: SpeakOutcome) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      waiting.delete(id);
      this.live.delete(handle);
      resolve(o);
    };
    this.live.add(handle);
    waiting.set(id, (ev) => {
      if (ev === 'start') opts.onStart?.();
      else if (ev === 'end') finish('ended');
      else if (ev === 'cancel') finish('cancelled');
      else { handle.error = new Error('the sound could not be played'); finish('error'); }
    });
    void (async () => {
      try {
        const sound = await this.fetch(text, opts.voiceId);
        if (finished) return;
        const r = (await appPost({ kind: 'audioPlay', id, b64: sound.b64, mime: sound.mime, rate: opts.rate, volume: opts.volume ?? 1 })) as { ok?: boolean; duration?: number } | null;
        if (finished) return;
        if (!r || !r.ok) { handle.error = new Error('the app could not play the sound'); finish('error'); return; }
        // (should the end never be told: the sound's own length, and a little more)
        const sec = typeof r.duration === 'number' && r.duration > 0 ? r.duration / Math.max(0.5, opts.rate) : 30;
        timer = setTimeout(() => finish('ended'), sec * 1000 + 2500);
      } catch (e) { handle.error = e as Error; finish('error'); }
    })();
    return handle;
  }

  pause(): void { /* a web page's explanation is short: it is stopped, not paused */ }
  resume(): void { /* see pause */ }
  cancelAll(): void { for (const h of [...this.live]) h.cancel(); }
}
