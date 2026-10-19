import { ipcMain } from 'electron';
import OpenAI from 'openai';
import type { TtsEngineId } from '@shared/settings';
import type { CloudTtsResult, TtsVoiceInfo, WordTiming } from '@shared/api';
import { getSecret } from './secrets';
import { kokoroSynthesize, kokoroVoices, registerKokoroIpc } from './kokoro/ipc';

/**
 * Voices synthesized in the main process (the renderer has no network access):
 *  - edge: Microsoft Edge "Read Aloud" neural voices through the unofficial msedge-tts client. Free, no key,
 *          returns word boundaries. May break when Microsoft changes its token scheme; the app then falls back.
 *  - openai: OpenAI /v1/audio/speech (gpt-4o-mini-tts). Paid. No word timing; the renderer estimates it.
 *  - elevenlabs: ElevenLabs with-timestamps endpoint. Paid. Character alignment -> word timings.
 *  - kokoro: Kokoro-82M running locally through onnxruntime-node (src/main/kokoro). Free. Word timings from the model.
 */
export function registerTtsHandlers(): void {
  registerKokoroIpc();
  ipcMain.handle('tts:voices', async (_e, engine: TtsEngineId): Promise<TtsVoiceInfo[]> => listVoices(engine));
  ipcMain.handle('tts:synthesize', async (_e, engine: TtsEngineId, text: string, voiceId: string, rate: number): Promise<CloudTtsResult> => {
    const t = text.trim();
    if (!t) return { audio: new ArrayBuffer(0), mime: 'audio/mpeg', timings: [], durationSec: 0 };
    if (engine === 'edge') return synthEdge(t, voiceId || 'en-GB-SoniaNeural', rate);
    if (engine === 'openai') return synthOpenAI(t, voiceId || 'ballad', rate);
    if (engine === 'elevenlabs') return synthElevenLabs(t, voiceId || 'JBFqnCBsd6RMkjVDRZzb');
    if (engine === 'kokoro') return kokoroSynthesize(t, voiceId || 'bf_emma', 1); // rate is applied on playback
    throw new Error(`Voice engine "${engine}" is not available in this version.`);
  });
}

async function listVoices(engine: TtsEngineId): Promise<TtsVoiceInfo[]> {
  if (engine === 'kokoro') return kokoroVoices();
  if (engine === 'edge') {
    const { MsEdgeTTS } = await import('msedge-tts');
    const tts = new MsEdgeTTS();
    const voices = await withTimeout(tts.getVoices(), 15_000, 'Microsoft voices');
    return voices
      .filter((v) => /^(en|zh)-/.test(v.Locale))
      .map((v) => ({ id: v.ShortName, name: friendly(v.FriendlyName, v.ShortName), lang: v.Locale, gender: v.Gender }))
      .sort((a, b) => rank(b.lang) - rank(a.lang) || a.name.localeCompare(b.name));
  }
  if (engine === 'openai') {
    if (!getSecret('openai')) return [];
    return ['ballad', 'fable', 'alloy', 'ash', 'coral', 'echo', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), lang: 'en', note: id === 'ballad' || id === 'fable' ? 'sounds most British' : undefined }));
  }
  if (engine === 'elevenlabs') {
    const key = getSecret('elevenlabs');
    if (!key) return [];
    const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
    if (!res.ok) throw new Error(`ElevenLabs voices: HTTP ${res.status}`);
    const data = (await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] };
    return data.voices.map((v) => ({ id: v.voice_id, name: v.name, lang: /brit|english \(uk\)|gb/i.test(JSON.stringify(v.labels ?? {})) ? 'en-GB' : 'en', gender: v.labels?.gender, note: v.labels?.accent }))
      .sort((a, b) => rank(b.lang) - rank(a.lang) || a.name.localeCompare(b.name));
  }
  return [];
}

function rank(lang: string): number { return lang.toLowerCase() === 'en-gb' ? 3 : lang.toLowerCase().startsWith('en') ? 2 : lang.toLowerCase().startsWith('zh') ? 1 : 0; }
function friendly(full: string, short: string): string {
  const m = /Microsoft (\w+) Online \(Natural\) - (\w+) \(([^)]+)\)/.exec(full);
  return m ? `${m[1]} (${m[3]})` : short;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---- Microsoft Edge ------------------------------------------------------------------------------
