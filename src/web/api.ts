/**
 * The browser implementation of window.readalong (ReadAlongApi, src/shared/api.ts) used by the iPad / web
 * build. Everything the Electron main process does over IPC happens here, in the page: IndexedDB storage,
 * book import, the dictionary, AI calls, cloud voices and the hints job.
 *
 * Forward compatibility: the object is wrapped in a Proxy. A method the renderer calls that this file does
 * not implement yet (added to ReadAlongApi later) resolves harmlessly (undefined; `on*` subscriptions return
 * an unsubscribe function) and logs one warning per method name. The optional local speech-recognition
 * methods (stt*) are deliberately left undefined, because the renderer feature-detects them.
 */
import type { ReadAlongApi, KokoroStatus, Diagnostics } from '@shared/api';

import * as settings from './settings';
import * as secrets from './secrets';
import * as library from './library';
import * as vocabulary from './vocabulary';
import * as ai from './ai';
import * as tts from './tts';
import { hintsJob, onHintsProgress } from './hints';
import { tokenForFile, takeFile, pickFile, saveTextFile, FILE_TOKEN_PREFIX } from './files';

export const WEB_VERSION = '0.1.0-web';

const KOKORO_UNAVAILABLE: KokoroStatus = {
  state: 'error', variant: 'none', modelDir: '', downloadBytes: 0, progress: null,
  error: 'The Dream voice runs only in the Mac app; on iPad the built-in voices are used', queued: 0, version: '',
};

const noopUnsubscribe = (): (() => void) => () => undefined;

async function importPickedFile(file: File): Promise<import('@core/model').Book> {
  return library.importBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}

