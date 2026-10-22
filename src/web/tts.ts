/**
 * Cloud voices for the web build, called straight from the browser with the learner's key and returning
 * the same CloudTtsResult as src/main/tts.ts. Safari's own voices (Web Speech) need nothing here: the
 * renderer's WebSpeechEngine uses them directly.
 *  - openai: /v1/audio/speech (gpt-4o-mini-tts), no word timings (the renderer estimates them).
 *  - elevenlabs: with-timestamps endpoint, character alignment -> word timings.
 *  - edge, kokoro: desktop only (msedge-tts needs a Node WebSocket client; Kokoro runs onnxruntime-node).
 */
import type { TtsEngineId } from '@shared/settings';
import type { CloudTtsResult, TtsVoiceInfo, WordTiming } from '@shared/api';
import { getSecret } from './secrets';

export const DESKTOP_ONLY_VOICE = 'This voice needs the Dream Read app on a Mac. On iPad, choose the iPad voices (built in), OpenAI or ElevenLabs in Settings.';

function rank(lang: string): number { return lang.toLowerCase() === 'en-gb' ? 3 : lang.toLowerCase().startsWith('en') ? 2 : lang.toLowerCase().startsWith('zh') ? 1 : 0; }

export async function listVoices(engine: TtsEngineId): Promise<TtsVoiceInfo[]> {
  if (engine === 'openai') {
    if (!(await getSecret('openai'))) return [];
    return ['ballad', 'fable', 'alloy', 'ash', 'coral', 'echo', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), lang: 'en', note: id === 'ballad' || id === 'fable' ? 'sounds most British' : undefined }));
  }
  if (engine === 'elevenlabs') {
    const key = await getSecret('elevenlabs');
    if (!key) return [];
    const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
    if (!res.ok) throw new Error(`ElevenLabs voices: HTTP ${res.status}`);
    const data = (await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] };
    return data.voices.map((v) => ({ id: v.voice_id, name: v.name, lang: /brit|english \(uk\)|gb/i.test(JSON.stringify(v.labels ?? {})) ? 'en-GB' : 'en', gender: v.labels?.gender, note: v.labels?.accent }))
      .sort((a, b) => rank(b.lang) - rank(a.lang) || a.name.localeCompare(b.name));
  }
  // edge / kokoro: nothing to list in a browser
  return [];
}

export async function synthesize(engine: TtsEngineId, text: string, voiceId: string, rate: number): Promise<CloudTtsResult> {
  const t = text.trim();
  if (!t) return { audio: new ArrayBuffer(0), mime: 'audio/mpeg', timings: [], durationSec: 0 };
  if (engine === 'openai') return synthOpenAI(t, voiceId || 'ballad', rate);
  if (engine === 'elevenlabs') return synthElevenLabs(t, voiceId || 'JBFqnCBsd6RMkjVDRZzb');
  if (engine === 'edge' || engine === 'kokoro') throw new Error(DESKTOP_ONLY_VOICE);
  throw new Error(`Voice engine "${engine}" is not available in this version.`);
}

async function synthOpenAI(text: string, voice: string, rate: number): Promise<CloudTtsResult> {
  const key = await getSecret('openai');
  if (!key) throw new Error('Add your OpenAI API key in Settings to use the OpenAI voice.');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice,
      input: text,
      instructions: 'Read this aloud in a clear, warm British English accent (Received Pronunciation), at a natural storytelling pace, for an English learner.',
      response_format: 'mp3',
      speed: Math.min(4, Math.max(0.25, rate || 1)),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI voice: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return { audio: await res.arrayBuffer(), mime: 'audio/mpeg', timings: null, durationSec: null };
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function synthElevenLabs(text: string, voice: string): Promise<CloudTtsResult> {
  const key = await getSecret('elevenlabs');
  if (!key) throw new Error('Add your ElevenLabs API key in Settings to use this voice.');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
  });
  if (!res.ok) throw new Error(`ElevenLabs: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = (await res.json()) as { audio_base64: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null };
  return { audio: base64ToBuffer(data.audio_base64), mime: 'audio/mpeg', timings: data.alignment ? charAlignmentToWords(data.alignment) : null, durationSec: null };
}

export function charAlignmentToWords(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): WordTiming[] {
  const out: WordTiming[] = [];
  let i = 0;
  while (i < a.characters.length) {
    if (/\s/.test(a.characters[i])) { i++; continue; }
    const start = i;
    while (i < a.characters.length && !/\s/.test(a.characters[i])) i++;
    out.push({ start: a.character_start_times_seconds[start], end: a.character_end_times_seconds[i - 1], charIndex: start, charLength: i - start });
  }
  return out;
}
