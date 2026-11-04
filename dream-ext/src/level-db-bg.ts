/**
 * The background's side of the vocabulary database: every change of the words or the tests goes at once to the helper
 * on the Mac (youtube-to-claude/native-host/), which writes vocabulary.json and its Google Drive copy. drDbStatus says how that went.
 */
import type { VocabEntry } from '@shared/api';
import type { WordStatus } from '@shared/settings';
import { buildDoc, EMPTY_META, SEED_VERSION, type LevelMeta } from './level-db';
import { LEVEL_KEY, DB_STATUS_KEY, STORAGE_KEYS, ensureSeeded, getLevel, type DbStatus } from './store';
import { getDictionary } from './ai-client';
import { restoreFromOnline } from './vocab-sync';

export const NATIVE_HOST = 'com.meh.english_vocab';

export async function currentDoc() {
  const o = await chrome.storage.local.get([LEVEL_KEY, STORAGE_KEYS.vocab, STORAGE_KEYS.entries]);
  const words = (o[STORAGE_KEYS.vocab] as { words?: Record<string, WordStatus> } | undefined)?.words ?? {};
  return buildDoc((o[LEVEL_KEY] as LevelMeta | undefined) ?? EMPTY_META, words, (o[STORAGE_KEYS.entries] as Record<string, VocabEntry> | undefined) ?? {});
}

let writing: Promise<unknown> = Promise.resolve();
/** the database to the helper, one write after the other */
export function writeDatabase(): Promise<DbStatus> {
  const job = writing.then(async () => {
    const at = new Date().toISOString();
    let status: DbStatus;
    if (!chrome.runtime.sendNativeMessage) status = { ok: false, at, noDevice: true, error: 'no helper on this device' };
    else {
      try {
        const r = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'write', doc: await currentDoc() }) as { ok: boolean; path?: string; drive?: string | null; driveOk?: boolean; driveError?: string; error?: string };
        status = { ok: !!r?.ok, at, path: r?.path, drive: r?.drive ?? null, driveOk: !!r?.driveOk, driveError: r?.driveError, error: r?.error };
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