async function synthEdge(text: string, voice: string, rate: number): Promise<CloudTtsResult> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS({ connectionTimeoutMs: 15_000, synthesisTimeoutMs: 60_000 });
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
  const prosody = rate && Math.abs(rate - 1) > 0.05 ? { rate: `${rate >= 1 ? '+' : ''}${Math.round((rate - 1) * 100)}%` } : undefined;
  const { audioStream, metadataStream } = tts.toStream(text, prosody);
  const chunks: Buffer[] = [];
  const metaChunks: string[] = [];
  const audioDone = new Promise<void>((resolve, reject) => {
    audioStream.on('data', (c: Buffer) => chunks.push(c));
    audioStream.on('end', resolve);
    audioStream.on('error', reject);
  });
  const metaDone = metadataStream ? new Promise<void>((resolve) => {
    metadataStream.on('data', (c: Buffer | string) => metaChunks.push(c.toString()));
    metadataStream.on('end', resolve);
    metadataStream.on('error', () => resolve());
  }) : Promise.resolve();
  try {
    await withTimeout(Promise.all([audioDone, metaDone]), 70_000, 'Microsoft voice synthesis');
  } finally {
    try { tts.close(); } catch { /* ignore */ }
  }
  const audio = Buffer.concat(chunks);
  if (audio.length === 0) throw new Error('Microsoft voice returned no audio (the free service may be temporarily unavailable).');
  const timings = parseEdgeMetadata(metaChunks, text);
  return { audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength), mime: 'audio/mpeg', timings, durationSec: null };
}

/** Edge metadata chunks are JSON objects {Metadata:[{Type:'WordBoundary',Data:{Offset,Duration,text:{Text}}}]} with 100-ns ticks. */
export function parseEdgeMetadata(chunks: string[], text: string): WordTiming[] | null {
  const words: { start: number; end: number; word: string }[] = [];
  for (const chunk of chunks) {
    for (const piece of chunk.split(/\n(?=\{)/)) {
      try {
        const obj = JSON.parse(piece) as { Metadata?: { Type: string; Data: { Offset: number; Duration: number; text: { Text: string } } }[] };
        for (const m of obj.Metadata ?? []) {
          if (m.Type !== 'WordBoundary' || typeof m.Data?.text?.Text !== 'string') continue;
          words.push({ start: m.Data.Offset / 1e7, end: (m.Data.Offset + m.Data.Duration) / 1e7, word: m.Data.text.Text });
        }
      } catch { /* partial chunk */ }
    }
  }
  if (!words.length) return null;
  return alignWords(words, text);
}

/** Matches spoken word tokens to character positions in the original text, sequentially. */
export function alignWords(words: { start: number; end: number; word: string }[], text: string): WordTiming[] {
  const out: WordTiming[] = [];
  let cursor = 0;
  const lower = text.toLowerCase();
  const tokenAt = (i: number) => /^[\p{L}\p{N}'’\-]+/u.exec(lower.slice(i))?.[0] ?? '';
  for (const w of words) {
    const needle = w.word.toLowerCase().replace(/[^\p{L}\p{N}'’\-]/gu, '');
    if (!needle) continue;
    let idx = lower.indexOf(needle, cursor);
    // a word must start at a word boundary ("at" is not the tail of "cat"); apostrophe-led pieces ("'s") may follow a letter
    if (/^[\p{L}\p{N}]/u.test(needle)) while (idx > 0 && /[\p{L}\p{N}]/u.test(lower[idx - 1])) idx = lower.indexOf(needle, idx + 1);
    let len = needle.length;
    if (idx < 0 || idx - cursor > 40) {
      // the engine normalised the token (e.g. "2000" spoken as "two thousand"): take the next original token instead
      const m = /[\p{L}\p{N}]/u.exec(lower.slice(cursor));
      if (!m) break;
      idx = cursor + m.index;
      len = tokenAt(idx).length || 1;
    }
    out.push({ start: w.start, end: w.end, charIndex: idx, charLength: len });
    cursor = idx + len;
  }
  return out;
}

// ---- OpenAI --------------------------------------------------------------------------------------
async function synthOpenAI(text: string, voice: string, rate: number): Promise<CloudTtsResult> {
  const key = getSecret('openai');
  if (!key) throw new Error('Add your OpenAI API key in Settings to use the OpenAI voice.');
  const client = new OpenAI({ apiKey: key, maxRetries: 1, timeout: 60_000 });
  const res = await client.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: voice as never,
    input: text,
    instructions: 'Read this aloud in a clear, warm British English accent (Received Pronunciation), at a natural storytelling pace, for an English learner.',
    response_format: 'mp3',
    speed: Math.min(4, Math.max(0.25, rate || 1)),
  });
  const audio = await res.arrayBuffer();
  return { audio, mime: 'audio/mpeg', timings: null, durationSec: null };
}

// ---- ElevenLabs ----------------------------------------------------------------------------------
async function synthElevenLabs(text: string, voice: string): Promise<CloudTtsResult> {
  const key = getSecret('elevenlabs');
  if (!key) throw new Error('Add your ElevenLabs API key in Settings to use this voice.');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
  });
  if (!res.ok) throw new Error(`ElevenLabs: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { audio_base64: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null };
  const audio = Buffer.from(data.audio_base64, 'base64');
  const timings = data.alignment ? charAlignmentToWords(data.alignment) : null;
  return { audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength), mime: 'audio/mpeg', timings, durationSec: null };
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
