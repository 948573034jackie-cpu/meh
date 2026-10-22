/**
 * My Vocabulary for the web build: a port of the pure parts of src/main/vocabulary.ts (merge rules, CSV,
 * Progress numbers) over an IndexedDB document. The Mac app mirrors the list to a CSV file in Documents
 * after every change; a browser cannot write files on its own, so here the CSV is produced on demand and
 * handed to the share sheet / downloads (see files.ts).
 */
import type { CefrLevel } from '@core/model';
import { CEFR_LEVELS } from '@core/model';
import type { DictData, VocabEntry, VocabEntryInput, VocabEntryStatus, VocabProgress, LevelProgress, UnknownWord } from '@shared/api';
import type { VocabState } from '@shared/settings';
import { KvDoc } from './idb';
import * as settings from './settings';
import { getDictData } from './library';

export interface VocabularyFile { version: 1; entries: Record<string, VocabEntry> }
const store = new KvDoc<VocabularyFile>('vocabulary', () => ({ version: 1, entries: {} }));

export const CSV_FILE_NAME = 'my-vocabulary.csv';

export async function listEntries(): Promise<VocabEntry[]> {
  return Object.values((await store.load()).entries).sort((a, b) => (b.lastSeenAt > a.lastSeenAt ? 1 : b.lastSeenAt < a.lastSeenAt ? -1 : a.lemma.localeCompare(b.lemma)));
}

/** Same merge as the Mac app: first sentence and place kept, latest explanation and Chinese kept, counters bumped. */
export function mergeEntry(existing: VocabEntry | null, input: VocabEntryInput, nowIso: string): VocabEntry {
  if (!existing) {
    return {
      lemma: input.lemma, word: input.word || input.lemma, sentence: input.sentence ?? '', explanation: input.explanation ?? '',
      chinese: input.chinese ?? '', bookId: input.bookId ?? '', bookTitle: input.bookTitle ?? '', chapter: input.chapter ?? '',
      position: input.position ?? null, createdAt: nowIso, lastSeenAt: nowIso, timesExplained: 1, status: 'learning',
      level: input.level, again: input.again ? 1 : 0,
    };
  }
  return {
    ...existing,
    word: existing.word || input.word || input.lemma,
    sentence: existing.sentence || input.sentence || '',
    explanation: input.explanation || existing.explanation,
    chinese: input.chinese || existing.chinese,
    bookId: existing.bookId || input.bookId, bookTitle: existing.bookTitle || input.bookTitle, chapter: existing.chapter || input.chapter,
    position: existing.position ?? input.position ?? null,
    lastSeenAt: nowIso,
    timesExplained: existing.timesExplained + 1,
    level: existing.level ?? input.level,
    again: existing.again + (input.again ? 1 : 0),
  };
}

export async function upsertEntry(input: VocabEntryInput, now: Date = new Date()): Promise<VocabEntry> {
  const lemma = String(input.lemma ?? '').trim();
  if (!lemma) throw new Error('vocabulary: a lemma is required');
  if (!input.level) {
    try { input = { ...input, level: levelOf(await getDictData(), lemma) ?? undefined }; } catch { /* dictionary missing */ }
  }
  const nowIso = now.toISOString();
  let entry!: VocabEntry;
  await store.update((f) => {
    entry = mergeEntry(f.entries[lemma] ?? null, { ...input, lemma }, nowIso);
    return { ...f, entries: { ...f.entries, [lemma]: entry } };
  });
  if ((await settings.getVocab()).words[lemma] !== 'known') await settings.setWordStatus(lemma, 'learning');
  return entry;
}

/** Same as the Mac app's vocab:explained: the entry merged as in upsertEntry, and learning (entry and map) unless known. */
export async function explained(input: VocabEntryInput, now: Date = new Date()): Promise<VocabEntry> {
  const lemma = String(input.lemma ?? '').trim();
  if (!lemma) throw new Error('vocabulary: a lemma is required');
  if (!input.level) {
    try { input = { ...input, level: levelOf(await getDictData(), lemma) ?? undefined }; } catch { /* dictionary missing */ }
  }
  const known = (await settings.getVocab()).words[lemma] === 'known';
  const nowIso = now.toISOString();
  let entry!: VocabEntry;
  await store.update((f) => {
    entry = { ...mergeEntry(f.entries[lemma] ?? null, { ...input, lemma }, nowIso), status: known ? 'known' : 'learning' };
    return { ...f, entries: { ...f.entries, [lemma]: entry } };
  });
  if (!known) await settings.setWordStatus(lemma, 'learning');
  return entry;
}

export async function setEntryStatus(lemma: string, status: VocabEntryStatus): Promise<void> {
  await store.update((f) => {
    const e = f.entries[lemma];
    if (!e) return f;
    return { ...f, entries: { ...f.entries, [lemma]: { ...e, status } } };
  });
  await settings.setWordStatus(lemma, status);
}

