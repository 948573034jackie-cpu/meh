import { app, ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import type { CloudTtsResult, TtsVoiceInfo, WordTiming } from '@shared/api';
import { KokoroEngine, type EngineStatus, type SynthesisResult } from './engine';
import { handlePrepare, type KokoroPrepareItem } from './ipc-prepare';
import { KOKORO_VOICES, DEFAULT_VOICE } from './voices';
import type { EndPunct } from '@core/tts/segments';

/**
 * IPC for the local Kokoro voice. Channels (renderer -> main, all `invoke`):
 *  - kokoro:status                      -> EngineStatus (model present? downloading? progress?)
 *  - kokoro:download                    -> resolves when the model files are on disk (progress via kokoro:progress)
 *  - kokoro:cancelDownload
 *  - kokoro:voices                      -> TtsVoiceInfo[]
 *  - kokoro:synthesize(text, voice, speed, { asFile? }) -> KokoroSynthesisReply
 *  - kokoro:prepare(items)              -> queues sentences for background synthesis. Items may carry
 *      `priority` (src/core/tts/segments PRIORITY; default 'background') and `wait: true` (the call then resolves
 *      when those items are synthesized, so the renderer can fetch them from the memory cache without queueing as
 *      'now'). Control items (empty text): `{ text: '', replace: true }` makes the call replace the read-ahead
 *      (queued jobs nobody waits for and not in this call are dropped), `{ text: '', release: true }` turns the
 *      renderer's own waiting requests into ordinary read-ahead (it cancelled its speech), `{ text: '', voice,
 *      speed, drop: texts }` removes the queued jobs of those texts nobody waits for (an explanation prepared ahead
 *      was dropped). See KokoroEngine.
 * Main -> renderer: 'kokoro:progress' (EngineStatus) on every change, sent to every window.
 * The preload bridge for these channels still needs to be added to src/preload/index.ts and src/shared/api.ts;
 * until then the voice is reachable through the existing tts:synthesize / tts:voices channels with engine 'kokoro'.
 */
export interface KokoroSynthesisReply {
  /** WAV bytes (when not asFile) */
  audio: ArrayBuffer | null;
  /** path of the cached WAV file (when asFile) */
  path: string | null;
  mime: 'audio/wav';
  timings: WordTiming[];
  durationSec: number;
  phonemes: string;
  fromCache: boolean;
  /** the text's end punctuation: the audio is trimmed to the speech, the pause after it is the player's (SEGMENT_PAUSE_MS) */
  endPunct: EndPunct;
}

let engine: KokoroEngine | null = null;

export function kokoroEngine(): KokoroEngine {
  if (!engine) {
    const userData = app.getPath('userData');
    engine = new KokoroEngine({
      modelDir: process.env.KOKORO_MODEL_DIR || path.join(userData, 'models', 'kokoro'),
      cacheDir: path.join(userData, 'cache', 'tts'),
      log: (m) => console.log(m),
    });
    engine.onStatus = (s) => broadcast(s);
  }
  return engine;
}

/**
 * Loads the model and runs the warm-up inference in the background (in the worker thread) when the model is on
 * disk, so the first sentence the learner plays does not wait for model loading (6 s on a 4-core Intel Mac).
 */
export function warmUpKokoro(): void {
  const eng = kokoroEngine();
  if (!eng.installedVariant || eng.isLoaded) return;
  eng.ensureReady(false).catch((e) => console.log(`kokoro: warm-up failed: ${(e as Error).message}`));
}

function broadcast(s: EngineStatus): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('kokoro:progress', s);
}

export function kokoroVoices(): TtsVoiceInfo[] {
  return KOKORO_VOICES.map((v) => ({ id: v.id, name: v.name, lang: v.lang, gender: v.gender, quality: v.grade, note: v.id === DEFAULT_VOICE ? 'default' : undefined }));
}

/** A fresh ArrayBuffer for IPC (a Buffer may share a pooled or shared backing store). */
function toArrayBuffer(b: Buffer): ArrayBuffer { const ab = new ArrayBuffer(b.byteLength); new Uint8Array(ab).set(b); return ab; }

function toTimings(r: SynthesisResult): WordTiming[] { return r.words.map((w) => ({ start: w.start, end: w.end, charIndex: w.charIndex, charLength: w.charLength })); }

/** Used by the generic tts:synthesize channel (engine 'kokoro'); downloads the model on first use. */
export async function kokoroSynthesize(text: string, voiceId: string, speed: number): Promise<CloudTtsResult> {
  const r = await kokoroEngine().synthesize(text, { voice: voiceId || DEFAULT_VOICE, speed });
  return { audio: toArrayBuffer(r.wav), mime: 'audio/wav', timings: toTimings(r), durationSec: r.durationSec, endPunct: r.endPunct ?? null };
}

export function registerKokoroIpc(): void {
  ipcMain.handle('kokoro:status', (): EngineStatus => kokoroEngine().status());
  ipcMain.handle('kokoro:download', async (): Promise<EngineStatus> => { await kokoroEngine().download(); return kokoroEngine().status(); });
  ipcMain.handle('kokoro:cancelDownload', (): void => kokoroEngine().cancelDownload());
  ipcMain.handle('kokoro:voices', (): TtsVoiceInfo[] => kokoroVoices());
  ipcMain.handle('kokoro:synthesize', async (_e, text: string, voice: string, speed: number, opts?: { asFile?: boolean }): Promise<KokoroSynthesisReply> => {
    const eng = kokoroEngine();
    const r = await eng.synthesize(text, { voice, speed });
    return {
      audio: opts?.asFile ? null : toArrayBuffer(r.wav),
      path: opts?.asFile ? eng.wavPath(text.trim(), voice, speed) : null,
      mime: 'audio/wav', timings: toTimings(r), durationSec: r.durationSec, phonemes: r.phonemes, fromCache: r.fromCache, endPunct: r.endPunct ?? null,
    };
  });
  ipcMain.handle('kokoro:prepare', (_e, items: KokoroPrepareItem[]): Promise<boolean> | void => handlePrepare(kokoroEngine(), items));
}
