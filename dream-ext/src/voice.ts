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

/** test hook and diagnostics: what the cloud voice was asked to say */
export const cloudSpoken: string[] = [];

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** A cloud voice; `lang` 'zh' asks the voice to speak Mandarin (the Chinese meanings). */
export function cloudEngine(id: 'openai' | 'elevenlabs', lang: 'en' | 'zh'): AudioTtsEngine {
  const synth = async (_engine: unknown, text: string, voiceId: string): Promise<CloudTtsResult> => {
    cloudSpoken.push(text);
    if (cloudSpoken.length > 400) cloudSpoken.splice(0, 200);
    const r = (await chrome.runtime.sendMessage({ type: 'dream-tts', engine: id, text, voice: voiceId, lang })) as { b64?: string; mime?: string; timings?: CloudTtsResult['timings']; error?: string } | undefined;
    if (!r || r.error || r.b64 === undefined) throw new Error(r?.error ?? 'The voice service did not answer.');
    return { audio: fromBase64(r.b64), mime: r.mime ?? 'audio/mpeg', timings: r.timings ?? null, durationSec: null };
  };
  const list = async () => (id === 'openai' ? OPENAI_VOICES : ELEVEN_VOICES).map((v) => ({ ...v, lang: lang === 'zh' ? 'zh-CN' : 'en' }));
  return new AudioTtsEngine(id, synth, list, id === 'elevenlabs', { segment: true });
}

/** The voice actually used: 'auto' = OpenAI when its key is saved; a cloud voice without its key = the Mac voice. */
export function resolveVoice(choice: VoiceChoice, keys: { openai?: string; elevenlabs?: string }): 'mac' | 'openai' | 'elevenlabs' {
  if (choice === 'auto') return keys.openai ? 'openai' : 'mac';
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
