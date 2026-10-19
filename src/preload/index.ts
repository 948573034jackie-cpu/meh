import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ReadAlongApi } from '@shared/api';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: ReadAlongApi = {
  importBookDialog: () => invoke('library:importDialog'),
  importFile: (p) => invoke('library:importFile', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  importText: (title, text) => invoke('library:importText', title, text),
  listLibrary: () => invoke('library:list'),
  loadBook: (id) => invoke('library:load', id),
  removeBook: (id) => invoke('library:remove', id),
  saveProgress: (id, position, percent) => invoke('library:progress', id, position, percent),
  loadDictionary: () => invoke('dict:load'),
  getVocab: () => invoke('vocab:get'),
  setWordStatus: (lemma, status) => invoke('vocab:setStatus', lemma, status),
  setMarkedRanges: (bookId, ranges) => invoke('vocab:setMarked', bookId, ranges),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  setSecret: (name, value) => invoke('secrets:set', name, value),
  hasSecret: (name) => invoke('secrets:has', name),
  secretStatus: () => invoke('secrets:status'),
  dismissLostKeys: () => invoke('secrets:dismissLost'),
  aiExplain: (req) => invoke('ai:explain', req),
  aiCancel: (id) => invoke('ai:cancel', id),
  aiTest: (provider) => invoke('ai:test', provider),
  onAiEvent: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: Parameters<typeof cb>[0]) => cb(ev);
    ipcRenderer.on('ai:event', handler);
    return () => ipcRenderer.removeListener('ai:event', handler);
  },
  getUsage: () => invoke('ai:usage'),
  ttsListVoices: (engine) => invoke('tts:voices', engine),
  ttsSynthesize: (engine, text, voiceId, rate) => invoke('tts:synthesize', engine, text, voiceId, rate),
  kokoroStatus: () => invoke('kokoro:status'),
  kokoroDownload: () => invoke('kokoro:download'),
  kokoroCancelDownload: () => invoke('kokoro:cancelDownload'),
  kokoroPrepare: (items) => invoke('kokoro:prepare', items),
  onKokoroProgress: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, s: Parameters<typeof cb>[0]) => cb(s);
    ipcRenderer.on('kokoro:progress', handler);
    return () => ipcRenderer.removeListener('kokoro:progress', handler);
  },
  getDiagnostics: () => invoke('app:diagnostics'),
  openExternal: (url) => invoke('app:openExternal', url),
  exportText: (fileName, contents) => invoke('app:exportText', fileName, contents),
  onMenu: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, action: string) => cb(action);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },
};

contextBridge.exposeInMainWorld('readalong', api);