export async function deleteEntry(lemma: string): Promise<void> {
  await store.update((f) => {
    if (!(lemma in f.entries)) return f;
    const entries = { ...f.entries };
    delete entries[lemma];
    return { ...f, entries };
  });
  await settings.setWordStatus(lemma, null);
}

function csvField(v: string): string {
  const s = (v ?? '').replace(/\r?\n/g, ' ').trim();
  return /[",;\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 with a BOM so Excel and Numbers show the Chinese; CRLF line ends; oldest entry first. */
export function toCsv(entries: VocabEntry[]): string {
  const rows = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.lemma.localeCompare(b.lemma));
  const lines = ['word,chinese,explanation,sentence,book,chapter,date,status'];
  for (const e of rows) {
    lines.push([e.word || e.lemma, e.chinese, e.explanation, e.sentence, e.bookTitle, e.chapter, e.createdAt.slice(0, 10), e.status].map(csvField).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

const TAGGED: ReadonlySet<string> = new Set(['cefrj', 'oct']);

function levelOf(dict: DictData, word: string): CefrLevel | null {
  const raw = dict.w[word];
  if (!raw) return null;
  return (CEFR_LEVELS as string[]).includes(raw.l) ? (raw.l as CefrLevel) : null;
}

let taggedCache: { dict: DictData; map: Map<CefrLevel, string[]> } | null = null;
function taggedWords(dict: DictData): Map<CefrLevel, string[]> {
  if (taggedCache?.dict === dict) return taggedCache.map;
  const out = new Map<CefrLevel, string[]>(CEFR_LEVELS.map((l) => [l, []]));
  for (const [word, raw] of Object.entries(dict.w)) {
    if (!TAGGED.has(raw.s) || word.includes(' ')) continue;
    const level = levelOf(dict, word);
    if (level) out.get(level)!.push(word);
  }
  taggedCache = { dict, map: out };
  return out;
}

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function streakFrom(days: Iterable<string>, now: Date): number {
  const set = new Set(days);
  if (set.size === 0) return 0;
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!set.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (set.has(dayKey(cursor))) { n++; cursor.setDate(cursor.getDate() - 1); }
  return n;
}

export function computeProgress(dict: DictData, words: VocabState['words'], entries: VocabEntry[], now: Date = new Date()): VocabProgress {
  const levels: LevelProgress[] = [];
  let unknownTotal = 0;
  for (const [level, list] of taggedWords(dict)) {
    const p: LevelProgress = { level, known: 0, learning: 0, unknown: 0, total: list.length };
    for (const w of list) {
      const st = words[w];
      if (st === 'known') p.known++;
      else if (st === 'learning') p.learning++;
      else if (st !== 'ignored') p.unknown++;
    }
    unknownTotal += p.unknown;
    levels.push(p);
  }
  let known = 0, learning = 0;
  for (const st of Object.values(words)) { if (st === 'known') known++; else if (st === 'learning') learning++; }
  const weekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const learnedThisWeek = entries.filter((e) => e.createdAt >= weekAgo).length;
  const days = new Set<string>();
  for (const e of entries) { days.add(dayKey(new Date(e.createdAt))); days.add(dayKey(new Date(e.lastSeenAt))); }
  const lastActiveDay = days.size ? [...days].sort().at(-1)! : null;
  return { levels, totals: { known, learning, unknown: unknownTotal, entries: entries.length }, learnedThisWeek, streakDays: streakFrom(days, now), lastActiveDay };
}

export function unknownAtLevel(dict: DictData, words: VocabState['words'], level: CefrLevel): UnknownWord[] {
  const list = taggedWords(dict).get(level) ?? [];
  const out: UnknownWord[] = [];
  for (const w of list) {
    if (words[w]) continue;
    const raw = dict.w[w];
    out.push({ word: w, zh: (raw.t ?? '').split(/\r?\n/)[0].trim(), ipa: raw.i ? `/${raw.i.replace(/^\/+|\/+$/g, '')}/` : '', level, frq: raw.f | 0 });
  }
  const rank = (f: number) => (f > 0 ? f : Number.MAX_SAFE_INTEGER);
  return out.sort((a, b) => rank(a.frq) - rank(b.frq) || a.word.localeCompare(b.word));
}

export async function getProgress(now: Date = new Date()): Promise<VocabProgress> {
  const dict = await getDictData().catch(() => ({ w: {}, f: {} }) as DictData);
  return computeProgress(dict, (await settings.getVocab()).words, await listEntries(), now);
}

export async function getUnknownAtLevel(level: CefrLevel): Promise<UnknownWord[]> {
  const dict = await getDictData();
  return unknownAtLevel(dict, (await settings.getVocab()).words, level);
}
