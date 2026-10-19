import { app, ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import { SttEngine, type EngineStatus, type SttEngineEvent, type RecognizeResult } from './engine';
import { isVariant } from './download';
import { getSettings } from '../settings';

/**
 * IPC for local speech-to-text. Channels (renderer -> main, all `invoke`):
 *  - stt:status                                   -> EngineStatus (model present? downloading? progress?)
 *  - stt:download                                 -> resolves when the model files are on disk (progress via stt:progress)
 *  - stt:cancelDownload
 *  - stt:start(sessionId, { sampleRate? })        -> opens a mic session (loads/downloads the model first)
 *  - stt:push(sessionId, ArrayBuffer)             -> Int16 mono PCM at the session's sample rate (16 kHz, 20–40 ms frames)
 *  - stt:stop(sessionId)                          -> closes it; resolves after the last final was sent
 *  - stt:recognizeFile(path)                      -> RecognizeResult (tests / debugging)
 * Main -> renderer (sent to every window):
 *  - 'stt:event'    SttEngineEvent: { type:'partial'|'final', text, confidence?, segmentId, sessionId }
 *                   | { type:'speechStart'|'speechEnd', sessionId, segmentId } | { type:'error', sessionId, message }
 *  - 'stt:progress' EngineStatus on every change (download progress, state)
 * Preload bridge: sttStatus / sttDownload / sttCancelDownload / sttStart / sttPush / sttStop / onSttEvent /
 * onSttProgress in src/preload/index.ts (types in src/shared/api.ts).
 */
let engine: SttEngine | null = null;

/** The model chosen in Settings (voiceChat.model); STT_VARIANT (env) wins when set, as before. */
function configuredVariant(): ReturnType<typeof getSettings>['voiceChat']['model'] | undefined {
  if (process.env.STT_VARIANT) return undefined;
  try { const v = getSettings().voiceChat?.model; return isVariant(v) ? v : undefined; } catch { return undefined; }
}

export function sttEngine(): SttEngine {
  // the learner picked another model: a fresh engine, once no mic session or download is running
  const want = configuredVariant();
  if (engine && want && engine.variant !== want) {
    const st = engine.status();
    if (st.sessions === 0 && st.state !== 'downloading' && st.state !== 'loading') { void engine.release(); engine = null; }
  }
  if (!engine) {
    const userData = app.getPath('userData');
    engine = new SttEngine({ modelDir: process.env.STT_MODEL_DIR || path.join(userData, 'models', 'stt'), variant: want, log: (m) => console.log(m) });
    engine.on('status', (s) => broadcast('stt:progress', s));
    engine.on('event', (e) => broadcast('stt:event', e));
  }
  return engine;
}

function broadcast(channel: 'stt:progress' | 'stt:event', payload: EngineStatus | SttEngineEvent): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function sessionIdOf(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 64) throw new Error('stt: invalid session id');
  return v;
}

export function registerSttIpc(): void {
  ipcMain.handle('stt:status', (): EngineStatus => sttEngine().status());
  ipcMain.handle('stt:download', async (): Promise<EngineStatus> => { await sttEngine().download(); return sttEngine().status(); });
  ipcMain.handle('stt:cancelDownload', (): void => sttEngine().cancelDownload());
  ipcMain.handle('stt:start', async (_e, sessionId: unknown, opts?: { sampleRate?: number }): Promise<EngineStatus> => {
    await sttEngine().start(sessionIdOf(sessionId), { sampleRate: typeof opts?.sampleRate === 'number' ? opts.sampleRate : undefined });
    return sttEngine().status();
  });
  ipcMain.handle('stt:push', (_e, sessionId: unknown, pcm: unknown): Promise<void> => {
    const id = sessionIdOf(sessionId);
    const buf = pcm instanceof ArrayBuffer ? new Int16Array(pcm, 0, pcm.byteLength >> 1)
      : ArrayBuffer.isView(pcm) ? new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1)
        : null;
    if (!buf) return Promise.reject(new Error('stt:push expects an ArrayBuffer of Int16 PCM'));
    return sttEngine().pushAudio(id, buf);
  });
  ipcMain.handle('stt:stop', (_e, sessionId: unknown): Promise<void> => sttEngine().stop(sessionIdOf(sessionId)));
  ipcMain.handle('stt:recognizeFile', (_e, file: unknown): Promise<RecognizeResult> => {
    if (typeof file !== 'string') return Promise.reject(new Error('stt:recognizeFile expects a path'));
    return sttEngine().recognizeFile(file);
  });
  app.on('will-quit', () => { void engine?.release(); });
}
