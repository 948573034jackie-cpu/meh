import { app, ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import { SttEngine, type EngineStatus, type SttEngineEvent, type RecognizeResult } from './engine';

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
 * The preload bridge for these channels still needs to be added to src/preload/index.ts and src/shared/api.ts
 * (see docs/VOICE.md).
 */
let engine: SttEngine | null = null;

export function sttEngine(): SttEngine {
  if (!engine) {
    const userData = app.getPath('userData');
    engine = new SttEngine({ modelDir: process.env.STT_MODEL_DIR || path.join(userData, 'models', 'stt'), log: (m) => console.log(m) });
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
