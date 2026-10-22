/**
 * The tutor's voice on YouTube. The OpenAI voice (gpt-4o-mini-tts: marin, cedar, …) or ElevenLabs is synthesized
 * by the background worker with the learner's key, one clause at a time, and played here through Dream Read's
 * AudioTtsEngine (cached, read ahead, speed changed live). A failing cloud voice falls back to the Mac voice for
 * the rest of the video, so the tutor never goes silent. When the teacher repeats the sentence being taught, the
 * real sentence is played from the video instead of a synthetic voice.
 */
import { AudioTtsEngine } from '@core/tts/audio';
import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome } from '@core/tts/engine';
import type { CloudTtsResult } from '@shared/api';
import type { VoiceChoice } from './store';

export const OPENAI_VOICES: { id: string; name: string }[] = [
  { id: 'marin', name: 'Marin (most natural)' }, { id: 'cedar', name: 'Cedar (most natural)' },
  { id: 'coral', name: 'Coral' }, { id: 'sage', name: 'Sage' }, { id: 'ballad', name: 'Ballad (British-sounding)' },
  { id: 'verse', name: 'Verse' }, { id: 'shimmer', name: 'Shimmer' }, { id: 'alloy', name: 'Alloy' },
  { id: 'ash', name: 'Ash' }, { id: 'echo', name: 'Echo' },
];
/** voices of the live call (the realtime models have no fable / nova / onyx) */
export const LIVE_VOICES = new Set(['marin', 'cedar', 'coral', 'sage', 'ballad', 'verse', 'shimmer', 'alloy', 'ash', 'echo']);

export const ELEVEN_VOICES: { id: string; name: string }[] = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George (British, warm)' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice (British, clear)' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel (British, calm)' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily (British, soft)' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah (American, friendly)' },
];

