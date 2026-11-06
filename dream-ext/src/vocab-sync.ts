/**
 * My Vocabulary, also saved online: a compact copy (each word's status, the word, its Chinese meaning and level) in
 * chrome.storage.sync, which Chrome keeps in the learner's Google account (when Chrome sync is on) and brings back
 * after the extension is loaded again. The long explanations stay on this computer (sync has about 100 KB).
 * Runs in the background worker: every change of the vocabulary is copied a few seconds later.
 */
import type { VocabEntry } from '@shared/api';
import type { WordStatus } from '@shared/settings';
import { STORAGE_KEYS } from './store';

/** bytes per sync item, as Chrome counts it: the key plus the JSON of the value (the limit is 8,192) */
const ITEM_BYTES = 7600;
/** stay under the 102,400 bytes of chrome.storage.sync, counted as Chrome does (the JSON of the value, UTF-8) */
const MAX_TOTAL = 90_000;
const enc = new TextEncoder();
/** the bytes a text takes in chrome.storage.sync: a quote becomes two characters, a Chinese letter three bytes */
const syncBytes = (s: string): number => enc.encode(JSON.stringify(s)).length;
const META = 'drSyncMeta';
const PART = 'drSyncPart';

const CODE: Record<string, string> = { known: 'k', learning: 'l', ignored: 'i' };
const DECODE: Record<string, WordStatus> = { k: 'known', l: 'learning', i: 'ignored' };

/** lemma → [status code, word, Chinese, level] */
type Row = [string, string?, string?, string?];

export function packVocab(words: Record<string, WordStatus>, entries: Record<string, VocabEntry>): string {
  const rows: Record<string, Row> = {};
  for (const [lemma, st] of Object.entries(words)) if (CODE[st]) rows[lemma] = [CODE[st]];
  // the words with an explanation: the word as heard, its Chinese and level (newest first, while there is room)
  const list = Object.values(entries).sort((a, b) => String(b.lastSeenAt ?? b.createdAt ?? '').localeCompare(String(a.lastSeenAt ?? a.createdAt ?? '')));
  let size = syncBytes(JSON.stringify(rows));
  for (const e of list) {
    const r: Row = [CODE[e.status] ?? CODE[words[e.lemma]] ?? 'l', e.word, String(e.chinese ?? '').split(/[\n，,;；]/)[0].slice(0, 24), e.level ?? ''];
    const add = syncBytes(`${JSON.stringify(e.lemma)}:${JSON.stringify(r)},`) - 2;
    if (size + add > MAX_TOTAL) break;
    rows[e.lemma] = r;
    size += add;
  }
  return JSON.stringify(rows);
}

export function unpackVocab(text: string): { words: Record<string, WordStatus>; entries: Record<string, Pick<VocabEntry, 'lemma' | 'word' | 'chinese' | 'level' | 'status'>> } {
  const rows = JSON.parse(text) as Record<string, Row>;
  const words: Record<string, WordStatus> = {};
  const entries: Record<string, Pick<VocabEntry, 'lemma' | 'word' | 'chinese' | 'level' | 'status'>> = {};
  for (const [lemma, r] of Object.entries(rows)) {
    const st = DECODE[r[0]];
    if (!st) continue;
    words[lemma] = st;
    if (r[1]) entries[lemma] = { lemma, word: r[1], chinese: r[2] ?? '', level: (r[3] || undefined) as VocabEntry['level'], status: st === 'known' ? 'known' : 'learning' };
  }
  return { words, entries };
}

