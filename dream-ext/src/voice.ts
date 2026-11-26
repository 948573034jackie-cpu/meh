/**
 * The tutor's voice on YouTube. The OpenAI voice (gpt-4o-mini-tts: marin, cedar, …) or ElevenLabs is synthesized
 * by the background worker with the learner's key, one clause at a time, and played here through Dream Read's
 * AudioTtsEngine (cached, read ahead, speed changed live). A failed sentence is tried again, then said by the Mac
 * voice, and the good voice comes back (VoiceWithBackup), so the tutor never goes silent. When the teacher repeats
 * the sentence being taught, the real sentence is played from the video instead of a synthetic voice.
 */
import { AudioTtsEngine } from '@core/tts/audio';
import type { TtsEngine, TtsVoice, SpeakOptions, SpeakHandle, SpeakOutcome, WordTime } from '@core/tts/engine';
import type { TtsEngineId } from '@shared/settings';
import type { CloudTtsResult } from '@shared/api';
import type { VoiceChoice } from './store';
import type { Position } from '@core/model';
import { AZURE_BUSY, SPEECHIFY_LIMIT } from './tts-cache';

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

/**
 * What a page may ask of the cloud voice beyond the usual (I Know Book asks for both, BOOK_VOICE; the YouTube tutor
 * for neither, so nothing changes there):
 * `light`: Microsoft sends 24 kHz / 96 kbit mp3 instead of 48 kHz / 192 kbit, a quarter of the bytes (an iPhone
 * plays the clip at 24 kHz anyway);
 * `fast`: ElevenLabs uses its fast model (eleven_flash_v2_5), whatever the quality setting says.
 */
export interface CloudOptions { light?: boolean; fast?: boolean }
export const BOOK_VOICE: CloudOptions = { light: true, fast: true };

/** the voice service is full for the moment (Microsoft's free limit): `code` 'busy' */
export const isBusy = (e: unknown): boolean => (e as { code?: string } | null | undefined)?.code === 'busy';
/** what VoiceWithBackup tells the page (onTrouble) when a sentence went to the device voice for that reason */
export const BUSY_NOTE = `${AZURE_BUSY}: the iPhone voice read this sentence`;

/** the cloud voices of the tutor ('speechify' = Speechify through the learner's own Worker, speech-proxy/) */
export type CloudVoice = 'openai' | 'elevenlabs' | 'azure' | 'speechify';
/** the voice actually used by a page */
export type VoiceKind = 'mac' | CloudVoice;

/**
 * The Speechify voice is not one of Dream Read's engine ids (vendor/shared is not edited): its engine carries this id,
 * typed as an engine id, with its own label (AudioEngineOptions.label).
 */
export const SPEECHIFY_ENGINE = 'speechify' as TtsEngineId;
export const SPEECHIFY_LABEL = 'Speechify voice';
/**
 * The Speechify voice waits this long for its sound at most (the background gives up on the Worker after 6 s, bg.ts
 * SPEECHIFY_SPEAK_TIMEOUT_MS); then the device voice says the sentence, with no second try, and the device voice reads
 * for SPEECHIFY_COOL_MS (a stalled Worker never makes many seconds of silence per sentence).
 */
export const SPEECHIFY_START_TIMEOUT_MS = 8_000;
export const SPEECHIFY_COOL_MS = 60_000;

/** what the background sent back when a sentence could not be made */
type TtsReply = { b64?: string; mime?: string; timings?: CloudTtsResult['timings']; error?: string; code?: string; note?: string } | undefined;

/**
 * The error of one failed sentence. `code` 'busy' = it goes to the device voice at once (no second try): Microsoft's
 * free limit, and EVERY failure of the Speechify voice (its rule: any error = the free iPhone voice for that sentence,
 * at once). `note` + `once` = what the learner is told, only the first time.
 */
export function ttsError(id: CloudVoice, r: TtsReply): Error {
  const message = r?.error ?? 'The voice service did not answer.';
  if (id === 'speechify') {
    const limit = message.startsWith(SPEECHIFY_LIMIT) || r?.note === SPEECHIFY_LIMIT;
    const note = limit ? SPEECHIFY_LIMIT : r?.note ?? `${message.startsWith('Speechify') ? message : `Speechify voice: ${message}`} The iPhone voice reads instead.`;
    return Object.assign(new Error(message), { code: 'busy', note, once: true });
  }
  const busy = r?.code === 'busy' || message.startsWith(AZURE_BUSY);
  return Object.assign(new Error(message), busy ? { code: 'busy' } : {});
}

