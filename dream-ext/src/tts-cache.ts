/**
 * The voice's sound of short texts (a word said 3 times, a phrase, a Chinese meaning) kept on this computer
 * (IndexedDB of the extension), so the same word costs the cloud voice's characters only once, in every video.
 * At most MAX sounds are kept (the oldest go first); any failure here simply means "not kept".
 */
export interface CachedSound { b64: string; mime: string; timings: { start: number; end: number; charIndex: number; charLength: number }[] | null }

/**
 * What the background answers when Microsoft's free limit is full for the moment (bg.ts azureTurn). It is here because
 * both sides read it: the background says it, and the page's voice (voice.ts) knows by it that this sentence goes to
 * the device voice at once, with no second try.
 */
export const AZURE_BUSY = 'Microsoft is busy (free keys allow 19 requests a minute)';
/** what the background answers when the Speechify voice is done for today (the app's or the Worker's daily limit) */
export const SPEECHIFY_LIMIT = "Speechify: today's limit is reached, the free iPhone voice reads until tomorrow";

const DB = 'dreamVoice', STORE = 'sounds', MAX = 3000;
/** only short texts are worth keeping (an explanation is new every time) */
export const CACHE_MAX_CHARS = 80;
/**
 * The Speechify voice keeps EVERY clip it made (a whole sentence or paragraph of a book, an explanation), so the same
 * text is never paid twice: in their own store ('clips'), at most CLIPS_MAX of them (the oldest go first). A paragraph
 * is about 50-300 KB, so 600 clips stay well under 150 MB.
 */
const CLIPS = 'clips';
export const CLIPS_MAX = 600;

let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  // (the app's browser runs on other people's web pages: nothing of ours is ever kept in a site's own database)
  if ((globalThis as { __drLightBg?: boolean }).__drLightBg) return Promise.reject(new Error('no sound cache on a web page'));
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB, 2);
      r.onupgradeneeded = () => {
        const names = r.result.objectStoreNames;
        if (!names.contains(STORE)) r.result.createObjectStore(STORE).createIndex('at', 'at');
        if (!names.contains(CLIPS)) r.result.createObjectStore(CLIPS).createIndex('at', 'at');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    opening.catch(() => { opening = null; });
  }
  return opening;
}

/** `long`: the store of the Speechify clips (any length) */
export async function getSound(key: string, long = false): Promise<CachedSound | null> {
  try {
    const d = await db();
    const store = long ? CLIPS : STORE;
    return await new Promise((resolve) => {
      const q = d.transaction(store).objectStore(store).get(key);
      q.onsuccess = () => { const v = q.result as (CachedSound & { at: number }) | undefined; resolve(v ? { b64: v.b64, mime: v.mime, timings: v.timings } : null); };
      q.onerror = () => resolve(null);
    });
  } catch { return null; }
}

let puts = 0, longPuts = 0;
/** `long`: the store of the Speechify clips (any length) */
export async function putSound(key: string, sound: CachedSound, long = false): Promise<void> {
  try {
    const d = await db();
    const store = long ? CLIPS : STORE;
    await new Promise<void>((resolve) => {
      const tx = d.transaction(store, 'readwrite');
      tx.objectStore(store).put({ ...sound, at: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    if (long ? ++longPuts % 20 === 0 : ++puts % 50 === 0) await prune(d, store, long ? CLIPS_MAX : MAX);
  } catch { /* not kept */ }
}

/** the oldest sounds go when there are more than `max` */
async function prune(d: IDBDatabase, name: string, max: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const tx = d.transaction(name, 'readwrite');
    const store = tx.objectStore(name);
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - max;
      if (extra <= 0) return;
      const cur = store.index('at').openKeyCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c || extra-- <= 0) return; store.delete(c.primaryKey); c.continue(); };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
