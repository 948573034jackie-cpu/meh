/**
 * A tiny promise wrapper over IndexedDB: one database ("dream-read"), a few object stores keyed by
 * out-of-line string keys. Values are stored with the structured-clone algorithm (plain objects, arrays,
 * ArrayBuffers), so a Book is stored as it is, without JSON round trips.
 *
 * When IndexedDB is unavailable (some private-browsing modes) the stores fall back to memory, so the app
 * still runs for the session; nothing is kept after reload then.
 */
export const DB_NAME = 'dream-read';
export const DB_VERSION = 1;
export const STORES = ['kv', 'books', 'hints'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      console.warn('[web] IndexedDB unavailable; data is kept in memory only', e);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab upgraded the schema: let it proceed, reopen lazily next time
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { console.warn('[web] IndexedDB open failed; data is kept in memory only', req.error); resolve(null); };
    req.onblocked = () => console.warn('[web] IndexedDB upgrade blocked by another tab');
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  if (!db) throw new Error('no-idb');
  const t = db.transaction(store, mode);
  const result = wrap(fn(t.objectStore(store)));
  if (mode === 'readwrite') {
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted (storage full?)'));
    });
  }
  return result;
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  try { return (await tx(store, 'readonly', (s) => s.get(key))) as T | undefined; }
  catch (e) { if ((e as Error).message === 'no-idb') return memory.get(store)!.get(key) as T | undefined; throw e; }
}

export async function idbSet(store: StoreName, key: string, value: unknown): Promise<void> {
  try { await tx(store, 'readwrite', (s) => s.put(value, key)); }
  catch (e) { if ((e as Error).message === 'no-idb') { memory.get(store)!.set(key, value); return; } throw e; }
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  try { await tx(store, 'readwrite', (s) => s.delete(key)); }
  catch (e) { if ((e as Error).message === 'no-idb') { memory.get(store)!.delete(key); return; } throw e; }
}

export async function idbKeys(store: StoreName): Promise<string[]> {
  try { return ((await tx(store, 'readonly', (s) => s.getAllKeys())) as IDBValidKey[]).map(String); }
  catch (e) { if ((e as Error).message === 'no-idb') return [...memory.get(store)!.keys()]; throw e; }
}

/**
 * A JSON-like document kept in the "kv" store with an in-memory cache, the browser counterpart of
 * src/main/storage.ts JsonStore. load() must be awaited once before get(); writes are serialised.
 */
export class KvDoc<T> {
  private cache: T | null = null;
  private loading: Promise<T> | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private key: string, private defaults: () => T) {}

  load(): Promise<T> {
    if (this.cache) return Promise.resolve(this.cache);
    this.loading ??= idbGet<T>('kv', this.key)
      .catch((e) => { console.warn(`[web] could not read ${this.key}`, e); return undefined; })
      .then((stored) => {
        this.cache = stored && typeof stored === 'object' ? ({ ...this.defaults(), ...stored } as T) : this.defaults();
        return this.cache;
      });
    return this.loading;
  }

  async set(value: T): Promise<void> {
    this.cache = value;
    // structuredClone so later in-place edits of the cached object cannot race the write
    const snapshot = structuredClone(value);
    this.writing = this.writing.catch(() => undefined).then(() => idbSet('kv', this.key, snapshot));
    return this.writing;
  }

  async update(fn: (current: T) => T): Promise<T> {
    const next = fn(await this.load());
    await this.set(next);
    return next;
  }
}

/** Asks the browser not to evict our data (Safari honours it for home-screen apps). Best effort. */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