/** A cloud voice; `lang` 'zh' asks the voice to speak Mandarin (the Chinese meanings). */
export function cloudEngine(id: CloudVoice, lang: 'en' | 'zh', o: CloudOptions = {}): AudioTtsEngine {
  const synth = async (_engine: unknown, text: string, voiceId: string): Promise<CloudTtsResult> => {
    cloudSpoken.push(text);
    if (cloudSpoken.length > 400) cloudSpoken.splice(0, 200);
    let r: TtsReply;
    try {
      r = (await chrome.runtime.sendMessage({ type: 'dream-tts', engine: id, text, voice: voiceId, lang, ...(o.light ? { light: true } : {}), ...(o.fast ? { fast: true } : {}) })) as TtsReply;
    } catch (e) { r = { error: (e as Error).message || 'The voice service did not answer.' }; }
    if (!r || r.error || r.b64 === undefined) throw ttsError(id, r);
    return { audio: fromBase64(r.b64), mime: r.mime ?? 'audio/mpeg', timings: r.timings ?? null, durationSec: null };
  };
  if (id === 'speechify') {
    // the picker's list comes from the Worker (speechifyVoiceList); here only the default ('' = the Worker's British voice)
    const list = async () => [{ id: '', name: 'Speechify British (default)', lang: lang === 'zh' ? 'zh-CN' : 'en-GB' }];
    // only the very next sentence is made ahead (it costs characters); the word times come from Speechify's speech marks
    return new AudioTtsEngine(SPEECHIFY_ENGINE, synth, list, true, { segment: false, ahead: 1, label: SPEECHIFY_LABEL, costNote: 'Paid by the characters: through your own Worker, with a daily limit' });
  }
  const list = async () => (id === 'openai' ? OPENAI_VOICES : id === 'azure' ? AZURE_VOICES : ELEVEN_VOICES).map((v) => ({ ...v, lang: lang === 'zh' ? 'zh-CN' : 'en' }));
  // whole sentences (no cuts at commas): a cloud voice is fast, and each piece made separately breaks the tone and
  // leaves small gaps between the pieces
  return new AudioTtsEngine(id, synth, list, id === 'elevenlabs', { segment: false });
}

/** a voice of the Speechify picker (from the Worker's GET /voices); `isDefault` = the natural British default */
export interface SpeechifyVoiceOption { id: string; name: string; locale: string; gender: string; tags: string[]; preview: string | null; british: boolean; isDefault: boolean }
/**
 * The Speechify voices for the picker in Settings (English, the British default first and marked `isDefault`).
 * Throws with a short message when the Worker cannot be reached or the address / app code is missing.
 */
export async function speechifyVoiceList(): Promise<{ voices: SpeechifyVoiceOption[]; default: string | null }> {
  const r = (await chrome.runtime.sendMessage({ type: 'dream-speechify-voices' })) as { voices?: SpeechifyVoiceOption[]; default?: string | null; error?: string } | undefined;
  if (!r || r.error || !Array.isArray(r.voices)) throw new Error(r?.error ?? 'The Speechify Worker did not answer.');
  return { voices: r.voices, default: r.default ?? null };
}
/** the name shown for a voice in the picker: "Emma (British, woman) ★ default" */
export function speechifyVoiceName(v: SpeechifyVoiceOption): string {
  const accent = v.british ? 'British' : /^en-us/i.test(v.locale) ? 'American' : /^en-au/i.test(v.locale) ? 'Australian' : v.locale || 'English';
  const who = v.gender === 'female' ? 'woman' : v.gender === 'male' ? 'man' : '';
  return `${v.name} (${accent}${who ? `, ${who}` : ''})${v.isDefault ? ' ★ default' : ''}`;
}

/**
 * The voice actually used: 'auto' = Microsoft (free) when its key is saved, else OpenAI with its key; a cloud voice
 * without its key = the Mac voice.
 * `o.noOpenAi` (I Know Book): 'auto' never picks OpenAI (its voice models end on 6 Jan 2027): Microsoft, else
 * ElevenLabs, else the device voice. OpenAI chosen by name still works while it lasts.
 * Speechify: only for a caller that passes `o.speechifyUrl` (extras.speechifyUrl; a page that can play it). Then
 * 'speechify' = Speechify when the address AND the app code (keys.speechify) are set, else the device voice; 'auto' =
 * Speechify FIRST when both are set. A caller without `speechifyUrl` never gets 'speechify' (its choice = the device voice).
 */
