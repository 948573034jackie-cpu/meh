/**
 * The voice's sound of short texts (a word said 3 times, a phrase, a Chinese meaning) kept on this computer
 * (IndexedDB of the extension), so the same word costs the cloud voice's characters only once, in every video.
 * At most MAX sounds are kept (the oldest go first); any failure here simply means "not kept".
 */
export interface CachedSound { b64: string; mime: string; timings: { start: number; end: number; charIndex: number; charLength: number }[] | null }

const DB = 'dreamVoice', STORE = 'sounds', MAX = 3000;
/** only short texts are worth keeping (an explanation is new every time) */
export const CACHE_MAX_CHARS = 80;

let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE); s.createIndex('at', 'at'); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    opening.catch(() => { opening = null; });
  }
  return opening;
}

export async function getSound(key: string): Promise<CachedSound | null> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const q = d.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => { const v = q.result as (CachedSound & { at: number }) | undefined; resolve(v ? { b64: v.b64, mime: v.mime, timings: v.timings } : null); };
      q.onerror = () => resolve(null);
    });
  } catch { return null; }
}

let puts = 0;
export async function putSound(key: string, sound: CachedSound): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ ...sound, at: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    if (++puts % 50 === 0) await prune(d);
  } catch { /* not kept */ }
}

/** the oldest sounds go when there are more than MAX */
async function prune(d: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - MAX;
      if (extra <= 0) return;
      const cur = store.index('at').openKeyCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c || extra-- <= 0) return; store.delete(c.primaryKey); c.continue(); };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
