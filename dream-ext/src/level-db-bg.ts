/**
 * The background's side of the vocabulary database: every change of the words or the tests goes at once to the file.
 * On the Mac the helper (youtube-to-claude/native-host/) writes vocabulary.json and its iCloud Drive / Google Drive
 * copies; on the iPhone the app writes the folder you chose (VocabFile.swift, through the same messages). Before each
 * write the other copies are read and merged in, so the Mac and the phone share one database. drDbStatus says how it went.
 */
import type { VocabEntry } from '@shared/api';
import type { WordStatus } from '@shared/settings';
import { buildDoc, mergeDocs, isDoc, sameDoc, itemId, EMPTY_META, SEED_VERSION, type LevelMeta, type VocabularyDoc } from './level-db';
import { LEVEL_KEY, DB_STATUS_KEY, STORAGE_KEYS, ensureSeeded, applyDoc, getLevel, type DbStatus } from './store';

/** what this device and the shared file both had at the last merge (so only the other device's changes come in) */
const BASE_KEY = 'drDbBase';
import { getDictionary } from './ai-client';
import { findGist, createGist, readGist, writeGist, GIST_STATE_KEY, type GistState } from './gist-sync';
import { getKeys } from './store';
import { restoreFromOnline } from './vocab-sync';

export const NATIVE_HOST = 'com.meh.english_vocab';

export async function currentDoc() {
  const o = await chrome.storage.local.get([LEVEL_KEY, STORAGE_KEYS.vocab, STORAGE_KEYS.entries]);
  const words = (o[STORAGE_KEYS.vocab] as { words?: Record<string, WordStatus> } | undefined)?.words ?? {};
  return buildDoc((o[LEVEL_KEY] as LevelMeta | undefined) ?? EMPTY_META, words, (o[STORAGE_KEYS.entries] as Record<string, VocabEntry> | undefined) ?? {});
}

let writing: Promise<unknown> = Promise.resolve();
interface HelperReply {
  ok?: boolean; path?: string; error?: string; docs?: unknown[];
  drive?: string | null; driveOk?: boolean; driveError?: string; icloud?: string | null; icloudOk?: boolean; icloudError?: string;
  phone?: boolean; shared?: boolean; sharedOk?: boolean; sharedError?: string; folder?: string;
}
const isSafari = (): boolean => !!(self as unknown as { __ytcSafari?: boolean }).__ytcSafari;
/** the Mac helper or the app can write the file (Safari's extension cannot) */
const haveFile = (): boolean => typeof chrome.runtime.sendNativeMessage === 'function' && !isSafari();
const ask = (msg: Record<string, unknown>): Promise<HelperReply | undefined> => chrome.runtime.sendNativeMessage(NATIVE_HOST, msg) as Promise<HelperReply | undefined>;

/** the other copies merged in, then the database to the file; one write after the other */
/** the starting data is going in: no merge may read the database half-way through it */
let starting: Promise<unknown> = Promise.resolve();

