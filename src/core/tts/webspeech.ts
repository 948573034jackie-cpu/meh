import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome } from './engine';

/** onstart must arrive within this long, else the engine is assumed stuck and the utterance is retried */
export const START_TIMEOUT_MS = 4000;
/** the first utterance after a voice change: Enhanced/Premium voices warm up slowly */
export const START_TIMEOUT_NEW_VOICE_MS = 8000;
/** margin added to twice the expected duration before an utterance without onend/onerror is given up */
export const END_TIMEOUT_EXTRA_MS = 5000;
/** Chromium pauses long utterances on some versions; a resume() tick while speaking is the usual workaround */
export const RESUME_TICK_MS = 10_000;
/** a "Test voice" probe must start within this long */
export const PROBE_TIMEOUT_MS = 5000;
/** words per minute at rate 1, used to estimate how long an utterance should take */
const WORDS_PER_MINUTE = 150;

export const VOICE_DID_NOT_START = 'The Mac voice did not start';

/** an utterance handed to the engine or waiting for it */
interface Job {
  started: boolean;
  finished: boolean;
  finish: (o: SpeakOutcome) => void;
}

/**
 * Web Speech API engine (window.speechSynthesis). On macOS, Chromium backs this with Apple's
 * AVSpeechSynthesizer: every local system voice delivers word boundary events (charIndex/charLength),
 * including downloaded Enhanced/Premium voices. Rate 0.1-4 is honoured (we use 0.5-2.5).
 *
 * Known engine quirks handled here:
 * - getVoices() may be empty until 'voiceschanged'; a chosen voice may disappear (renamed/removed).
 * - utterances must be kept referenced until they end.
 * - cancel() followed immediately by speak() can drop the new utterance, so a new speak waits for the
 *   previous utterance's end/error event (or a short timeout).
 * - the synthesizer can stay `paused` after a cancel, or report `speaking` forever with nothing playing:
 *   speak() resumes a paused synthesizer, a start watchdog cancels and retries an utterance whose onstart
 *   never arrives, and an end watchdog finishes one whose onend/onerror never arrives.
 * - every step is reject-proof: a throwing speak() fails that one utterance instead of silencing all later ones.
 */
export class WebSpeechEngine implements TtsEngine {
  readonly id = 'webspeech' as const;
  readonly label = 'Mac voices (built in)';
  readonly kind = 'local' as const;
  readonly costNote = 'Free';
  readonly wordBoundaries = true;
  private inflight = new Set<Job>();
  /** serializes speak() calls behind any cancellation still settling; never left rejected */
  private settling: Promise<void> = Promise.resolve();
  private _paused = false;
  /** voiceURI of the last utterance (null before the first): a change means the voice has to warm up */
  private lastVoiceURI: string | null = null;
  /** true once we waited for 'voiceschanged' and none came: do not wait 2 s for every sentence on a voiceless machine */
  private voicesChecked = false;
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

  speak(text: string, opts: SpeakOptions): SpeakHandle { return this.start(text, opts, 1); }

  /**
   * Speaks a short text silently and reports whether the synthesizer actually started it.
   * Used by a "Test voice" button; `reason` is a message the learner can act on.
   */
  async probe(voiceId?: string): Promise<{ ok: boolean; reason?: string }> {
    if (!WebSpeechEngine.available()) return { ok: false, reason: 'Speech synthesis is not available in this window' };
    const voices = await waitForVoices();
    if (!voices.length) return { ok: false, reason: 'No system voices found. Download a voice in System Settings > Accessibility > Spoken Content.' };
    const id = voiceId || (await WebSpeechEngine.defaultVoiceId());
    this.cancelAll();
    let started = false;
    const handle = this.start('Testing the voice.', { voiceId: id, rate: 1, onStart: () => { started = true; } }, 0.01); // not 0: some AVSpeech builds skip events for silent utterances
    const outcome = await Promise.race([handle.done, settle(PROBE_TIMEOUT_MS).then(() => 'timeout' as const)]);
    handle.cancel();
    if (outcome === 'error') return { ok: false, reason: handle.error?.message ?? VOICE_DID_NOT_START };
    if (started) return { ok: true };
    if (outcome === 'cancelled') return { ok: false, reason: 'The voice test was interrupted' };
    return { ok: false, reason: `${VOICE_DID_NOT_START} within ${PROBE_TIMEOUT_MS / 1000} seconds` };
  }

