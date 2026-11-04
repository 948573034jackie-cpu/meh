/**
 * The background's side of the vocabulary database: every change of the words or the tests goes at once to the file.
 * On the Mac the helper (youtube-to-claude/native-host/) writes vocabulary.json and its iCloud Drive / Google Drive
 * copies; on the iPhone the app writes the folder you chose (VocabFile.swift, through the same messages). Before each
 * write the other copies are read and merged in, so the Mac and the phone share one database. drDbStatus says how it went.
 */
import type { VocabEntry } from '@shared/api';
import type { WordStatus } from '@shared/settings';
import { buildDoc, mergeDocs, sameDoc, isDoc, EMPTY_META, SEED_VERSION, type LevelMeta } from './level-db';
import { LEVEL_KEY, DB_STATUS_KEY, STORAGE_KEYS, ensureSeeded, applyDoc, getLevel, type DbStatus } from './store';
import { getDictionary } from './ai-client';
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
export function writeDatabase(): Promise<DbStatus> {
  const job = writing.then(async () => {
    const at = new Date().toISOString();
    let status: DbStatus;
    if (!haveFile()) status = { ok: false, at, noDevice: true, safari: isSafari(), error: 'no file on this device' };
    else {
      try {
        let doc = await currentDoc();
        let merged = 0;
        // the other devices' copy first (the file in iCloud Drive / Google Drive, or the folder chosen on the phone)
        const r0 = await ask({ type: 'read' }).catch(() => undefined);
        const others = (r0?.docs ?? []).filter(isDoc);
        if (others.length) {
          const all = mergeDocs(doc, others);
          if (!sameDoc(all, doc)) { merged = await applyDoc(all, await getDictionary()); doc = await currentDoc(); }
        }
        const r = await ask({ type: 'write', doc });
        status = {
          ok: !!r?.ok, at, path: r?.path, error: r?.error, merged,
          drive: r?.drive ?? null, driveOk: !!r?.driveOk, driveError: r?.driveError, icloud: r?.icloud ?? null, icloudOk: !!r?.icloudOk, icloudError: r?.icloudError,
          phone: !!r?.phone, shared: !!r?.shared, sharedOk: r?.sharedOk, sharedError: r?.sharedError, folder: r?.folder,
        };
      } catch (e) { status = { ok: false, at, error: (e as Error).message, notInstalled: /not found|forbidden/i.test((e as Error).message) }; }
    }
    await chrome.storage.local.set({ [DB_STATUS_KEY]: status });
    return status;
  });
  writing = job.catch(() => undefined);
  return job;
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function installLevelDb(): void {
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !(ch[LEVEL_KEY] || ch[STORAGE_KEYS.vocab] || ch[STORAGE_KEYS.entries])) return;
    // ("immediately": a burst of changes, a test's whole result, is one write)
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void writeDatabase(); }, 150);
  });
  // (the online copy comes back first: a reinstall keeps its words, and the starting data never overwrites them)
  void (async () => {
    if ((await getLevel()).seeded < SEED_VERSION) { await restoreFromOnline().catch(() => 0); await ensureSeeded(await getDictionary()); }
    await writeDatabase();
  })().catch((e) => console.warn('My Vocabulary: the database could not start', e));
}
