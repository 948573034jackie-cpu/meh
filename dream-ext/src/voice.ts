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
import type { Position } from '@core/model';

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

/**
 * Microsoft (Azure Speech) voices, free 500,000 characters a month (F0), by accent. The "Multilingual" ones say the
 * Chinese in a sentence themselves (in Mandarin); with the others the Chinese goes to a Chinese voice (same gender).
 */
export interface AzureVoice { id: string; name: string; accent: 'British' | 'American' | 'Australian' | 'Canadian' | 'Irish' | 'New Zealand'; gender: 'woman' | 'man' }
export const AZURE_ACCENTS: AzureVoice['accent'][] = ['British', 'American', 'Australian', 'Canadian', 'Irish', 'New Zealand'];
export const AZURE_VOICES: AzureVoice[] = [
  { id: 'en-GB-AdaMultilingualNeural', name: 'Ada ★ best British woman', accent: 'British', gender: 'woman' },
  { id: 'en-GB-OllieMultilingualNeural', name: 'Ollie ★ best British man', accent: 'British', gender: 'man' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia (clear, like the BBC)', accent: 'British', gender: 'woman' },
  { id: 'en-GB-RyanNeural', name: 'Ryan (friendly)', accent: 'British', gender: 'man' },
  { id: 'en-GB-LibbyNeural', name: 'Libby (young)', accent: 'British', gender: 'woman' },
  { id: 'en-GB-ThomasNeural', name: 'Thomas (calm)', accent: 'British', gender: 'man' },
  { id: 'en-US-AvaMultilingualNeural', name: 'Ava ★ best American woman', accent: 'American', gender: 'woman' },
  { id: 'en-US-AndrewMultilingualNeural', name: 'Andrew ★ best American man', accent: 'American', gender: 'man' },
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma (cheerful)', accent: 'American', gender: 'woman' },
  { id: 'en-US-BrianMultilingualNeural', name: 'Brian (relaxed)', accent: 'American', gender: 'man' },
  { id: 'en-US-JennyMultilingualNeural', name: 'Jenny (friendly)', accent: 'American', gender: 'woman' },
  { id: 'en-US-SteffanMultilingualNeural', name: 'Steffan (calm)', accent: 'American', gender: 'man' },
  { id: 'en-AU-NatashaNeural', name: 'Natasha', accent: 'Australian', gender: 'woman' },
  { id: 'en-AU-WilliamMultilingualNeural', name: 'William ★', accent: 'Australian', gender: 'man' },
  { id: 'en-CA-ClaraNeural', name: 'Clara', accent: 'Canadian', gender: 'woman' },
  { id: 'en-CA-LiamNeural', name: 'Liam', accent: 'Canadian', gender: 'man' },
  { id: 'en-IE-EmilyNeural', name: 'Emily', accent: 'Irish', gender: 'woman' },
  { id: 'en-IE-ConnorNeural', name: 'Connor', accent: 'Irish', gender: 'man' },
  { id: 'en-NZ-MollyNeural', name: 'Molly', accent: 'New Zealand', gender: 'woman' },
  { id: 'en-NZ-MitchellNeural', name: 'Mitchell', accent: 'New Zealand', gender: 'man' },
];
export const isMultilingual = (voiceId: string): boolean => /Multilingual/i.test(voiceId);
/** the voice for the Chinese words: the teacher's own when it is multilingual, else a Mandarin voice of the same gender */
export function azureZhVoice(voiceId: string): string {
  if (isMultilingual(voiceId)) return voiceId;
  return AZURE_VOICES.find((v) => v.id === voiceId)?.gender === 'man' ? 'zh-CN-YunxiNeural' : 'zh-CN-XiaoxiaoNeural';
}

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
    const r = (await chrome.runtime.sendMessage({ type: 'dream-tts', engine: id, text, voice: voiceId, lang })) as { b64?: string; mime?: string; timings?: CloudTtsResult['timings']; error?: string } | undefined;
    if (!r || r.error || r.b64 === undefined) throw new Error(r?.error ?? 'The voice service did not answer.');
    return { audio: fromBase64(r.b64), mime: r.mime ?? 'audio/mpeg', timings: r.timings ?? null, durationSec: null };
  };
  const list = async () => (id === 'openai' ? OPENAI_VOICES : id === 'azure' ? AZURE_VOICES : ELEVEN_VOICES).map((v) => ({ ...v, lang: lang === 'zh' ? 'zh-CN' : 'en' }));
  // whole sentences (no cuts at commas): a cloud voice is fast, and each piece made separately breaks the tone and
  // leaves small gaps between the pieces
  return new AudioTtsEngine(id, synth, list, id === 'elevenlabs', { segment: false });
}