export function writeDatabase(): Promise<DbStatus> {
  const job = writing.then(() => starting).then(async () => {
    const at = new Date().toISOString();
    let status: DbStatus;
    let oldHelper = false;
    if (!haveFile()) status = { ok: false, at, noDevice: true, safari: isSafari(), error: 'no file on this device' };
    else {
      try {
        let doc: VocabularyDoc = await currentDoc();
        let merged = 0;
        // the other device's copy first (the file in iCloud Drive / Google Drive, or the folder chosen on the phone)
        const r0 = await ask({ type: 'read' }).catch(() => undefined);
        oldHelper = !!r0 && r0.ok === false && /unknown message/i.test(r0.error ?? '');
        const others = (r0?.docs ?? []).filter(isDoc);
        if (others.length) {
          const o = await chrome.storage.local.get([BASE_KEY, STORAGE_KEYS.vocab, LEVEL_KEY, STORAGE_KEYS.entries]);
          const base = isDoc(o[BASE_KEY]) ? o[BASE_KEY] : null;
          // (the words ignored on this device: never taken from the file, and taken out of it)
          const words = (o[STORAGE_KEYS.vocab] as { words?: Record<string, WordStatus> } | undefined)?.words ?? {};
          const meta = (o[LEVEL_KEY] as LevelMeta | undefined) ?? EMPTY_META, entries = (o[STORAGE_KEYS.entries] as Record<string, VocabEntry> | undefined) ?? {};
          const ignored = new Set(Object.keys(words).filter((k) => words[k] === 'ignored').map((k) => itemId(meta.log?.[k]?.word || entries[k]?.word || k)));
          const all = mergeDocs(doc, others, base, ignored);
          merged = await applyDoc(all, await getDictionary());
          doc = { ...(await currentDoc()), ...(all.doc.removed ? { removed: all.doc.removed } : {}) };
        }
        const r = await ask({ type: 'write', doc });
        // (the last merged copy moves on only when a shared copy was really read or written: the phone with no folder
        // chosen writes only its own copy, and its words must still count as its own changes at the first merge)
        if (r?.ok && (others.length > 0 || !r.phone || r.sharedOk === true)) await chrome.storage.local.set({ [BASE_KEY]: doc });
        status = {
          ok: !!r?.ok, at, path: r?.path, error: r?.error, merged, ...(oldHelper ? { oldHelper } : {}),
          drive: r?.drive ?? null, driveOk: !!r?.driveOk, driveError: r?.driveError, icloud: r?.icloud ?? null, icloudOk: !!r?.icloudOk, icloudError: r?.icloudError,
          phone: !!r?.phone, shared: !!r?.shared, sharedOk: r?.sharedOk, sharedError: r?.sharedError, folder: r?.folder,
        };
      } catch (e) { status = { ok: false, at, error: (e as Error).message, notInstalled: /not found|forbidden/i.test((e as Error).message) }; }
    }
    // the online copy (a private GitHub gist), when a token is saved
    status = { ...status, ...(await gistPass()) };
    await chrome.storage.local.set({ [DB_STATUS_KEY]: status });
    return status;
  });
  writing = job.catch(() => undefined);
  return job;
}

/** what this device and the gist both had at their last merge (its own: the gist and the file are merged apart) */
const GIST_BASE_KEY = 'drDbBaseGist';
/**
 * The online copy, one more "other device": read (free when it did not change: the ETag), merged three-way like the
 * shared file (only the other device's changes come in), and written back when this device has something new.
 */
