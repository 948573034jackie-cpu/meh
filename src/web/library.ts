/**
 * Library, books and dictionary for the web build: the pipeline of src/main/library.ts + text-modules.ts
 * (importer -> Book with segmentation -> detectNames) with books kept in IndexedDB ("books" store) and the
 * library list in the "kv" store. Ids are the first 24 hex chars of sha256, as on the Mac.
 */
import type { Book, Position } from '@core/model';
import type { LibraryItem } from '@shared/settings';
import type { DictData } from '@shared/api';
import type { Dictionary } from '@core/dict/types';
import type { Importer } from '@core/import/types';
import { createSegmenter } from '@core/segment';
import { textImporter, textToBook } from '@core/import/text';
import { createDictionary } from '@core/dict/dictionary';
import { detectNames } from '@core/dict/names';
import { KvDoc, idbGet, idbSet, idbDelete } from './idb';
import { sha256Hex } from './hash';

const libraryDoc = new KvDoc<{ items: LibraryItem[] }>('library', () => ({ items: [] }));

/** URL of the gzipped dictionary next to index.html (copied by scripts/build-web.mjs). */
export const DICT_URL = 'dict.json.gz';

let dictData: Promise<DictData> | null = null;
let dictionary: Promise<Dictionary> | null = null;

/** Inflates a gzip body with DecompressionStream; a body that is already JSON (server-side decoding) is read as is. */
async function readMaybeGzip(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return new TextDecoder().decode(buf);
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack the dictionary (DecompressionStream is missing; update Safari to 16.4 or later).');
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function getDictData(): Promise<DictData> {
  dictData ??= (async () => {
    const res = await fetch(DICT_URL);
    if (!res.ok) throw new Error(`The dictionary could not be loaded (HTTP ${res.status}).`);
    return JSON.parse(await readMaybeGzip(res)) as DictData;
  })();
  dictData.catch(() => { dictData = null; });
  return dictData;
}

export function getDictionary(): Promise<Dictionary> {
  dictionary ??= getDictData().then((d) => createDictionary(d));
  dictionary.catch(() => { dictionary = null; });
  return dictionary;
}

export async function listLibrary(): Promise<LibraryItem[]> {
  return [...(await libraryDoc.load()).items].sort((a, b) => (b.lastOpenedAt > a.lastOpenedAt ? 1 : -1));
}

/** Reads a stored book without touching lastOpenedAt (hints job). */
export async function readBook(id: string): Promise<Book | null> {
  try { return (await idbGet<Book>('books', id)) ?? null; } catch { return null; }
}

export async function loadBook(id: string): Promise<Book | null> {
  const book = await readBook(id);
  if (!book) return null;
  await libraryDoc.update((lib) => ({ items: lib.items.map((it) => (it.id === id ? { ...it, lastOpenedAt: new Date().toISOString() } : it)) }));
  return book;
}

export async function removeBook(id: string): Promise<void> {
  try { await idbDelete('books', id); } catch { /* ignore */ }
  await libraryDoc.update((lib) => ({ items: lib.items.filter((it) => it.id !== id) }));
}

export async function saveProgress(id: string, position: Position, percent: number): Promise<void> {
  await libraryDoc.update((lib) => ({ items: lib.items.map((it) => (it.id === id ? { ...it, position, percent, lastOpenedAt: new Date().toISOString() } : it)) }));
}

async function finishImport(book: Book): Promise<Book> {
  try { book.names = detectNames(book, await getDictionary()); } catch (e) { console.warn('[web] names not detected (no dictionary)', e); book.names ??= []; }
  try {
    await idbSet('books', book.id, book);
  } catch (e) {
    throw new Error(`The book could not be stored in this browser (${(e as Error).message}). Free some space or remove a book and try again.`);
  }
  const item: LibraryItem = {
    id: book.id, title: book.title, author: book.author, kind: book.source.kind,
    addedAt: book.source.importedAt, lastOpenedAt: new Date().toISOString(), position: null, percent: 0, words: book.stats.words,
  };
  await libraryDoc.update((lib) => ({ items: [...lib.items.filter((it) => it.id !== book.id), item] }));
  return book;
}

function extOf(name: string): string { const m = /\.[^./\\]+$/.exec(name); return m ? m[0].toLowerCase() : ''; }

async function importerFor(ext: string): Promise<Importer> {
  // EPUB and PDF importers are loaded on demand (pdf.js is large): separate chunks in dist/web
  if (ext === '.epub') return (await import('@core/import/epub')).epubImporter;
  if (ext === '.pdf') return (await import('@core/import/pdf')).pdfImporter;
  return textImporter;
}

export async function importBytes(name: string, bytes: Uint8Array): Promise<Book> {
  const id = (await sha256Hex(bytes)).slice(0, 24);
  const existing = await loadBook(id);
  if (existing) return existing;
  const ext = extOf(name);
  const importer = await importerFor(ext);
  const book = await importer.importBytes(bytes, { segmenter: createSegmenter(), id, sourcePath: name });
  if (!book.title) book.title = ext ? name.slice(0, -ext.length) : name;
  return finishImport(book);
}

export async function importText(title: string, text: string): Promise<Book> {
  const id = (await sha256Hex(text)).slice(0, 24);
  const existing = await loadBook(id);
  if (existing) return existing;
  const book = await textToBook(title || 'Pasted text', text, { segmenter: createSegmenter(), id });
  return finishImport(book);
}