export function resolveVoice(choice: VoiceChoice, keys: { openai?: string; elevenlabs?: string; azure?: string; speechify?: string }, o?: { noOpenAi?: boolean }): Exclude<VoiceKind, 'speechify'>;
export function resolveVoice(choice: VoiceChoice, keys: { openai?: string; elevenlabs?: string; azure?: string; speechify?: string }, o: { noOpenAi?: boolean; speechifyUrl: string }): VoiceKind;
export function resolveVoice(choice: VoiceChoice, keys: { openai?: string; elevenlabs?: string; azure?: string; speechify?: string }, o: { noOpenAi?: boolean; speechifyUrl?: string } = {}): VoiceKind {
  const speechify = o.speechifyUrl !== undefined;
  const speechifyReady = speechify && !!o.speechifyUrl?.trim() && !!keys.speechify?.trim();
  if (choice === 'speechify') return speechifyReady ? 'speechify' : 'mac';
  if (choice === 'auto' && speechifyReady) return 'speechify';
  if (choice === 'auto' && o.noOpenAi) return keys.azure ? 'azure' : keys.elevenlabs ? 'elevenlabs' : 'mac';
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
 * A sentence the service has no room for just now (Microsoft's free limit, an error with `code` 'busy') is not tried
 * again and is no failure of the good voice: the Mac voice says it at once, and `onTrouble` gets BUSY_NOTE (an error
 * with `code` 'busy'), at most once a minute.
 * The handle follows the voice that speaks: clock() and `words` of the try that is heard, onBoundary from the Mac voice.
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
  /** counts cancelAll(): a try waiting from before it does not start any more */
  private stops = 0;
  /** the last reason the good voice failed (for the 🩺 check) */
  lastError: string | null = null;
  /** when the learner was last told that the service is busy (ms) */
  private busyTold = -Infinity;
  /** the notes told once already (the Speechify voice: "today's limit", "did not work") */
  private toldOnce = new Set<string>();
  constructor(private primary: TtsEngine, private backup: TtsEngine, private backupVoice: () => string, private onTrouble: (e: Error, cooling: boolean) => void, private startTimeoutMs = 12_000, private now: () => number = () => Date.now()) {
    this.id = primary.id; this.kind = primary.kind; this.label = primary.label; this.costNote = primary.costNote; this.wordBoundaries = primary.wordBoundaries;
  }
  get failed(): boolean { return this.now() < this.coolUntil; }
  /** the Speechify voice: every sentence is tried once only (it costs characters, and a wait is silence) */
  private get oneTry(): boolean { return this.primary.id === SPEECHIFY_ENGINE; }
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
    const stopsAtStart = this.stops;
    const gone = () => cancelled || this.stops !== stopsAtStart;
    const handle: SpeakHandle = { done: Promise.resolve('ended' as SpeakOutcome), cancel: () => { cancelled = true; inner?.cancel(); }, clock: () => inner?.clock?.() ?? null, onBoundary: null };
    // the word times of the try that is heard: told once, as soon as they are known (null = this voice gives none)
    let tellWords!: (w: WordTime[] | null) => void;
    handle.words = new Promise<WordTime[] | null>((r) => { tellWords = r; });
    /** `h` is the voice now: its word events reach the caller; its word times are told (`now`: whatever they are) */
    const follow = (h: SpeakHandle, now: boolean): void => {
      h.onBoundary = (i, l) => handle.onBoundary?.(i, l);
      void (h.words ?? Promise.resolve(null)).then((w) => { if (inner === h && (w || now)) tellWords(w); }, () => undefined);
    };
    const viaBackup = async (): Promise<SpeakOutcome> => {
      const b = this.viaBackup(text, opts);
      inner = b;
      follow(b, true);
      const o = await b.done;
      if (b.error) handle.error = b.error;
      return o;
    };
    const attempt = (n: number): Promise<SpeakOutcome> => {
      let started = false, timedOut = false;
      let cur: SpeakHandle | null = null;
      const h = this.primary.speak(text, { ...opts, onStart: () => { started = true; if (cur) follow(cur, true); opts.onStart?.(); } });
      cur = h;
      inner = h;
      follow(h, started);
      // (while the learner has paused the teacher no sound is expected: the clock waits)
      const watch = (): ReturnType<typeof setTimeout> => setTimeout(() => {
        if (started || gone()) return;
        if (this.primary.paused) { timer = watch(); return; }
        timedOut = true;
        h.cancel();
      }, this.oneTry ? Math.min(this.startTimeoutMs, SPEECHIFY_START_TIMEOUT_MS) : this.startTimeoutMs);
      let timer = watch();
      return h.done.then(async (o): Promise<SpeakOutcome> => {
        clearTimeout(timer);
        if (gone()) return 'cancelled';
        if (o === 'ended') { this.fails = 0; return o; }
        if (o === 'cancelled' && !timedOut) return o;
        // no room at the service just now: a second try would wait in the same line, so this sentence goes to the
        // Mac voice at once; it is no failure of the good voice (the limit frees by itself)
        if (!timedOut && isBusy(h.error)) {
          // (an error with its own `note`: that is told; `once`: only the first time, not every minute)
          const { note, once } = (h.error ?? {}) as { note?: string; once?: boolean };
          const say = note ?? BUSY_NOTE;
          this.lastError = say;
          if (once) { if (!this.toldOnce.has(say)) { this.toldOnce.add(say); this.onTrouble(Object.assign(new Error(say), { code: 'busy' }), false); } }
          else if (this.now() - this.busyTold >= 60_000) { this.busyTold = this.now(); this.onTrouble(Object.assign(new Error(say), { code: 'busy' }), false); }
          return viaBackup();
        }
        this.lastError = timedOut ? 'no sound came in time' : h.error?.message ?? 'the voice failed';
        // (the Speechify voice: no second try; no sound in time = its Worker is stalled: the device voice for a minute)
        if (this.oneTry) {
          if (timedOut) this.lastError = 'Speechify voice: no sound came in time. The iPhone voice reads for a minute.';
          const cooling = timedOut || ++this.fails >= 3;
          if (cooling) { this.coolUntil = this.now() + SPEECHIFY_COOL_MS; this.fails = 0; }
          this.onTrouble(new Error(this.lastError), cooling);
          return viaBackup();
        }
        // once more (most failures are a short hiccup)
        if (n === 0) { await new Promise((r) => setTimeout(r, 400)); if (gone()) return 'cancelled'; return attempt(1); }
        this.fails++;
        const cooling = this.fails >= 3;
        if (cooling) { this.coolUntil = this.now() + 60_000; this.fails = 0; }
        this.onTrouble(new Error(this.lastError), cooling);
        return viaBackup();
      });
    };
    handle.done = attempt(0);
    // (never left open: a speech that ends without word times has none)
    void handle.done.then(() => tellWords(null));
    return handle;
  }
  prefetch(text: string, voiceId: string, rate: number, volume?: number): void { if (!this.failed) this.primary.prefetch?.(text, voiceId, rate, volume); }
  readAhead(texts: string[], voiceId: string, rate: number, volume?: number): void { if (!this.failed) this.primary.readAhead?.(texts, voiceId, rate, volume); }
  stopReadAhead(): void { this.primary.stopReadAhead?.(); }
  pause(): void { this.primary.pause(); this.backup.pause(); }
  resume(): void { this.primary.resume(); this.backup.resume(); }
  cancelAll(): void { this.stops++; this.primary.cancelAll(); this.backup.cancelAll(); }
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
  /** `onSpeak`: something is said now / was said (a stop that stays silent can be noticed) */
  constructor(private inner: () => TtsEngine, private volume: () => number, private onSpeak?: (text?: string) => void) {
    const v = inner();
    this.id = v.id; this.kind = v.kind; this.label = v.label; this.costNote = v.costNote; this.wordBoundaries = v.wordBoundaries;
  }
  get paused(): boolean { return this.inner().paused; }
  listVoices(): Promise<TtsVoice[]> { return this.inner().listVoices(); }
  speak(text: string, opts: SpeakOptions): SpeakHandle {
    const h = this.inner().speak(text, { ...opts, volume: this.volume() });
    if (this.onSpeak) { const end = () => this.onSpeak?.(); this.onSpeak(text); void h.done.then(end, end); }
    return h;
  }
  // (what is made ahead is made at the slider's volume: on an iPhone the volume is in the sound itself)
  prefetch(text: string, voiceId: string, rate: number): void { this.inner().prefetch?.(text, voiceId, rate, this.volume()); }
  readAhead(texts: string[], voiceId: string, rate: number): void { this.inner().readAhead?.(texts, voiceId, rate, this.volume()); }
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
 * Chrome's free online voices ("Google UK English Female", …) stop by themselves after about 15 seconds of speech:
 * long text is said in short pieces (at commas and spaces), one after the other. Every other voice gets the text as it is.
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
  prefetch(text: string, voiceId: string, rate: number, volume?: number): void { this.inner.prefetch?.(text, voiceId, rate, volume); }
  readAhead(texts: string[], voiceId: string, rate: number, volume?: number): void { this.inner.readAhead?.(texts, voiceId, rate, volume); }
  stopReadAhead(): void { this.inner.stopReadAhead?.(); }
  pause(): void { this.inner.pause(); }
  resume(): void { this.inner.resume(); }
  cancelAll(): void { this.inner.cancelAll(); }
  setRate(rate: number): void { (this.inner as { setRate?: (r: number) => void }).setRate?.(rate); }
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
  prefetch(text: string, voiceId: string, rate: number, volume?: number): void { if (!this.isTaughtSentence(text)) this.voice().prefetch?.(text, voiceId, rate, volume); }
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
  prefetch(text: string, voiceId: string, rate: number, volume?: number): void { if (!this.find(text)) this.voice().prefetch?.(text, voiceId, rate, volume); }
  stopReadAhead(): void { this.voice().stopReadAhead?.(); }
  pause(): void { this.voice().pause(); }
  resume(): void { this.voice().resume(); }
  cancelAll(): void { this.voice().cancelAll(); const q = this.quoting; this.quoting = null; q?.cancel(); }
}
