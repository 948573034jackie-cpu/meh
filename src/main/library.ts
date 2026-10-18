import { dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import type { Book, Position } from '@core/model';
import type { LibraryItem } from '@shared/settings';
import type { DictData } from '@shared/api';
import type { Dictionary } from '@core/dict/types';
import { JsonStore, booksDir, writeAtomic, readJsonFile } from './storage';
import { loadTextModules } from './text-modules';
import { resourcesDir } from './paths';

const libraryStore = new JsonStore<{ items: LibraryItem[] }>('library', () => ({ items: [] }));

let dictData: DictData | null = null;
let dictionary: Dictionary | null = null;

export async function getDictData(): Promise<DictData> {
  if (dictData) return dictData;
  const file = path.join(resourcesDir(), 'dict', 'dict.json.gz');
  const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  dictData = JSON.parse(raw) as DictData;
  return dictData;
}

export async function getDictionary(): Promise<Dictionary> {
  if (dictionary) return dictionary;
  const mods = await loadTextModules();
  dictionary = mods.createDictionary(await getDictData());
  return dictionary;
}

export function listLibrary(): LibraryItem[] {
  return [...libraryStore.get().items].sort((a, b) => (b.lastOpenedAt > a.lastOpenedAt ? 1 : -1));
}

function bookFile(id: string): string { return path.join(booksDir(), `${id}.json.gz`); }

export function loadBook(id: string): Book | null {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(bookFile(id))).toString('utf8');
    const book = JSON.parse(raw) as Book;
    libraryStore.update((lib) => ({ items: lib.items.map((it) => (it.id === id ? { ...it, lastOpenedAt: new Date().toISOString() } : it)) }));
    return book;
  } catch {
    return null;
  }
}

export function removeBook(id: string): void {
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
  const existing = loadBook(id);
  if (existing) return existing;
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
  const existing = loadBook(id);
  if (existing) return existing;
  const book = await mods.textToBook(title || 'Pasted text', text, { segmenter: mods.createSegmenter(), id });
  return finishImport(book);
}

export async function importBookDialog(win: BrowserWindow | null): Promise<Book | null> {
  const res = await dialog.showOpenDialog(win ?? undefined as never, {
    title: 'Open a book',
    properties: ['openFile'],
    filters: [{ name: 'Books', extensions: ['epub', 'pdf', 'txt', 'md'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return importFile(res.filePaths[0]);
}

export function libraryFileFor(id: string): string | null { return readJsonFile(bookFile(id)) ? bookFile(id) : null; }