/** Every method of ReadAlongApi known when this file was written. */
export const webApiImpl = {
  // library
  importBookDialog: async () => {
    const file = await pickFile();
    return file ? importPickedFile(file) : null;
  },
  importFile: async (p: string) => {
    if (!p.startsWith(FILE_TOKEN_PREFIX)) throw new Error('Files can only be opened with the Open button or by dropping them here.');
    const file = takeFile(p);
    if (!file) throw new Error('The file is no longer available; open it again.');
    return importPickedFile(file);
  },
  pathForFile: (file: File) => tokenForFile(file),
  importText: (title: string, text: string) => library.importText(title, text),
  listLibrary: () => library.listLibrary(),
  loadBook: (id: string) => library.loadBook(id),
  removeBook: async (id: string) => { await library.removeBook(id); await hintsJob.clear(id); },
  saveProgress: (id, position, percent) => library.saveProgress(id, position, percent),
  // dictionary
  loadDictionary: () => library.getDictData(),
  // vocabulary
  getVocab: () => settings.getVocab(),
  setWordStatus: (lemma, status) => settings.setWordStatus(lemma, status),
  setMarkedRanges: (bookId, ranges) => settings.setMarkedRanges(bookId, ranges),
  vocabEntries: () => vocabulary.listEntries(),
  vocabUpsertEntry: (entry) => vocabulary.upsertEntry(entry),
  vocabSetEntryStatus: (lemma, status) => vocabulary.setEntryStatus(lemma, status),
  vocabDeleteEntry: (lemma) => vocabulary.deleteEntry(lemma),
  vocabExportCsv: async () => saveTextFile(vocabulary.CSV_FILE_NAME, vocabulary.toCsv(await vocabulary.listEntries()), 'text/csv'),
  vocabCsvPath: async () => `${vocabulary.CSV_FILE_NAME} (saved with Export)`,
  vocabProgress: () => vocabulary.getProgress(),
  vocabUnknownAtLevel: (level) => vocabulary.getUnknownAtLevel(level),
  // settings & secrets
  getSettings: () => settings.getSettings(),
  setSettings: (patch) => settings.setSettings(patch),
  setSecret: (name, value) => secrets.setSecret(name, value),
  hasSecret: (name) => secrets.hasSecret(name),
  secretStatus: () => secrets.secretStatus(),
  dismissLostKeys: async () => undefined,
  // AI
  aiExplain: (req) => ai.aiExplain(req),
  aiCancel: (id) => ai.aiCancel(id),
  aiTest: (provider) => ai.testProvider(provider),
  onAiEvent: (cb) => ai.onAiEvent(cb),
  getUsage: () => settings.getUsage(),
  // chapter hints
  hintsGet: (bookId, chapter) => hintsJob.get(String(bookId), Number(chapter)),
  // the web hints job (./hints) does not find phrases yet: the reader falls back to dictionary phrases
  hintsPhrases: async () => null,
  hintsRequest: (bookId, chapter) => hintsJob.request(String(bookId), Number(chapter)),
  hintsClear: (bookId) => hintsJob.clear(String(bookId)),
  onHintsProgress: (cb) => onHintsProgress(cb),
  // cloud TTS
  ttsListVoices: (engine) => tts.listVoices(engine),
  ttsSynthesize: (engine, text, voiceId, rate) => tts.synthesize(engine, text, voiceId, rate),
  // Kokoro: desktop only
  kokoroStatus: async () => ({ ...KOKORO_UNAVAILABLE }),
  kokoroDownload: async () => ({ ...KOKORO_UNAVAILABLE }),
  kokoroCancelDownload: async () => undefined,
  kokoroPrepare: async () => undefined,
  onKokoroProgress: () => noopUnsubscribe(),
  // misc
  getDiagnostics: async (): Promise<Diagnostics> => {
    let dictWords = 0;
    try { dictWords = Object.keys((await library.getDictData()).w).length; } catch { /* dictionary missing */ }
    let storage = '';
    try { const est = await navigator.storage?.estimate?.(); if (est?.usage != null) storage = ` (${Math.round(est.usage / 1_048_576)} MB used)`; } catch { /* unknown */ }
    return {
      platform: `web: ${navigator.userAgent}`, arch: (navigator as Navigator & { platform?: string }).platform ?? '', electron: 'none (web)', chrome: '',
      node: 'none (web)', appVersion: WEB_VERSION, userData: `IndexedDB "dream-read" on ${location.origin}${storage}`,
      secretsFile: 'IndexedDB "dream-read" / kv / secrets (stored unencrypted in this browser)', dictWords, secrets: await secrets.secretStatus(),
    };
  },
  openExternal: async (url: string) => { if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener'); },
  exportText: (fileName, contents) => saveTextFile(fileName, contents, /\.csv$/i.test(fileName) ? 'text/csv' : 'text/plain'),
  onMenu: () => noopUnsubscribe(),
} satisfies Partial<ReadAlongApi>;

const warned = new Set<string>();

/**
 * Optional methods the renderer feature-detects (`typeof api.sttStatus === 'function'`) and that cannot work in
 * a browser: they must stay absent so the renderer takes its own fallback (local speech recognition: "Talking by
 * voice needs the Mac app. You can type your question."). Any later stt* / onStt* method is treated the same.
 */
const ABSENT_OPTIONAL = /^(stt|onStt)[A-Z]/;

/** Wraps an implementation so methods it lacks resolve harmlessly (see the file comment). */
export function withFallback<T extends object>(impl: T): ReadAlongApi {
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
      // never look like a promise, and leave React/devtools probes alone
      if (prop === 'then' || prop === 'toJSON' || prop.startsWith('$$') || prop.startsWith('@@')) return undefined;
      if (ABSENT_OPTIONAL.test(prop)) return undefined;
      return (..._args: unknown[]) => {
        if (!warned.has(prop)) { warned.add(prop); console.warn(`[web] window.readalong.${prop}() is not available in the web version; ignored.`); }
        return prop.startsWith('on') ? () => undefined : Promise.resolve(undefined);
      };
    },
  }) as unknown as ReadAlongApi;
}

export function createWebApi(): ReadAlongApi { return withFallback(webApiImpl); }


