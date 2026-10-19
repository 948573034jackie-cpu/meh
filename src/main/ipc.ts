import { app, ipcMain, shell, BrowserWindow } from 'electron';
import type { Diagnostics, SecretName } from '@shared/api';
import * as library from './library';
import * as settings from './settings';
import * as secrets from './secrets';
import { registerAiHandlers } from './ai';
import { registerTtsHandlers } from './tts';
import { exportDir } from './paths';
import { writeAtomic } from './storage';
import path from 'node:path';

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('library:importDialog', () => library.importBookDialog(getWindow()));
  ipcMain.handle('library:importFile', (_e, p: string) => library.importFile(p));
  ipcMain.handle('library:importText', (_e, title: string, text: string) => library.importText(title, text));
  ipcMain.handle('library:list', () => library.listLibrary());
  ipcMain.handle('library:load', (_e, id: string) => library.loadBook(id));
  ipcMain.handle('library:remove', (_e, id: string) => library.removeBook(id));
  ipcMain.handle('library:progress', (_e, id: string, pos, pct: number) => library.saveProgress(id, pos, pct));

  ipcMain.handle('dict:load', () => library.getDictData());

  ipcMain.handle('vocab:get', () => settings.getVocab());
  ipcMain.handle('vocab:setStatus', (_e, lemma: string, status) => settings.setWordStatus(lemma, status));
  ipcMain.handle('vocab:setMarked', (_e, bookId: string, ranges) => settings.setMarkedRanges(bookId, ranges));

  ipcMain.handle('settings:get', () => settings.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => settings.setSettings(patch));
  ipcMain.handle('secrets:set', (_e, name: SecretName, value: string) => secrets.setSecret(name, value));
  ipcMain.handle('secrets:has', (_e, name: SecretName) => secrets.hasSecret(name));
  ipcMain.handle('secrets:status', () => secrets.secretStatus());
  ipcMain.handle('secrets:dismissLost', () => secrets.dismissLostKeys());

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('app:exportText', (_e, fileName: string, contents: string) => {
    const safe = String(fileName).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'export.txt';
    const file = path.join(exportDir(), safe);
    writeAtomic(file, contents);
    shell.showItemInFolder(file);
    return file;
  });
  ipcMain.handle('app:diagnostics', async (): Promise<Diagnostics> => {
    let dictWords = 0;
    try { dictWords = Object.keys((await library.getDictData()).w).length; } catch { /* dictionary missing */ }
    return {
      platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome,
      node: process.versions.node, appVersion: app.getVersion(), userData: app.getPath('userData'),
      secretsFile: secrets.secretsFilePath(), dictWords, secrets: secrets.secretStatus(),
    };
  });

  registerAiHandlers(getWindow);
  registerTtsHandlers();
}
