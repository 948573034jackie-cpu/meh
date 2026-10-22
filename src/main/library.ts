import { dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { Book, Position } from '@core/model';
import type { LibraryItem } from '@shared/settings';
import type { DictData } from '@shared/api';
import type { Dictionary } from '@core/dict/types';
import { JsonStore, booksDir, writeAtomic } from './storage';
import { loadTextModules } from './text-modules';
import { resourcesDir } from './paths';

const libraryStore = new JsonStore<{ items: LibraryItem[] }>('library', () => ({ items: [] }));

const gunzip = promisify(zlib.gunzip);

/*
 * The book and the dictionary go to the renderer as JSON text, not as objects: one string crosses IPC and the context
 * bridge in about 25-50 ms (plus 20-65 ms of JSON.parse in the page), the same data as objects in 300-700 ms, most of
 * it one long deep copy on the renderer's main thread (measured with a 7.6 MB book and the 7 MB dictionary). Reading and
 * unzipping are asynchronous, so the main process (Kokoro audio, AI text) is not blocked either.
 */

let dictJson: Promise<string> | null = null;
let dictData: Promise<DictData> | null = null;
let dictionary: Promise<Dictionary> | null = null;

/** The dictionary as JSON text (what dict:load sends), read and unzipped once. */
export function getDictJson(): Promise<string> {
  if (!dictJson) {
    dictJson = (async () => (await gunzip(await fs.promises.readFile(path.join(resourcesDir(), 'dict', 'dict.json.gz')))).toString('utf8'))();
    dictJson.catch(() => { dictJson = null; });
  }
  return dictJson;
}

/** The dictionary parsed, for the main process's own uses (levels of saved words, Progress, the hints job). */
export function getDictData(): Promise<DictData> {
  if (!dictData) {
    dictData = getDictJson().then((raw) => JSON.parse(raw) as DictData);
    dictData.catch(() => { dictData = null; });
  }
  return dictData;
}

export function getDictionary(): Promise<Dictionary> {
  if (!dictionary) {
    dictionary = (async () => (await loadTextModules()).createDictionary(await getDictData()))();
    dictionary.catch(() => { dictionary = null; });
  }
  return dictionary;
}

export function listLibrary(): LibraryItem[] {
  return [...libraryStore.get().items].sort((a, b) => (b.lastOpenedAt > a.lastOpenedAt ? 1 : -1));
}

function bookFile(id: string): string { return path.join(booksDir(), `${id}.json.gz`); }

/** The book read last, as JSON text and (when the hints job or an import asked) parsed: both read the book just opened. */
let lastBook: { id: string; json: Promise<string | null>; parsed: Promise<Book | null> | null } | null = null;

/** A stored book as JSON text, or null when it is not in the library. Does not count as opening it. */
export function readBookJson(id: string): Promise<string | null> {
  if (lastBook?.id === id) return lastBook.json;
  const json = (async () => {
    try { return (await gunzip(await fs.promises.readFile(bookFile(id)))).toString('utf8'); } catch { return null; }
  })();
  lastBook = { id, json, parsed: null };
  return json;
}

/** A stored book parsed (the hints job, imports), shared with the last readBookJson. Does not count as opening it. */
export function readBook(id: string): Promise<Book | null> {
  const json = readBookJson(id);
  const entry = lastBook!;
  if (!entry.parsed) {
    entry.parsed = json.then((raw) => {
      if (!raw) return null;
      try { return JSON.parse(raw) as Book; } catch { return null; }
    });
  }
  return entry.parsed;
}

function forgetBook(id: string): void { if (lastBook?.id === id) lastBook = null; }

/** The library list puts the books opened last first (the store writes it in the background). */
function touchBook(id: string): void {
  libraryStore.update((lib) => (lib.items.some((it) => it.id === id) ? { items: lib.items.map((it) => (it.id === id ? { ...it, lastOpenedAt: new Date().toISOString() } : it)) } : lib));
}

/** Opening a book (library:load): its JSON text for the renderer, which parses it; null when it is not in the library. */
export async function loadBook(id: string): Promise<string | null> {
  const json = await readBookJson(id);
  if (json) touchBook(id);
  return json;
}

export function removeBook(id: string): void {
  forgetBook(id);
  try { fs.unlinkSync(bookFile(id)); } catch { /* ignore */ }
  libraryStore.update((lib) => ({ items: lib.items.filter((it) => it.id !== id) }));
}

export function saveProgress(id: string, position: Position, percent: number): void {
  libraryStore.update((lib) => ({ items: lib.items.map((it) => (it.id === id ? { ...it, position, percent, lastOpenedAt: new Date().toISOString() } : it)) }));
}

async function finishImport(book: Book): Promise<Book> {
  const mods = await loadTextModules();
  const dict = await getDictionary();
  book.names = mods.detectNames(book, dict);
  forgetBook(book.id);
  writeAtomic(bookFile(book.id), zlib.gzipSync(Buffer.from(JSON.stringify(book), 'utf8')));
  const item: LibraryItem = {
    id: book.id, title: book.title, author: book.author, kind: book.source.kind,
    addedAt: book.source.importedAt, lastOpenedAt: new Date().toISOString(), position: null, percent: 0, words: book.stats.words,
  };
  libraryStore.update((lib) => ({ items: [...lib.items.filter((it) => it.id !== book.id), item] }));
  return book;
}

export async function importFile(filePath: string): Promise<Book> {
  const mods = await loadTextModules();
  const bytes = fs.readFileSync(filePath);
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const existing = await readBook(id);
  if (existing) { touchBook(id); return existing; }
  const ext = path.extname(filePath).toLowerCase();
  const importer = ext === '.epub' ? mods.importers.epub : ext === '.pdf' ? mods.importers.pdf : mods.importers.text;
  const ctx = { segmenter: mods.createSegmenter(), id, sourcePath: filePath };
  const book = await importer.importBytes(new Uint8Array(bytes), ctx);
  if (!book.title) book.title = path.basename(filePath, ext);
  return finishImport(book);
}

export async function importText(title: string, text: string): Promise<Book> {
  const mods = await loadTextModules();
  const id = createHash('sha256').update(text).digest('hex').slice(0, 24);
  const existing = await readBook(id);
  if (existing) { touchBook(id); return existing; }
  const book = await mods.textToBook(title || 'Pasted text', text, { segmenter: mods.createSegmenter(), id });
  return finishImport(book);
}

export async function importBookDialog(win: BrowserWindow | null): Promise<Book | null> {
  const opts: Electron.OpenDialogOptions = { title: 'Open a book', properties: ['openFile'], filters: [{ name: 'Books', extensions: ['epub', 'pdf', 'txt', 'md'] }] };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || res.filePaths.length === 0) return null;
  return importFile(res.filePaths[0]);
}

export function libraryFileFor(id: string): string | null { return fs.existsSync(bookFile(id)) ? bookFile(id) : null; }