/** The text in parts that each fit one sync item: a quote in the text takes two bytes there, a Chinese letter three. */
export function cutParts(text: string, max = ITEM_BYTES): Record<string, string> {
  const size = (key: string, s: string) => key.length + syncBytes(s);
  // (never between the two halves of one character, an emoji: each half alone would come back broken)
  const whole = (p: number, l: number) => (l > 1 && p + l < text.length && /[\uD800-\uDBFF]/.test(text[p + l - 1]) ? l - 1 : l);
  const parts: Record<string, string> = {};
  let pos = 0;
  for (let i = 0; pos < text.length; i++) {
    const key = `${PART}${i}`;
    let len = Math.min(text.length - pos, max);
    while (len > 1 && size(key, text.slice(pos, pos + len)) > max) len = Math.max(1, Math.floor(len * 0.9));
    // (as long as it still fits: a little more)
    while (pos + len < text.length && size(key, text.slice(pos, pos + len + 64)) <= max) len += 64;
    len = whole(pos, len);
    parts[key] = text.slice(pos, pos + len);
    pos += len;
  }
  return parts;
}

/** copies the vocabulary to chrome.storage.sync (in parts) */
export async function saveOnline(): Promise<{ words: number; bytes: number } | null> {
  if (!chrome.storage?.sync) return null;
  const o = await chrome.storage.local.get([STORAGE_KEYS.vocab, STORAGE_KEYS.entries]);
  const words = ((o[STORAGE_KEYS.vocab] as { words?: Record<string, WordStatus> } | undefined)?.words) ?? {};
  const entries = (o[STORAGE_KEYS.entries] as Record<string, VocabEntry> | undefined) ?? {};
  const text = packVocab(words, entries);
  const parts = cutParts(text);
  const n = Object.keys(parts).length;
  const old = (await chrome.storage.sync.get(META))[META] as { n?: number } | undefined;
  await chrome.storage.sync.set({ ...parts, [META]: { n, at: new Date().toISOString(), words: Object.keys(words).length } });
  const stale = [];
  for (let i = n; i < (old?.n ?? 0); i++) stale.push(`${PART}${i}`);
  if (stale.length) await chrome.storage.sync.remove(stale);
  return { words: Object.keys(words).length, bytes: text.length };
}

/** the online copy, or null */
export async function loadOnline(): Promise<ReturnType<typeof unpackVocab> & { at: string } | null> {
  if (!chrome.storage?.sync) return null;
  const meta = (await chrome.storage.sync.get(META))[META] as { n?: number; at?: string } | undefined;
  if (!meta?.n) return null;
  const keys = Array.from({ length: meta.n }, (_, i) => `${PART}${i}`);
  const got = await chrome.storage.sync.get(keys);
  const text = keys.map((k) => String(got[k] ?? '')).join('');
  try { return { ...unpackVocab(text), at: meta.at ?? '' }; } catch { return null; }
}

/**
 * A fresh install (no words on this computer) gets the words back from the online copy: their statuses, and for the
 * explained ones the word, Chinese and level (the long explanations were only on the old computer / install).
 */
export async function restoreFromOnline(): Promise<number> {
  const o = await chrome.storage.local.get([STORAGE_KEYS.vocab, STORAGE_KEYS.entries]);
  const have = Object.keys(((o[STORAGE_KEYS.vocab] as { words?: object } | undefined)?.words) ?? {}).length + Object.keys((o[STORAGE_KEYS.entries] as object | undefined) ?? {}).length;
  if (have) return 0;
  const on = await loadOnline();
  if (!on || !Object.keys(on.words).length) return 0;
  const now = new Date().toISOString();
  const entries: Record<string, unknown> = {};
  for (const e of Object.values(on.entries)) entries[e.lemma] = { ...e, sentence: '', explanation: '', bookId: '', bookTitle: '', chapter: '', position: null, createdAt: now, lastSeenAt: now, timesExplained: 1, again: 0 } satisfies VocabEntry;
  await chrome.storage.local.set({ [STORAGE_KEYS.vocab]: { words: on.words, marked: {} }, [STORAGE_KEYS.entries]: entries });
  return Object.keys(on.words).length;
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** the background worker: every vocabulary change is saved online a few seconds later */
export function installVocabSync(): void {
  void restoreFromOnline().catch(() => 0);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !(ch[STORAGE_KEYS.vocab] || ch[STORAGE_KEYS.entries])) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void saveOnline().catch((e) => console.warn('My Vocabulary: online copy not saved', e)); }, 3000);
  });
}