/**
 * The voice actually used: 'auto' = Microsoft (free) when its key is saved, else OpenAI with its key; a cloud voice
 * without its key = the Mac voice.
 */
export function resolveVoice(choice: VoiceChoice, keys: { openai?: string; elevenlabs?: string; azure?: string }): 'mac' | 'openai' | 'elevenlabs' | 'azure' {
  if (choice === 'auto') return keys.azure ? 'azure' : keys.openai ? 'openai' : 'mac';
  if (choice === 'azure') return keys.azure ? 'azure' : 'mac';
  if (choice === 'openai') return keys.openai ? 'openai' : 'mac';
  if (choice === 'elevenlabs') return keys.elevenlabs ? 'elevenlabs' : 'mac';
  return 'mac';
}

/**
 * A cloud voice with the Mac voice behind it: when the cloud voice fails (no credit, no internet), the sentence
 * is said by the Mac voice and the Mac voice is used from then on; `onFail` tells the learner once.
 */
export class VoiceWithBackup implements TtsEngine {
  readonly id: TtsEngine['id'];
  readonly kind: TtsEngine['kind'];
  readonly label: string;
  readonly costNote: string;
  readonly wordBoundaries: boolean;
  failed = false;
  constructor(private primary: TtsEngine, private backup: TtsEngine, private backupVoice: () => string, private onFail: (e: Error) => void) {
    this.id = primary.id; this.kind = primary.kind; this.label = primary.label; this.costNote = primary.costNote; this.wordBoundaries = primary.wordBoundaries;
  }
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
    let inner = this.primary.speak(text, opts);
    let cancelled = false;
    const first = inner;
    const handle: SpeakHandle = {
      done: first.done.then((o): SpeakOutcome | Promise<SpeakOutcome> => {
        if (o !== 'error' || cancelled) return o;
        if (!this.failed) { this.failed = true; this.onFail(first.error ?? new Error('The voice failed.')); }
        inner = this.viaBackup(text, opts);
        return inner.done.then((o2) => { if (inner.error) handle.error = inner.error; return o2; });
      }),
      cancel: () => { cancelled = true; inner.cancel(); },
    };
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
 * The learner's volume sliders: every speak() of `inner` gets the volume of its slider (the word / sentence being
 * taught, or the teacher's explanation), read at that moment, so a slider change counts from the next sentence.
 */
export class WithVolume implements TtsEngine {
  readonly id: TtsEngine['id'];
  readonly kind: TtsEngine['kind'];
  readonly label: string;
  readonly costNote: string;
  readonly wordBoundaries: boolean;
  constructor(private inner: () => TtsEngine, private volume: () => number) {
    const v = inner();
    this.id = v.id; this.kind = v.kind; this.label = v.label; this.costNote = v.costNote; this.wordBoundaries = v.wordBoundaries;
  }
  get paused(): boolean { return this.inner().paused; }
  listVoices(): Promise<TtsVoice[]> { return this.inner().listVoices(); }
  speak(text: string, opts: SpeakOptions): SpeakHandle { return this.inner().speak(text, { ...opts, volume: this.volume() }); }
  prefetch(text: string, voiceId: string, rate: number): void { this.inner().prefetch?.(text, voiceId, rate); }
  readAhead(texts: string[], voiceId: string, rate: number): void { this.inner().readAhead?.(texts, voiceId, rate); }
  stopReadAhead(): void { this.inner().stopReadAhead?.(); }
  pause(): void { this.inner().pause(); }
  resume(): void { this.inner().resume(); }
  cancelAll(): void { this.inner().cancelAll(); }
  setRate(rate: number): void { (this.inner() as { setRate?: (r: number) => void }).setRate?.(rate); }
}

/** A volume slider (0..100) as the sound level: squared, so the slider feels even to the ear (50 % is about -12 dB). */
export function sliderGain(slider: number): number {
  const s = Math.max(0, Math.min(100, Number.isFinite(slider) ? slider : 100)) / 100;
  return s * s;
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
  constructor(private voice: () => TtsEngine, private video: TtsEngine & { hold(): void; forceStart: boolean; markTeacherPlayed(): void }, private isTaughtSentence: (text: string) => boolean, private onSentence?: () => void) {
    const v = voice();
    this.id = v.id; this.kind = v.kind; this.label = v.label; this.costNote = v.costNote; this.wordBoundaries = v.wordBoundaries;
  }
  get paused(): boolean { return this.voice().paused; }
  listVoices(): Promise<TtsVoice[]> { return this.voice().listVoices(); }
  speak(text: string, opts: SpeakOptions): SpeakHandle {
    if (!this.isTaughtSentence(text)) return this.voice().speak(text, opts);
    this.onSentence?.();
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

/**
 * The teacher's explanation, with the original sentences it quotes played from the video itself (the real speaker):
 * the cloud voice only reads the AI's own words, which saves its characters, and the learner hears the real line.
 * `find` = the sentence of the video the text is (quotes and punctuation aside), or null.
 */
export class QuotesFromVideo implements TtsEngine {
  readonly id: TtsEngine['id'];
  readonly kind: TtsEngine['kind'];
  readonly label: string;
  readonly costNote: string;
  readonly wordBoundaries: boolean;
  constructor(private voice: () => TtsEngine, private video: TtsEngine & { hold(): void; forceStart: boolean; target: Position | null }, private find: (text: string) => Position | null) {
    const v = voice();
    this.id = v.id; this.kind = v.kind; this.label = v.label; this.costNote = v.costNote; this.wordBoundaries = v.wordBoundaries;
  }
  get paused(): boolean { return this.voice().paused; }
  listVoices(): Promise<TtsVoice[]> { return this.voice().listVoices(); }
  speak(text: string, opts: SpeakOptions): SpeakHandle {
    const pos = this.find(text);
    if (!pos) return this.voice().speak(text, opts);
    const before = this.video.target;
    this.video.target = pos;
    this.video.forceStart = true;
    const h = this.video.speak(text, { ...opts, onWord: undefined });
    this.quoting = h;
    // after the quote: the video stops and the reading's own sentence is the target again; when the quote was cut
    // (something else started), nothing is touched: the new play has its own target already
    const back = (o: SpeakOutcome) => {
      if (this.quoting === h) this.quoting = null;
      if (this.video.target !== pos) return;
      this.video.target = before;
      if (o !== 'ended') return;
      this.video.hold();
      this.video.forceStart = true; // the reading goes on from its own sentence, not from this quote
    };
    return { done: h.done.then((o) => { back(o); return o; }), cancel: () => h.cancel(), get error() { return h.error; } };
  }
  /** the quote playing from the video now (only that is stopped by cancelAll: the video itself is not paused) */
  private quoting: SpeakHandle | null = null;
  prefetch(text: string, voiceId: string, rate: number): void { if (!this.find(text)) this.voice().prefetch?.(text, voiceId, rate); }
  stopReadAhead(): void { this.voice().stopReadAhead?.(); }
  pause(): void { this.voice().pause(); }
  resume(): void { this.voice().resume(); }
  cancelAll(): void { this.voice().cancelAll(); const q = this.quoting; this.quoting = null; q?.cancel(); }
}