/** Microsoft's neural voices through Azure Speech (official; a free tier of about 9 hours of speech a month) */
export const AZURE_VOICES: { id: string; name: string }[] = [
  { id: 'en-US-AvaMultilingualNeural', name: 'Ava (US, most natural)' }, { id: 'en-US-AndrewMultilingualNeural', name: 'Andrew (US, most natural)' },
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma (US)' }, { id: 'en-US-BrianMultilingualNeural', name: 'Brian (US)' },
  { id: 'en-US-JennyNeural', name: 'Jenny (US)' }, { id: 'en-US-AriaNeural', name: 'Aria (US)' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia (UK)' }, { id: 'en-GB-RyanNeural', name: 'Ryan (UK)' }, { id: 'en-GB-LibbyNeural', name: 'Libby (UK)' },
];
export const AZURE_REGIONS = ['eastus', 'eastus2', 'westus', 'westus2', 'centralus', 'canadacentral', 'westeurope', 'northeurope', 'uksouth', 'francecentral', 'eastasia', 'southeastasia', 'japaneast', 'koreacentral', 'australiaeast', 'centralindia'];

/** test hook and diagnostics: what the cloud voice was asked to say */
export const cloudSpoken: string[] = [];

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** A cloud voice; `lang` 'zh' asks the voice to speak Mandarin (the Chinese meanings). */
export function cloudEngine(id: 'openai' | 'elevenlabs' | 'azure', lang: 'en' | 'zh'): AudioTtsEngine {
  const synth = async (_engine: unknown, text: string, voiceId: string): Promise<CloudTtsResult> => {
    cloudSpoken.push(text);
    if (cloudSpoken.length > 400) cloudSpoken.splice(0, 200);
    let r: { b64?: string; mime?: string; timings?: CloudTtsResult['timings']; error?: string } | undefined;
    try { r = await chrome.runtime.sendMessage({ type: 'dream-tts', engine: id, text, voice: voiceId, lang }); }
    catch (e) { throw new Error(/context invalidated/i.test((e as Error).message) ? 'the extension was updated: reload this YouTube page (⌘R)' : (e as Error).message); }
    if (!r || r.error || r.b64 === undefined) throw new Error(r?.error ?? 'The voice service did not answer.');
    return { audio: fromBase64(r.b64), mime: r.mime ?? 'audio/mpeg', timings: r.timings ?? null, durationSec: null };
  };
  const list = async () => (id === 'openai' ? OPENAI_VOICES : id === 'azure' ? AZURE_VOICES : ELEVEN_VOICES).map((v) => ({ ...v, lang: lang === 'zh' ? 'zh-CN' : 'en' }));
  return new AudioTtsEngine(id, synth, list, id !== 'openai', { segment: true });
}

/** The voice actually used: 'auto' = Azure (free tier) or OpenAI when its key is saved; a cloud voice without its key = the Mac voice. */
export function resolveVoice(choice: VoiceChoice, keys: { openai?: string; elevenlabs?: string; azure?: string }): 'mac' | 'openai' | 'elevenlabs' | 'azure' {
  if (choice === 'auto') return keys.azure ? 'azure' : keys.openai ? 'openai' : 'mac';
  if (choice === 'azure') return keys.azure ? 'azure' : 'mac';
  if (choice === 'openai') return keys.openai ? 'openai' : 'mac';
  if (choice === 'elevenlabs') return keys.elevenlabs ? 'elevenlabs' : 'mac';
  return 'mac';
}

/**
 * A cloud voice with the Mac voice behind it. A failed sentence (no internet for a moment, a busy server, no sound
 * after `startTimeoutMs`) is tried once more; if that fails too, only that sentence is said by the Mac voice and the
 * good voice is used again for the next one. Three failed sentences in a row = the Mac voice for one minute, then the
 * good voice again (it never stays on the Mac voice for the rest of the video). `onTrouble` tells the learner.
 */
export class VoiceWithBackup implements TtsEngine {
  readonly id: TtsEngine['id'];
  readonly kind: TtsEngine['kind'];
  readonly label: string;
  readonly costNote: string;
  readonly wordBoundaries: boolean;
  /** sentences failed in a row */
  private fails = 0;
  /** the Mac voice only, until then (ms) */
  private coolUntil = 0;
  /** the last reason the good voice failed (for the 🩺 check) */
  lastError: string | null = null;
  constructor(private primary: TtsEngine, private backup: TtsEngine, private backupVoice: () => string, private onTrouble: (e: Error, cooling: boolean) => void, private startTimeoutMs = 12_000, private now: () => number = () => Date.now()) {
    this.id = primary.id; this.kind = primary.kind; this.label = primary.label; this.costNote = primary.costNote; this.wordBoundaries = primary.wordBoundaries;
  }
  get failed(): boolean { return this.now() < this.coolUntil; }
  get paused(): boolean { return (this.failed ? this.backup : this.primary).paused; }
  listVoices(): Promise<TtsVoice[]> { return this.primary.listVoices(); }
  /** the backup voice for this text; '' (no fitting Mac voice, e.g. for Chinese) = say nothing */
  private viaBackup(text: string, opts: SpeakOptions): SpeakHandle {
    const v = this.backupVoice();
    if (!v) return { done: Promise.resolve('ended'), cancel: () => undefined };
    return this.backup.speak(text, { ...opts, voiceId: v });
  }
  speak(text: string, opts: SpeakOptions): SpeakHandle {
    if (this.failed) return this.viaBackup(text, opts);
    let cancelled = false;
    let inner: SpeakHandle | null = null;
    const handle: SpeakHandle = { done: Promise.resolve('ended' as SpeakOutcome), cancel: () => { cancelled = true; inner?.cancel(); } };
    const attempt = (n: number): Promise<SpeakOutcome> => {
      let started = false, timedOut = false;
      const h = this.primary.speak(text, { ...opts, onStart: () => { started = true; opts.onStart?.(); } });
      inner = h;
      const timer = setTimeout(() => { if (!started && !cancelled) { timedOut = true; h.cancel(); } }, this.startTimeoutMs);
      return h.done.then(async (o): Promise<SpeakOutcome> => {
        clearTimeout(timer);
        if (cancelled) return 'cancelled';
        if (o === 'ended') { this.fails = 0; return o; }
        if (o === 'cancelled' && !timedOut) return o;
        this.lastError = timedOut ? 'no sound came in time' : h.error?.message ?? 'the voice failed';
        // once more (most failures are a short hiccup)
        if (n === 0) { await new Promise((r) => setTimeout(r, 400)); if (cancelled) return 'cancelled'; return attempt(1); }
        this.fails++;
        const cooling = this.fails >= 3;
        if (cooling) { this.coolUntil = this.now() + 60_000; this.fails = 0; }
        this.onTrouble(new Error(this.lastError), cooling);
        const b = this.viaBackup(text, opts);
        inner = b;
        const o2 = await b.done;
        if (b.error) handle.error = b.error;
        return o2;
      });
    };
    handle.done = attempt(0);
    return handle;
  }
  prefetch(text: string, voiceId: string, rate: number): void { if (!this.failed) this.primary.prefetch?.(text, voiceId, rate); }
  readAhead(texts: string[], voiceId: string, rate: number): void { if (!this.failed) this.primary.readAhead?.(texts, voiceId, rate); }
  stopReadAhead(): void { this.primary.stopReadAhead?.(); }
  pause(): void { this.primary.pause(); this.backup.pause(); }
  resume(): void { this.primary.resume(); this.backup.resume(); }
  cancelAll(): void { this.primary.cancelAll(); this.backup.cancelAll(); }
  setRate(rate: number): void { (this.primary as { setRate?: (r: number) => void }).setRate?.(rate); }
}

/**
 * Chrome's free online voices ("Google UK English Female", …) stop by themselves after about 15 seconds of speech:
 * long text is said in short pieces (at commas and spaces), one after the other.
 */
export class ShortPieces implements TtsEngine {
  readonly id: TtsEngine['id'];
  readonly kind: TtsEngine['kind'];
  readonly label: string;
  readonly costNote: string;
  readonly wordBoundaries: boolean;
  constructor(private inner: TtsEngine, private isOnline: (voiceId: string) => boolean, private max = 140) {
    this.id = inner.id; this.kind = inner.kind; this.label = inner.label; this.costNote = inner.costNote; this.wordBoundaries = inner.wordBoundaries;
  }
  get paused(): boolean { return this.inner.paused; }
  listVoices(): Promise<TtsVoice[]> { return this.inner.listVoices(); }
  speak(text: string, opts: SpeakOptions): SpeakHandle {
    if (!this.isOnline(opts.voiceId) || text.length <= this.max) return this.inner.speak(text, opts);
    const pieces = splitPieces(text, this.max);
    let cancelled = false;
    let cur: SpeakHandle | null = null;
    const handle: SpeakHandle = { done: Promise.resolve('ended' as SpeakOutcome), cancel: () => { cancelled = true; cur?.cancel(); } };
    handle.done = (async (): Promise<SpeakOutcome> => {
      for (let i = 0; i < pieces.length; i++) {
        if (cancelled) return 'cancelled';
        cur = this.inner.speak(pieces[i], { ...opts, onStart: i === 0 ? opts.onStart : undefined, onWord: undefined });
        const o = await cur.done;
        if (o !== 'ended') { if (cur.error) handle.error = cur.error; return o; }
      }
      return 'ended';
    })();
    return handle;
  }
  prefetch(text: string, voiceId: string, rate: number): void { this.inner.prefetch?.(text, voiceId, rate); }
  stopReadAhead(): void { this.inner.stopReadAhead?.(); }
  pause(): void { this.inner.pause(); }
  resume(): void { this.inner.resume(); }
  cancelAll(): void { this.inner.cancelAll(); }
}

/** text in pieces of at most `max` characters, cut after a comma / semicolon / dash, else at a space */
export function splitPieces(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' – '), window.lastIndexOf(' - '));
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The teacher's "say the sentence" goes to the video: when the text is the sentence being taught, the real
 * sentence plays (and the video pauses again at its end); everything else goes to the tutor's voice.
 */