async function gistPass(): Promise<Pick<DbStatus, 'gist' | 'gistOk' | 'gistError' | 'gistMerged' | 'gistAt'>> {
  const token = (await getKeys()).github?.trim();
  // (no token: nothing at all; the app's settings sheet does not sync, the YouTube window does)
  if (!token || (self as unknown as { location?: Location }).location?.protocol === 'ytlearn:') return {};
  const gistAt = new Date().toISOString();
  try {
    const o = await chrome.storage.local.get([GIST_STATE_KEY, GIST_BASE_KEY, STORAGE_KEYS.vocab, LEVEL_KEY, STORAGE_KEYS.entries]);
    const st = (o[GIST_STATE_KEY] as GistState | undefined) ?? {};
    let base = isDoc(o[GIST_BASE_KEY]) ? o[GIST_BASE_KEY] as VocabularyDoc : null;
    let doc: VocabularyDoc = await currentDoc();
    let id = st.id ?? (await findGist(token)) ?? undefined;
    if (!id) {
      id = await createGist(token, doc);
      await chrome.storage.local.set({ [GIST_STATE_KEY]: { id, at: gistAt } satisfies GistState, [GIST_BASE_KEY]: doc });
      return { gist: true, gistOk: true, gistMerged: 0, gistAt };
    }
    let r;
    try { r = await readGist(token, id, base ? st.etag : undefined); }
    catch (e) {
      // (the gist was deleted: a new one is made next time)
      if ((e as { status?: number }).status === 404) await chrome.storage.local.set({ [GIST_STATE_KEY]: {} });
      throw e;
    }
    let merged = 0;
    let etag = r.etag;
    if (r.changed && r.doc) {
      const words = (o[STORAGE_KEYS.vocab] as { words?: Record<string, WordStatus> } | undefined)?.words ?? {};
      const meta = (o[LEVEL_KEY] as LevelMeta | undefined) ?? EMPTY_META, entries = (o[STORAGE_KEYS.entries] as Record<string, VocabEntry> | undefined) ?? {};
      const ignored = new Set(Object.keys(words).filter((k) => words[k] === 'ignored').map((k) => itemId(meta.log?.[k]?.word || entries[k]?.word || k)));
      const all = mergeDocs(doc, [r.doc], base, ignored);
      merged = await applyDoc(all, await getDictionary());
      doc = { ...(await currentDoc()), ...(all.doc.removed ? { removed: all.doc.removed } : {}) };
      // (nothing new here for the gist (the same words, statuses and tests): it stays as it is)
      if (sameDoc(doc, r.doc)) { base = r.doc; await chrome.storage.local.set({ [GIST_STATE_KEY]: { id, etag, at: gistAt } satisfies GistState, [GIST_BASE_KEY]: doc }); return { gist: true, gistOk: true, gistMerged: merged, gistAt }; }
    } else if (base && sameDoc(doc, base)) {
      // (neither side changed)
      return { gist: true, gistOk: true, gistMerged: 0, gistAt };
    }
    // (the words taken out here since the last merge go to the gist as taken out, so the other device drops them too)
    if (base) {
      const words = (o[STORAGE_KEYS.vocab] as { words?: Record<string, WordStatus> } | undefined)?.words ?? {};
      const meta = (o[LEVEL_KEY] as LevelMeta | undefined) ?? EMPTY_META, entries = (o[STORAGE_KEYS.entries] as Record<string, VocabEntry> | undefined) ?? {};
      const ignored = new Set(Object.keys(words).filter((k) => words[k] === 'ignored').map((k) => itemId(meta.log?.[k]?.word || entries[k]?.word || k)));
      const gone = mergeDocs(doc, [], base, ignored).doc.removed;
      if (gone?.length) doc = { ...doc, removed: [...new Map([...(doc.removed ?? []), ...gone].map((x) => [itemId(x.item), x])).values()] };
    }
    etag = await writeGist(token, id, doc);
    await chrome.storage.local.set({ [GIST_STATE_KEY]: { id, etag, at: gistAt } satisfies GistState, [GIST_BASE_KEY]: doc });
    return { gist: true, gistOk: true, gistMerged: merged, gistAt };
  } catch (e) {
    return { gist: true, gistOk: false, gistError: (e as Error).message, gistAt };
  }
}

/** a look at the online copy only (every few seconds while the app is open): nothing is written unless something changed */
export function syncGist(): Promise<unknown> {
  const job = writing.then(async () => {
    const g = await gistPass();
    if (!g.gist) return;
    const o = await chrome.storage.local.get(DB_STATUS_KEY);
    await chrome.storage.local.set({ [DB_STATUS_KEY]: { ...((o[DB_STATUS_KEY] as DbStatus | undefined) ?? { ok: false, at: g.gistAt }), ...g } });
  });
  writing = job.catch(() => undefined);
  return job;
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function installLevelDb(): void {
  chrome.storage.onChanged.addListener((ch, area) => {
    // (a GitHub token saved or changed: the online copy is joined at once)
    if (area !== 'local' || !(ch[LEVEL_KEY] || ch[STORAGE_KEYS.vocab] || ch[STORAGE_KEYS.entries] || ch.drKeys)) return;
    // ("immediately": a burst of changes, a test's whole result, is one write)
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void writeDatabase(); }, 150);
  });
  // (the online copy comes back first: a reinstall keeps its words, and the starting data never overwrites them)
  starting = (async () => {
    const before = (await getLevel()).seeded;
    if (before < SEED_VERSION) {
      const o = await chrome.storage.local.get(STORAGE_KEYS.vocab);
      const had = Object.keys(((o[STORAGE_KEYS.vocab] as { words?: object } | undefined)?.words) ?? {}).length;
      const restored = await restoreFromOnline().catch(() => 0);
      const seeded = await ensureSeeded(await getDictionary());
      // (a new, empty install: the starting data is not "this device's change". Without a last merged copy the shared
      // file's newer statuses would lose to it; with this one they come in as the other device's changes. Not on an
      // update or after a restore: those words are the learner's own decisions.)
      if (seeded && before === 0 && !had && !restored && !isDoc((await chrome.storage.local.get(BASE_KEY))[BASE_KEY])) await chrome.storage.local.set({ [BASE_KEY]: await currentDoc() });
    }
  })().catch((e) => console.warn('My Vocabulary: the database could not start', e));
  void starting.then(() => writeDatabase());
}
