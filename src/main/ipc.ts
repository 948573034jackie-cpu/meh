import { app, ipcMain, shell, BrowserWindow } from 'electron';
import type { Diagnostics, SecretName, VocabEntryInput, VocabEntryStatus } from '@shared/api';
import type { CefrLevel } from '@core/model';
import * as library from './library';
import * as settings from './settings';
import * as secrets from './secrets';
import * as vocabulary from './vocabulary';
import { registerAiHandlers } from './ai';
import { registerHintsHandlers } from './hints';
import { registerTtsHandlers } from './tts';
import { registerPowerIpc } from './power';
import { cpuInfo } from './cpu';
import { kokoroEngine } from './kokoro/ipc';
import { defaultSttThreads } from './stt/engine';
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

  // the book (library:load) and the dictionary cross as JSON text, about 10x faster than as objects; the page parses them
  ipcMain.handle('dict:load', () => library.getDictJson());

  ipcMain.handle('vocab:get', () => settings.getVocab());
  ipcMain.handle('vocab:setStatus', (_e, lemma: string, status) => settings.setWordStatus(lemma, status));
  ipcMain.handle('vocab:setMarked', (_e, bookId: string, ranges) => settings.setMarkedRanges(bookId, ranges));

  // My Vocabulary (src/main/vocabulary.ts); the dictionary gives levels and the Progress counts
  vocabulary.setDictionaryProvider(() => library.getDictData());
  ipcMain.handle('vocab:entries', () => vocabulary.listEntries());
  ipcMain.handle('vocab:upsertEntry', (_e, entry: VocabEntryInput) => vocabulary.upsertEntry(entry));
  ipcMain.handle('vocab:explained', (_e, entry: VocabEntryInput) => vocabulary.explained(entry));
  ipcMain.handle('vocab:setEntryStatus', (_e, lemma: string, status: VocabEntryStatus) => vocabulary.setEntryStatus(lemma, status));
  ipcMain.handle('vocab:deleteEntry', (_e, lemma: string) => vocabulary.deleteEntry(lemma));
  ipcMain.handle('vocab:exportCsv', () => {
    const file = vocabulary.writeCsv();
    shell.showItemInFolder(file);
    return file;
  });
  ipcMain.handle('vocab:csvPath', () => vocabulary.csvPath());
  ipcMain.handle('vocab:progress', () => vocabulary.getProgress());
  ipcMain.handle('vocab:unknownAtLevel', (_e, level: CefrLevel) => vocabulary.getUnknownAtLevel(level));

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
    // the speed facts that turn the estimates for the learner's Mac into numbers: the CPU, the threads, the voice's
    // real-time factor per segment (KokoroEngine.perf)
    let kokoro: Diagnostics['kokoro'];
    try { kokoro = kokoroEngine().perf(); } catch (e) { console.error('diagnostics: no Kokoro facts', e); }
    return {
      platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome,
      node: process.versions.node, appVersion: app.getVersion(), userData: app.getPath('userData'),
      secretsFile: secrets.secretsFilePath(), dictWords, secrets: secrets.secretStatus(),
      cpu: await cpuInfo(), sttThreads: defaultSttThreads(), kokoro,
    };
  });
  registerPowerIpc();

  registerAiHandlers(getWindow);
  registerHintsHandlers(getWindow);
  registerTtsHandlers();
}
