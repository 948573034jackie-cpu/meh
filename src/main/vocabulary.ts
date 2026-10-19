/**
 * My Vocabulary: every word the learner had explained, with the sentence it was met in, the explanation and
 * where in which book. Stored in <userData>/data/vocabulary.json (JsonStore, atomic writes) and mirrored to
 * ~/Documents/Dream Read/my-vocabulary.csv, which is rewritten (debounced) after every change so the file is
 * always current. The status map used by highlighting (VocabState.words, settings.ts) is kept in sync.
 *
 * Also computes the Progress page numbers from the dictionary data: per CEFR level how many of the
 * CEFR-tagged words are known / learning / unknown.
 */
import path from 'node:path';
import type { CefrLevel } from '@core/model';
import { CEFR_LEVELS } from '@core/model';
import type { DictData, VocabEntry, VocabEntryInput, VocabEntryStatus, VocabProgress, LevelProgress, UnknownWord } from '@shared/api';
import type { VocabState } from '@shared/settings';
import { JsonStore, writeAtomic } from './storage';
import { exportDir } from './paths';
import * as settings from './settings';

export interface VocabularyFile { version: 1; entries: Record<string, VocabEntry> }

const store = new JsonStore<VocabularyFile>('vocabulary', () => ({ version: 1, entries: {} }));

export const CSV_FILE_NAME = 'my-vocabulary.csv';
export const CSV_DEBOUNCE_MS = 2000;

/** The dictionary is loaded lazily by library.ts; the IPC layer hands it over so this module stays testable. */
let dictProvider: (() => Promise<DictData>) | null = null;
export function setDictionaryProvider(p: (() => Promise<DictData>) | null): void { dictProvider = p; }

/* ------------------------------------------------------------------------------------------------
 * Entries
 * ---------------------------------------------------------------------------------------------- */

export function listEntries(): VocabEntry[] {
  return Object.values(store.get().entries).sort((a, b) => (b.lastSeenAt > a.lastSeenAt ? 1 : b.lastSeenAt < a.lastSeenAt ? -1 : a.lemma.localeCompare(b.lemma)));
}

export function getEntry(lemma: string): VocabEntry | null { return store.get().entries[lemma] ?? null; }

/**
 * Merges a new explanation into an existing entry: one more explanation, lastSeenAt bumped, the first sentence
 * (and where it was met) kept, the latest non-empty explanation and Chinese kept. A known word stays known.
 */
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
  if (!input.level && dictProvider) {
    try { input = { ...input, level: levelOf(await dictProvider(), lemma) ?? undefined }; } catch { /* dictionary missing */ }
  }
  const nowIso = now.toISOString();
  let entry!: VocabEntry;
  store.update((f) => {
    entry = mergeEntry(f.entries[lemma] ?? null, { ...input, lemma }, nowIso);
    return { ...f, entries: { ...f.entries, [lemma]: entry } };
  });
  // the highlighting map: learning unless the learner already knows the word
  if (settings.getVocab().words[lemma] !== 'known') settings.setWordStatus(lemma, 'learning');
  scheduleCsv();
  return entry;
}

export function setEntryStatus(lemma: string, status: VocabEntryStatus): void {
  store.update((f) => {
    const e = f.entries[lemma];
    if (!e) return f;
    return { ...f, entries: { ...f.entries, [lemma]: { ...e, status } } };
  });
  settings.setWordStatus(lemma, status);
  scheduleCsv();
}

export function deleteEntry(lemma: string): void {
  store.update((f) => {
    if (!(lemma in f.entries)) return f;
    const entries = { ...f.entries };
    delete entries[lemma];
    return { ...f, entries };
  });
  settings.setWordStatus(lemma, null);
  scheduleCsv();
}

/* ------------------------------------------------------------------------------------------------
 * CSV mirror
 * ---------------------------------------------------------------------------------------------- */

export function csvPath(): string { return path.join(exportDir(), CSV_FILE_NAME); }

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

let csvTimer: ReturnType<typeof setTimeout> | null = null;

/** Writes the CSV now (used by the Export button) and cancels a pending debounced write. */
export function writeCsv(): string {
  if (csvTimer) { clearTimeout(csvTimer); csvTimer = null; }
  const file = csvPath();
  writeAtomic(file, toCsv(listEntries()));
  return file;
}

function scheduleCsv(): void {
  if (csvTimer) clearTimeout(csvTimer);
  csvTimer = setTimeout(() => {
    csvTimer = null;
    try { writeCsv(); } catch (e) { console.error('vocabulary: could not write the CSV', e); }
  }, CSV_DEBOUNCE_MS);
  // never keep the app alive for the mirror file
  (csvTimer as { unref?: () => void }).unref?.();
}

/** true while a debounced CSV write is pending (tests) */
export function csvWritePending(): boolean { return csvTimer !== null; }

/* ------------------------------------------------------------------------------------------------
 * Progress (dictionary + status map)
 * ---------------------------------------------------------------------------------------------- */

const TAGGED: ReadonlySet<string> = new Set(['cefrj', 'oct']);

function levelOf(dict: DictData, word: string): CefrLevel | null {
  const raw = dict.w[word];
  if (!raw) return null;
  return (CEFR_LEVELS as string[]).includes(raw.l) ? (raw.l as CefrLevel) : null;
}

/** Single-word headwords with a level from a real CEFR list (not estimated), per level. */
function taggedWords(dict: DictData): Map<CefrLevel, string[]> {
  const out = new Map<CefrLevel, string[]>(CEFR_LEVELS.map((l) => [l, []]));
  for (const [word, raw] of Object.entries(dict.w)) {
    if (!TAGGED.has(raw.s) || word.includes(' ')) continue;
    const level = levelOf(dict, word);
    if (level) out.get(level)!.push(word);
  }
  return out;
}

/** YYYY-MM-DD in local time. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Days in a row with activity, counted back from today (or from yesterday when today has none yet). */
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

/** Tagged words of a level the learner has not marked, by corpus rank (COCA `frq`: 1 = most frequent, 0 = unranked, last). */
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
  const dict = dictProvider ? await dictProvider().catch(() => ({ w: {}, f: {} })) : { w: {}, f: {} };
  return computeProgress(dict, settings.getVocab().words, listEntries(), now);
}

export async function getUnknownAtLevel(level: CefrLevel): Promise<UnknownWord[]> {
  if (!dictProvider) return [];
  const dict = await dictProvider();
  return unknownAtLevel(dict, settings.getVocab().words, level);
}