export class SentenceFromVideo implements TtsEngine {
  readonly id: TtsEngine['id'];
  readonly kind: TtsEngine['kind'];
  readonly label: string;
  readonly costNote: string;
  readonly wordBoundaries: boolean;
  constructor(private voice: () => TtsEngine, private video: TtsEngine & { hold(): void; forceStart: boolean; markTeacherPlayed(): void }, private isTaughtSentence: (text: string) => boolean, private onPlay?: () => void) {
    const v = voice();
    this.id = v.id; this.kind = v.kind; this.label = v.label; this.costNote = v.costNote; this.wordBoundaries = v.wordBoundaries;
  }
  get paused(): boolean { return this.voice().paused; }
  listVoices(): Promise<TtsVoice[]> { return this.voice().listVoices(); }
  speak(text: string, opts: SpeakOptions): SpeakHandle {
    if (!this.isTaughtSentence(text)) return this.voice().speak(text, opts);
    this.onPlay?.(); // (the dictionary card closes when the sentence plays again)
    this.video.forceStart = true;
    const h = this.video.speak(text, { ...opts, onWord: undefined });
    return { done: h.done.then((o) => { this.video.hold(); if (o === 'ended') this.video.markTeacherPlayed(); return o; }), cancel: () => h.cancel(), get error() { return h.error; } };
  }
  prefetch(text: string, voiceId: string, rate: number): void { if (!this.isTaughtSentence(text)) this.voice().prefetch?.(text, voiceId, rate); }
  stopReadAhead(): void { this.voice().stopReadAhead?.(); }
  pause(): void { this.voice().pause(); }
  resume(): void { this.voice().resume(); }
  cancelAll(): void { this.voice().cancelAll(); }
}