  private start(text: string, opts: SpeakOptions, volume: number): SpeakHandle {
    let resolve!: (o: SpeakOutcome) => void;
    const done = new Promise<SpeakOutcome>((r) => { resolve = r; });
    const job: Job = { started: false, finished: false, finish: () => undefined };
    let utterance: SpeechSynthesisUtterance | null = null;
    let timers: ReturnType<typeof setTimeout>[] = [];
    let resumeTick: ReturnType<typeof setInterval> | null = null;
    const clearTimers = () => {
      for (const t of timers) clearTimeout(t);
      timers = [];
      if (resumeTick) { clearInterval(resumeTick); resumeTick = null; }
    };
    /** stops routing engine events of the current utterance (a cancelled/abandoned one still emits 'canceled') */
    const detach = () => { if (utterance) utterance.onstart = utterance.onend = utterance.onerror = utterance.onboundary = null; };
    job.finish = (o) => {
      if (job.finished) return;
      job.finished = true;
      clearTimers();
      detach();
      this.inflight.delete(job);
      resolve(o);
    };
    const handle: SpeakHandle = {
      done,
      cancel: () => {
        if (job.finished) return;
        job.finish('cancelled');
        cancelSynth();
        // cancel() immediately followed by speak() can drop the new utterance (Chromium): let the engine settle first
        this.settling = settle();
      },
    };
    const fail = (message: string) => { handle.error = new Error(message); job.finish('error'); };
    this.inflight.add(job);

    const armEndWatchdog = () => {
      const words = Math.max(1, text.split(/\s+/).filter(Boolean).length);
      const expectedMs = (words / (WORDS_PER_MINUTE * clampRate(opts.rate))) * 60_000;
      const ms = expectedMs * 2 + END_TIMEOUT_EXTRA_MS;
      const arm = () => timers.push(setTimeout(() => {
        if (job.finished) return;
        if (this._paused) { arm(); return; } // paused by the user: wait the same again
        // neither onend nor onerror arrived: the engine lost the utterance, do not hang the reading loop
        job.finish('ended');
        cancelSynth();
        this.settling = settle();
      }, ms));
      arm();
    };

    const armStartWatchdog = (ms: number, attempt: number) => {
      timers.push(setTimeout(() => {
        if (job.finished || job.started) return;
        // another utterance is legitimately still talking: this one is queued behind it
        if ([...this.inflight].some((j) => j !== job && j.started && !j.finished)) { armStartWatchdog(ms, attempt); return; }
        detach();
        cancelSynth();
        if (attempt === 0) {
          // the synthesizer was stuck (paused after a cancel, or speaking nothing): clear it and try once more
          this.settling = settle(250).then(() => launch(1)).catch((e) => fail(`speech error: ${describe(e)}`));
        } else {
          this.settling = settle();
          fail(VOICE_DID_NOT_START);
        }
      }, ms));
    };

    const launch = async (attempt: number): Promise<void> => {
      if (job.finished) return;
      const voice = await this.resolveVoice(opts.voiceId);
      if (job.finished) return;
      const voiceURI = voice?.voiceURI ?? '';
      const newVoice = voiceURI !== this.lastVoiceURI;
      this.lastVoiceURI = voiceURI;
      const u = new SpeechSynthesisUtterance(text);
      utterance = u;
      u.rate = clampRate(opts.rate);
      u.volume = volume;
      u.lang = voice?.lang ?? 'en-GB';
      if (voice) u.voice = voice;
      let lastIndex = -1;
      u.onstart = () => {
        if (job.finished || job.started) return;
        job.started = true;
        clearTimers();
        armEndWatchdog();
        resumeTick = setInterval(() => { if (speechSynthesis.speaking && !this._paused) safe(() => speechSynthesis.resume()); }, RESUME_TICK_MS);
        opts.onStart?.();
      };
      u.onboundary = (e) => {
        if (e.name !== 'word') return;
        if (e.charIndex < lastIndex) return; // guard against engines that shuffle ranges
        lastIndex = e.charIndex;
        opts.onWord?.(e.charIndex, e.charLength ?? wordLengthAt(text, e.charIndex));
      };
      u.onend = () => job.finish('ended');
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') job.finish('cancelled');
        else fail(`speech error: ${e.error}`);
      };
      // a synthesizer left paused (e.g. after a cancel) queues new utterances silently forever
      if (speechSynthesis.paused) speechSynthesis.resume();
      this._paused = false;
      armStartWatchdog(newVoice ? START_TIMEOUT_NEW_VOICE_MS : START_TIMEOUT_MS, attempt);
      speechSynthesis.speak(u);
      // Safari/Chromium occasionally never fire onstart for empty/whitespace text
      if (!text.trim()) job.finish('ended');
    };

    // serialize behind any cancellation still settling, then speak; a failure settles this handle only
    this.settling = this.settling
      .then(() => launch(0), () => launch(0))
      .catch((e) => fail(`speech error: ${describe(e)}`));
    return handle;
  }

  /** The voice the learner chose, or the default British voice when it no longer exists; null when there are no voices at all. */
  private async resolveVoice(voiceId: string): Promise<SpeechSynthesisVoice | null> {
    let voices = speechSynthesis.getVoices();
    if (!voices.length && !this.voicesChecked) {
      voices = await waitForVoices();
      this.voicesChecked = true;
    }
    const chosen = voiceId ? voices.find((v) => v.voiceURI === voiceId || v.name === voiceId) : undefined;
    if (chosen) return chosen;
    if (!voices.length) return null;
    const fallback = await WebSpeechEngine.defaultVoiceId();
    return voices.find((v) => v.voiceURI === fallback) ?? null;
  }

  pause(): void { if (speechSynthesis.speaking && !speechSynthesis.paused) { speechSynthesis.pause(); this._paused = true; } }
  resume(): void { if (speechSynthesis.paused) { speechSynthesis.resume(); } this._paused = false; }
  cancelAll(): void {
    this._paused = false;
    // utterances still waiting behind a settle window never reach the engine: settle them here
    for (const job of [...this.inflight]) job.finish('cancelled');
    cancelSynth();
    // give the engine a moment to emit end/error events before the next speak()
    this.settling = settle();
  }
}

function settle(ms = 60): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function clampRate(rate: number): number { return Math.min(4, Math.max(0.1, Number.isFinite(rate) ? rate : 1)); }
function safe(fn: () => void): void { try { fn(); } catch { /* a broken synthesizer must not break the caller */ } }
function cancelSynth(): void { safe(() => speechSynthesis.cancel()); }
function describe(e: unknown): string { return e instanceof Error ? e.message : String(e); }

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
