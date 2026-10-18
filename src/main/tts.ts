import { ipcMain } from 'electron';
import type { TtsEngineId } from '@shared/settings';

// Implemented in the voice step: cloud/neural voices synthesized in the main process.
export function registerTtsHandlers(): void {
  ipcMain.handle('tts:voices', async (_e, _engine: TtsEngineId) => []);
  ipcMain.handle('tts:synthesize', async () => { throw new Error('This voice engine is not available yet.'); });
}
