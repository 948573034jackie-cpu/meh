/**
 * The reader's small library: the TEXT of every imported book (never the original file), its title, and the place
 * where the learner stopped (chapter + paragraph + sentence). Kept in the page's IndexedDB; where that cannot be
 * opened, in the app's own storage (chrome.storage.local, keys "drBookShelf" and "drBook:<id>").
 */
import type { RawBook, RawChapter } from './epub';

export interface BookPlace { chapter: number; paragraph: number; sentence: number }
export interface ShelfBook {
  id: string;
  title: string;
  author: string;
  kind: 'epub' | 'pdf' | 'text' | 'web';
  addedAt: string;
  openedAt: string;
  /** the letters of each chapter (for the progress, without reading the text) */
  chapterChars: number[];
  chapterTitles: string[];
  place: BookPlace;
  /** how far, 0 … 100 */
  percent: number;
}
export interface StoredText { id: string; chapters: RawChapter[] }

export interface BookStore {
  list(): Promise<ShelfBook[]>;
  get(id: string): Promise<{ shelf: ShelfBook; text: StoredText } | null>;
  add(shelf: ShelfBook, text: StoredText): Promise<void>;
  update(shelf: ShelfBook): Promise<void>;
  remove(id: string): Promise<void>;
}

export const charsOf = (c: RawChapter): number => c.blocks.reduce((n, b) => n + b.text.length, 0);

export function shelfOf(id: string, kind: ShelfBook['kind'], raw: RawBook, now = new Date().toISOString()): ShelfBook {
  return {
    id, kind, title: raw.title, author: raw.author, addedAt: now, openedAt: now,
    chapterChars: raw.chapters.map(charsOf), chapterTitles: raw.chapters.map((c) => c.title),
    place: { chapter: 0, paragraph: 0, sentence: 0 }, percent: 0,
  };
}

/**
 * How far a place is in the book, 0 … 100: the letters before it over all the letters. `beforeInChapter` = the letters
 * of the chapter's paragraphs before the place.
 */
export function percentOf(chapterChars: readonly number[], chapter: number, beforeInChapter: number): number {
  const total = chapterChars.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let before = 0;
  for (let i = 0; i < chapter && i < chapterChars.length; i++) before += chapterChars[i];
  before += Math.max(0, Math.min(beforeInChapter, chapterChars[chapter] ?? 0));
  return Math.max(0, Math.min(100, Math.round((100 * before) / total)));
}

/** newest opened first */
export const sortShelf = (list: ShelfBook[]): ShelfBook[] => [...list].sort((a, b) => b.openedAt.localeCompare(a.openedAt) || a.title.localeCompare(b.title));

// ---- IndexedDB -------------------------------------------------------------------------------------------------
const DB = 'iknowBooks', SHELF = 'shelf', TEXTS = 'texts';
function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try { r = indexedDB.open(DB, 1); } catch (e) { reject(e as Error); return; }
    r.onupgradeneeded = () => { r.result.createObjectStore(SHELF, { keyPath: 'id' }); r.result.createObjectStore(TEXTS, { keyPath: 'id' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('no database'));
    r.onblocked = () => reject(new Error('database blocked'));
  });
}
const done = <T>(q: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error ?? new Error('database error')); });
const finished = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error('database error')); tx.onabort = () => reject(tx.error ?? new Error('database error')); });

function idbStore(db: IDBDatabase): BookStore {
  return {
    list: async () => sortShelf(await done(db.transaction(SHELF).objectStore(SHELF).getAll() as IDBRequest<ShelfBook[]>)),
    get: async (id) => {
      const tx = db.transaction([SHELF, TEXTS]);
      const [shelf, text] = await Promise.all([done(tx.objectStore(SHELF).get(id) as IDBRequest<ShelfBook | undefined>), done(tx.objectStore(TEXTS).get(id) as IDBRequest<StoredText | undefined>)]);
      return shelf && text ? { shelf, text } : null;
    },
    add: async (shelf, text) => { const tx = db.transaction([SHELF, TEXTS], 'readwrite'); tx.objectStore(SHELF).put(shelf); tx.objectStore(TEXTS).put(text); await finished(tx); },
    update: async (shelf) => { const tx = db.transaction(SHELF, 'readwrite'); tx.objectStore(SHELF).put(shelf); await finished(tx); },
    remove: async (id) => { const tx = db.transaction([SHELF, TEXTS], 'readwrite'); tx.objectStore(SHELF).delete(id); tx.objectStore(TEXTS).delete(id); await finished(tx); },
  };
}

// ---- the app's storage (when IndexedDB is not there) --------------------------------------------------------------
const SHELF_KEY = 'drBookShelf', TEXT_KEY = (id: string) => `drBook:${id}`;
function chromeStore(): BookStore {
  const area = () => chrome.storage.local;
  const shelf = async (): Promise<Record<string, ShelfBook>> => ({ ...(((await area().get(SHELF_KEY))[SHELF_KEY] as Record<string, ShelfBook> | undefined) ?? {}) });
  return {
    list: async () => sortShelf(Object.values(await shelf())),
    get: async (id) => {
      const s = (await shelf())[id];
      const t = (await area().get(TEXT_KEY(id)))[TEXT_KEY(id)] as StoredText | undefined;
      return s && t ? { shelf: s, text: t } : null;
    },
    add: async (s, text) => { await area().set({ [TEXT_KEY(s.id)]: text }); await area().set({ [SHELF_KEY]: { ...(await shelf()), [s.id]: s } }); },
    update: async (s) => { const all = await shelf(); if (all[s.id]) await area().set({ [SHELF_KEY]: { ...all, [s.id]: s } }); },
    remove: async (id) => { const all = await shelf(); delete all[id]; await area().set({ [SHELF_KEY]: all }); await area().remove(TEXT_KEY(id)); },
  };
}

let opened: Promise<BookStore> | null = null;
/** which one is used: 'idb' or 'app' (for the tests and the report) */
export let bookStoreKind = '';
export function bookStore(): Promise<BookStore> {
  opened ??= openDb().then((db) => { bookStoreKind = 'idb'; return idbStore(db); }, () => { bookStoreKind = 'app'; return chromeStore(); });
  return opened;
}
