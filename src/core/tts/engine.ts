import type { TtsEngineId } from '@shared/settings';

/** A voice offered by an engine. `id` is engine-specific (voiceURI for Web Speech, provider voice id otherwise). */
export interface TtsVoice {
  id: string;
  name: string;
  lang: string;
  engine: TtsEngineId;
  gender?: string;
  quality?: string;
  note?: string;
}

export interface SpeakOptions {
  voiceId: string;
  /** 0.5 .. 2.5, 1 = normal */
  rate: number;
  onStart?: () => void;
  /** charIndex/charLength index into the spoken text (UTF-16 units) */
  onWord?: (charIndex: number, charLength: number) => void;
}

export type SpeakOutcome = 'ended' | 'cancelled' | 'error';

export interface SpeakHandle {
  /** resolves when speech finishes, is cancelled, or fails (never rejects) */
  done: Promise<SpeakOutcome>;
  error?: Error;
  cancel(): void;
}

/**
 * Text-to-speech engine. One sentence (or short text) per speak() call. Engines must support
 * cancel() at any time and must never leave a dangling promise. Renderer-side only.
 */
export interface TtsEngine {
  readonly id: TtsEngineId;
  readonly label: string;
  readonly kind: 'local' | 'cloud';
  readonly costNote: string;
  /** true when the engine delivers real per-word timing; false means word highlight is estimated */
  readonly wordBoundaries: boolean;
  listVoices(): Promise<TtsVoice[]>;
  speak(text: string, opts: SpeakOptions): SpeakHandle;
  /** optional: synthesize ahead of time so the next sentence starts without delay */
  prefetch?(text: string, voiceId: string, rate: number): void;
  pause(): void;
  resume(): void;
  cancelAll(): void;
  /** true when a paused utterance exists */
  readonly paused: boolean;
  /** optional: checks that the engine can actually start speaking (a "Test voice" button); `reason` explains a failure */
  probe?(): Promise<{ ok: boolean; reason?: string }>;
}

/** Engines offered in the UI (kokoro is reserved for a later version). */
export const AVAILABLE_ENGINES: TtsEngineId[] = ['kokoro', 'webspeech', 'edge', 'openai', 'elevenlabs'];

export const ENGINE_LABELS: Record<TtsEngineId, { label: string; kind: 'local' | 'cloud'; cost: string; quality: string }> = {
  webspeech: { label: 'Mac voices (built in)', kind: 'local', cost: 'Free', quality: 'Good with the Enhanced or Premium British voices (free download in System Settings)' },
  edge: { label: 'Microsoft neural voices', kind: 'cloud', cost: 'Free (unofficial, needs internet)', quality: 'Very good British voices (Sonia, Ryan, Libby, Thomas)' },
  openai: { label: 'OpenAI voice', kind: 'cloud', cost: 'Paid, about 1.5 cents per minute', quality: 'Very natural, British accent on request' },
  elevenlabs: { label: 'ElevenLabs voice', kind: 'cloud', cost: 'Paid subscription', quality: 'Best, true British voices' },
  kokoro: { label: 'Dream voice (Kokoro, offline)', kind: 'local', cost: 'Free, one-time 192 MB download', quality: 'Natural British voices (Emma, George), runs on your Mac, no internet needed' },
};
