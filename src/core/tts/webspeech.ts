import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome } from './engine';

/**
 * Web Speech API engine (window.speechSynthesis). On macOS, Chromium backs this with Apple's
 * AVSpeechSynthesizer: every local system voice delivers word boundary events (charIndex/charLength),
 * including downloaded Enhanced/Premium voices. Rate 0.1-4 is honoured (we use 0.5-2.5).
 *
 * Known engine quirks handled here: getVoices() may be empty until 'voiceschanged'; utterances must be
 * kept referenced until they end; cancel() followed immediately by speak() can drop the new utterance,
 * so a new speak waits for the previous utterance's end/error event (or a short timeout).
 */
export class WebSpeechEngine implements TtsEngine {
  readonly id = 'webspeech' as const;
  readonly label = 'Mac voices (built in)';
  readonly kind = 'local' as const;
  readonly costNote = 'Free';
  readonly wordBoundaries = true;
  private inflight = new Set<SpeechSynthesisUtterance>();
  private settling: Promise<void> = Promise.resolve();
  private _paused = false;
  get paused(): boolean { return this._paused; }

  static available(): boolean { return typeof window !== 'undefined' && 'speechSynthesis' in window; }

  async listVoices(): Promise<TtsVoice[]> {
    const voices = await waitForVoices();
    return voices
      .map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang.replace('_', '-'), engine: 'webspeech' as const, note: v.localService ? undefined : 'online voice (no word highlight)' }))
      .sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  }

  /** Picks the best British voice when the user has not chosen one. */
  static async defaultVoiceId(lang = 'en-gb'): Promise<string> {
    const voices = await waitForVoices();
    const enGb = voices.filter((v) => v.lang.replace('_', '-').toLowerCase() === lang && v.localService);
    const preferred = ['Serena', 'Jamie', 'Daniel', 'Stephanie', 'Kate', 'Oliver'];
    for (const name of preferred) {
      const hit = enGb.find((v) => v.name.includes(name) && /premium|enhanced/i.test(v.name)) ?? enGb.find((v) => v.name.includes(name));
      if (hit) return hit.voiceURI;
    }
    return (enGb[0] ?? voices.find((v) => v.default) ?? voices[0])?.voiceURI ?? '';
  }

  speak(text: string, opts: SpeakOptions): SpeakHandle {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = Math.min(4, Math.max(0.1, opts.rate));
    u.lang = 'en-GB';
    const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === opts.voiceId || v.name === opts.voiceId);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    let resolve!: (o: SpeakOutcome) => void;
    const done = new Promise<SpeakOutcome>((r) => { resolve = r; });
    let finished = false;
    const finish = (o: SpeakOutcome) => { if (finished) return; finished = true; this.inflight.delete(u); resolve(o); };
    const handle: SpeakHandle = { done, cancel: () => { if (!finished) { speechSynthesis.cancel(); finish('cancelled'); } } };
    u.onstart = () => opts.onStart?.();
    let lastIndex = -1;
    u.onboundary = (e) => {
      if (e.name !== 'word') return;
      if (e.charIndex < lastIndex) return; // guard against engines that shuffle ranges
      lastIndex = e.charIndex;
      opts.onWord?.(e.charIndex, e.charLength ?? wordLengthAt(text, e.charIndex));
    };
    u.onend = () => finish('ended');
    u.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') finish('cancelled');
      else { handle.error = new Error(`speech error: ${e.error}`); finish('error'); }
    };
    this.inflight.add(u);
    // serialize behind any cancellation still settling, then speak
    this.settling = this.settling.then(async () => {
      if (finished) return;
      speechSynthesis.speak(u);
      // Safari/Chromium occasionally never fire onstart for empty/whitespace text
      if (!text.trim()) finish('ended');
    });
    return handle;
  }

  pause(): void { if (speechSynthesis.speaking && !speechSynthesis.paused) { speechSynthesis.pause(); this._paused = true; } }
  resume(): void { if (speechSynthesis.paused) { speechSynthesis.resume(); } this._paused = false; }
  cancelAll(): void {
    this._paused = false;
    speechSynthesis.cancel();
    // give the engine a moment to emit end/error events before the next speak()
    this.settling = new Promise((r) => setTimeout(r, 60));
  }
}

function rank(v: TtsVoice): number {
  let r = 0;
  if (v.lang.toLowerCase() === 'en-gb') r += 100;
  else if (v.lang.toLowerCase().startsWith('en')) r += 50;
  if (/premium/i.test(v.name)) r += 20; else if (/enhanced/i.test(v.name)) r += 10;
  if (v.note) r -= 30;
  return r;
}

function wordLengthAt(text: string, i: number): number {
  const m = /^[\p{L}\p{N}'’\-]+/u.exec(text.slice(i));
  return m ? m[0].length : 1;
}

let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;
export function waitForVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  if (!WebSpeechEngine.available()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise((resolve) => {
    const finish = () => { speechSynthesis.removeEventListener('voiceschanged', finish); resolve(speechSynthesis.getVoices()); voicesPromise = null; };
    speechSynthesis.addEventListener('voiceschanged', finish);
    setTimeout(finish, timeoutMs);
  });
  return voicesPromise;
}
