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

/** Engines offered in the UI, free ones first. */
export const AVAILABLE_ENGINES: TtsEngineId[] = ['kokoro', 'webspeech', 'edge', 'azure', 'google', 'openai', 'elevenlabs'];

/**
 * Characters of book text read aloud in one hour: about 150 words a minute x 6 characters (word + space)
 * x 60 minutes. The per-hour prices below are per-character list prices times this figure.
 */
export const CHARS_PER_HOUR = 54_000;

/** "$0.81/h" for a list price in US dollars per million characters. */
export function pricePerHour(usdPerMillionChars: number): string {
  return `$${((usdPerMillionChars * CHARS_PER_HOUR) / 1e6).toFixed(2)}/h`;
}

export interface EngineInfo {
  label: string;
  kind: 'local' | 'cloud';
  /** one-line cost note shown under the engine; starts with "Free" for free engines */
  cost: string;
  quality: string;
  /** short price per hour of listening ("free" or "$0.81/h") */
  perHour: string;
  /** the API key the engine needs, if any (Settings shows its status) */
  key?: 'openai' | 'elevenlabs' | 'azure' | 'google';
}

export const ENGINE_LABELS: Record<TtsEngineId, EngineInfo> = {
  webspeech: { label: 'Mac voices (built in)', kind: 'local', cost: 'Free', perHour: 'free', quality: 'Good with the Enhanced or Premium British voices (free download in System Settings)' },
  edge: { label: 'Microsoft neural voices', kind: 'cloud', cost: 'Free (unofficial, needs internet)', perHour: 'free', quality: 'Very good British voices (Sonia, Ryan, Libby, Thomas)' },
  azure: { label: 'Azure neural voices', kind: 'cloud', key: 'azure', perHour: `≈ ${pricePerHour(15)}`, cost: `Paid, about ${pricePerHour(15)} of listening ($15 per million characters); the first 500,000 characters a month are free (about 9 hours)`, quality: 'The same British voices as Microsoft Edge (Sonia, Ryan, Libby, Thomas), official and reliable. Word highlight is estimated.' },
  google: { label: 'Google Cloud voices', kind: 'cloud', key: 'google', perHour: `≈ $${((16 * CHARS_PER_HOUR) / 1e6).toFixed(2)}–${((30 * CHARS_PER_HOUR) / 1e6).toFixed(2)}/h`, cost: `Paid: Neural2 about ${pricePerHour(16)}, Chirp 3 HD about ${pricePerHour(30)} of listening; the first 1 million characters a month of each are free (about 18 hours)`, quality: 'Natural British voices; Neural2 voices give exact word highlight, Chirp 3 HD sound most human' },
  openai: { label: 'OpenAI voice', kind: 'cloud', key: 'openai', perHour: '≈ $0.90/h', cost: 'Paid, about $0.90/h of listening (1.5 cents per minute)', quality: 'Very natural, British accent on request' },
  elevenlabs: { label: 'ElevenLabs voice', kind: 'cloud', key: 'elevenlabs', perHour: `≈ ${pricePerHour(50)}`, cost: `Paid subscription, Flash voices about ${pricePerHour(50)} of listening; 10,000 free characters a month`, quality: 'Best, true British voices' },
  kokoro: { label: 'Dream voice (Kokoro, offline)', kind: 'local', cost: 'Free, one-time 192 MB download', perHour: 'free', quality: 'Natural British voices (Emma, George), runs on your Mac, no internet needed' },
};
