/**
 * My Vocabulary helpers: the same rules as Dream Read's src/main/vocabulary.ts (merge, CSV, progress per CEFR
 * level), without the Node file system. For a video, "book" is the video title and "chapter" the time in it.
 */
import type { CefrLevel } from '@core/model';
import { CEFR_LEVELS } from '@core/model';
import type { DictData, VocabEntry, VocabEntryInput, VocabProgress, LevelProgress, UnknownWord } from '@shared/api';
import type { VocabState } from '@shared/settings';

/** One more explanation of a word: the first sentence (and where it was met) kept, the latest explanation kept, known stays known. */
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

function csvField(v: string): string {
  const s = (v ?? '').replace(/\r?\n/g, ' ').trim();
  return /[",;\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 with a BOM so Excel and Numbers show the Chinese; CRLF line ends; oldest entry first. */
export function toCsv(entries: VocabEntry[]): string {
  const rows = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.lemma.localeCompare(b.lemma));
  const lines = ['word,chinese,explanation,sentence,video,time,link,date,status'];
  for (const e of rows) {
    const link = videoLink(e);
    lines.push([e.word || e.lemma, e.chinese, e.explanation, e.sentence, e.bookTitle, e.chapter, link, e.createdAt.slice(0, 10), e.status].map(csvField).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** The video at the moment the word was met: "https://www.youtube.com/watch?v=ID&t=83s" (chapter holds the clock "1:23"). */
export function videoLink(e: Pick<VocabEntry, 'bookId' | 'chapter'>): string {
  if (!e.bookId.startsWith('yt:')) return '';
  const sec = e.chapter.split(':').reduce((n, part) => n * 60 + (Number(part) || 0), 0);
  return `https://www.youtube.com/watch?v=${e.bookId.slice(3)}${sec > 0 ? `&t=${sec}s` : ''}`;
}

const TAGGED: ReadonlySet<string> = new Set(['cefrj', 'oct']);

function levelOf(dict: DictData, word: string): CefrLevel | null {
  const raw = dict.w[word];
  if (!raw) return null;
  return (CEFR_LEVELS as string[]).includes(raw.l) ? (raw.l as CefrLevel) : null;
}

function taggedWords(dict: DictData): Map<CefrLevel, string[]> {
  const out = new Map<CefrLevel, string[]>(CEFR_LEVELS.map((l) => [l, []]));
  for (const [word, raw] of Object.entries(dict.w)) {
    if (!TAGGED.has(raw.s) || word.includes(' ')) continue;
    const level = levelOf(dict, word);
    if (level) out.get(level)!.push(word);
  }
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

/** "1:23" / "1:02:03" */
export function clock(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
}
