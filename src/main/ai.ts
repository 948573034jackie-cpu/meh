import { ipcMain, BrowserWindow } from 'electron';
import type { ExplainRequest, AiEvent } from '@shared/api';
import type { AiProviderId } from '@shared/settings';

// Implemented in the AI step: streams explanations from Anthropic / OpenAI to the renderer as 'ai:event' messages.
export function registerAiHandlers(getWindow: () => BrowserWindow | null): void {
  const send = (ev: AiEvent) => getWindow()?.webContents.send('ai:event', ev);
  ipcMain.handle('ai:explain', async (_e, _req: ExplainRequest) => {
    const streamId = `s${Date.now()}`;
    setTimeout(() => send({ type: 'error', streamId, message: 'AI is not configured yet.', code: 'no_key' }), 0);
    return { streamId };
  });
  ipcMain.handle('ai:cancel', async () => undefined);
  ipcMain.handle('ai:test', async (_e, _provider: AiProviderId) => ({ ok: false, message: 'Not implemented yet' }));
  ipcMain.handle('ai:usage', async () => []);
}
