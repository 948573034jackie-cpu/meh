/** Kokoro v1.0 English voices with hexgrad's quality grades. British voices first; the app defaults to bf_emma. */
export interface KokoroVoice { id: string; name: string; lang: 'en-GB' | 'en-US'; gender: 'Female' | 'Male'; grade: string }

export const KOKORO_VOICES: KokoroVoice[] = [
  { id: 'bf_emma', name: 'Emma', lang: 'en-GB', gender: 'Female', grade: 'B-' },
  { id: 'bm_george', name: 'George', lang: 'en-GB', gender: 'Male', grade: 'C' },
  { id: 'bf_isabella', name: 'Isabella', lang: 'en-GB', gender: 'Female', grade: 'C' },
  { id: 'bm_fable', name: 'Fable', lang: 'en-GB', gender: 'Male', grade: 'C' },
  { id: 'bm_lewis', name: 'Lewis', lang: 'en-GB', gender: 'Male', grade: 'D+' },
  { id: 'bf_alice', name: 'Alice', lang: 'en-GB', gender: 'Female', grade: 'D' },
  { id: 'bf_lily', name: 'Lily', lang: 'en-GB', gender: 'Female', grade: 'D' },
  { id: 'bm_daniel', name: 'Daniel', lang: 'en-GB', gender: 'Male', grade: 'D' },
  { id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'Female', grade: 'A' },
  { id: 'af_bella', name: 'Bella', lang: 'en-US', gender: 'Female', grade: 'A-' },
  { id: 'af_nicole', name: 'Nicole', lang: 'en-US', gender: 'Female', grade: 'B-' },
  { id: 'af_aoede', name: 'Aoede', lang: 'en-US', gender: 'Female', grade: 'C+' },
  { id: 'af_kore', name: 'Kore', lang: 'en-US', gender: 'Female', grade: 'C+' },
  { id: 'af_sarah', name: 'Sarah', lang: 'en-US', gender: 'Female', grade: 'C+' },
  { id: 'am_fenrir', name: 'Fenrir', lang: 'en-US', gender: 'Male', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', lang: 'en-US', gender: 'Male', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', lang: 'en-US', gender: 'Male', grade: 'C+' },
  { id: 'af_alloy', name: 'Alloy', lang: 'en-US', gender: 'Female', grade: 'C' },
  { id: 'af_nova', name: 'Nova', lang: 'en-US', gender: 'Female', grade: 'C' },
  { id: 'af_sky', name: 'Sky', lang: 'en-US', gender: 'Female', grade: 'C-' },
];

export const DEFAULT_VOICE = 'bf_emma';

export function isKnownVoice(id: string): boolean { return KOKORO_VOICES.some((v) => v.id === id); }
