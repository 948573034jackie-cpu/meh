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

/**
 * About how many English words the learner knows: every tagged dictionary word at or below their level (except the
 * ones still being learned), plus the harder words they marked as known.
 */
export function estimateKnown(p: VocabProgress, level: CefrLevel | string): number {
  const order = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const mine = Math.max(0, order.indexOf(String(level)));
  let est = 0;
  for (const l of p.levels) est += order.indexOf(l.level) <= mine ? l.total - l.learning : l.known;
  return est;
}

/**
 * My level from my own words: the words of each CEFR level the learner met (stops, taps) and knew ("I know") or did
 * not know (explained). Up one level when 75% of the 15+ words met at the next level were known; down one when
 * fewer than 40% of the 15+ words met at the own level were known. null = the level stays.
 */
export function suggestLevel(levels: LevelProgress[], current: string): { level: CefrLevel; reason: string } | null {
  const order = CEFR_LEVELS as CefrLevel[];
  const i = order.indexOf(current as CefrLevel);
  if (i < 0) return null;
  const at = (l: CefrLevel) => levels.find((x) => x.level === l);
  const next = order[i + 1];
  const up = next ? at(next) : undefined;
  if (next && up) {
    const n = up.known + up.learning;
    if (n >= 15 && up.known / n >= 0.75) return { level: next, reason: `you knew ${up.known} of the ${n} ${next} words you met` };
  }
  const mine = at(order[i]);
  if (i > 0 && mine) {
    const n = mine.known + mine.learning;
    if (n >= 15 && mine.known / n < 0.4) return { level: order[i - 1], reason: `${mine.learning} of the ${n} ${order[i]} words you met were new to you` };
  }
  return null;
}

/** "B2 words: 40 of 52 known · C1: 12 of 30" for the settings */
export function levelNote(levels: LevelProgress[], current: string): string {
  const order = CEFR_LEVELS as string[];
  const i = order.indexOf(current);
  const show = order.slice(Math.max(0, i), i + 2).map((l) => levels.find((x) => x.level === l)).filter((p): p is LevelProgress => !!p && p.known + p.learning > 0);
  return show.length ? show.map((p) => `${p.level} words you met: ${p.known} of ${p.known + p.learning} known`).join(' · ') : 'no words met yet at your level';
}
