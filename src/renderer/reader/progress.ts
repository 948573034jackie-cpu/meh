import type { Book, Position } from '@core/model';
import type { ReadMode } from '@shared/settings';
import { comparePositions } from '@core/nav';

/**
 * Pure helpers behind the progress text (Reading mode) and the whole-book timeline (Listening mode):
 * word counts, reading-speed estimates, time formatting and the sentence <-> time mapping.
 */

/** Silent reading speed assumed when nothing is measured. */
export const READING_WPM = 200;
/** Words per minute of a natural voice at 1.0x (cloud and local voices alike). */
export const SPEECH_WPM = 160;

/** Words per minute the time estimates use: the voice's pace when audio plays, else silent reading. */
export function wordsPerMinute(mode: ReadMode, rate: number, playing: boolean): number {
  if (mode === 'listening' || playing) return Math.max(1, SPEECH_WPM * (Number.isFinite(rate) && rate > 0 ? rate : 1));
  return READING_WPM;
}

export interface SentenceSlot { pos: Position; words: number; /** words before this sentence in the book */ before: number }
export interface ChapterSlot { index: number; title: string; /** words before the chapter */ before: number; words: number }
export interface BookIndex { sentences: SentenceSlot[]; chapters: ChapterSlot[]; totalWords: number }

const countWords = (tokens: { kind: string }[]): number => tokens.reduce((n, t) => n + (t.kind === 'word' ? 1 : 0), 0);

/** Flat index of every sentence with its word offset; built once per book. */
export function indexBook(book: Book): BookIndex {
  const sentences: SentenceSlot[] = [];
  const chapters: ChapterSlot[] = [];
  let n = 0;
  for (const ch of book.chapters) {
    const before = n;
    for (const para of ch.paragraphs) for (const s of para.sentences) {
      const words = countWords(s.tokens);
      sentences.push({ pos: { chapter: ch.index, paragraph: para.index, sentence: s.index }, words, before: n });
      n += words;
    }
    chapters.push({ index: ch.index, title: ch.title, before, words: n - before });
  }
  return { sentences, chapters, totalWords: n };
}

/** Index of the sentence at `pos` in the flat list, or the nearest one before it (0 when the book is empty). */
export function sentenceIndexAt(idx: BookIndex, pos: Position): number {
  const list = idx.sentences;
  let lo = 0, hi = list.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (comparePositions(list[mid].pos, pos) <= 0) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Words before `pos` in the whole book. */
export function wordsBefore(idx: BookIndex, pos: Position): number {
  if (!idx.sentences.length) return 0;
  return idx.sentences[sentenceIndexAt(idx, pos)].before;
}

/** Seconds of speech/reading before `pos` at `wpm`. */
export function timeAt(idx: BookIndex, pos: Position, wpm: number): number { return (wordsBefore(idx, pos) / wpm) * 60; }

/** Total seconds for the whole book at `wpm`. */
export function totalTime(idx: BookIndex, wpm: number): number { return (idx.totalWords / wpm) * 60; }

/** The sentence being read `seconds` into the book at `wpm` (clamped to the book). */
export function positionAtTime(idx: BookIndex, seconds: number, wpm: number): Position | null {
  const list = idx.sentences;
  if (!list.length) return null;
  const words = Math.max(0, (seconds / 60) * wpm);
  let lo = 0, hi = list.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].before <= words) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return list[ans].pos;
}

/** Chapter tick marks for a timeline: fraction 0..1 of the book where each chapter starts, with its title. */
export function chapterMarks(idx: BookIndex): { index: number; title: string; at: number }[] {
  if (!idx.totalWords) return idx.chapters.map((c) => ({ index: c.index, title: c.title, at: 0 }));
  return idx.chapters.map((c) => ({ index: c.index, title: c.title, at: c.before / idx.totalWords }));
}

/** Fraction 0..1 of the book before `pos`. */
export function fractionAt(idx: BookIndex, pos: Position): number { return idx.totalWords ? wordsBefore(idx, pos) / idx.totalWords : 0; }

/** Words left in the chapter of `pos` (from the start of its sentence) and in the whole book. */
export function wordsLeft(idx: BookIndex, pos: Position): { chapter: number; book: number } {
  const before = wordsBefore(idx, pos);
  const ch = idx.chapters[pos.chapter];
  const chapterEnd = ch ? ch.before + ch.words : before;
  return { chapter: Math.max(0, chapterEnd - before), book: Math.max(0, idx.totalWords - before) };
}

/** "3 min", "12 min", "1 h 05 min", "2 h 10 min"; under a minute: "less than a minute". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${String(r).padStart(2, '0')} min`;
}

/** "1:23:40" or "9:05" for a number of seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

export type ProgressKind = 'page' | 'chapter' | 'book' | 'percent';
export const PROGRESS_KINDS: ProgressKind[] = ['page', 'chapter', 'book', 'percent'];

/** The bottom-left status text of Reading mode; it cycles through the kinds on click. */
export function progressText(kind: ProgressKind, p: { page: number; pageCount: number; wordsLeftChapter: number; wordsLeftBook: number; wpm: number; fraction: number }): string {
  switch (kind) {
    case 'page': return `Page ${p.page} of ${p.pageCount}`;
    case 'chapter': return `${formatMinutes(p.wordsLeftChapter / p.wpm)} left in chapter`;
    case 'book': return `${formatMinutes(p.wordsLeftBook / p.wpm)} left in book`;
    case 'percent': return `${Math.floor(Math.min(1, Math.max(0, p.fraction)) * 100)}%`;
  }
}

export function nextProgressKind(k: ProgressKind): ProgressKind { return PROGRESS_KINDS[(PROGRESS_KINDS.indexOf(k) + 1) % PROGRESS_KINDS.length]; }

/** Speed slider steps: 0.5 .. 2.0 in 0.1 steps, rounded so 0.1 + 0.2 does not become 0.30000000000000004. */
export function clampRate(r: number, min = 0.5, max = 2): number { return Math.round(Math.min(max, Math.max(min, Number.isFinite(r) ? r : 1)) * 10) / 10; }

/** The sentence that starts at or just before the `words`-th word of the book. */
export function positionAtWords(idx: BookIndex, words: number): Position | null {
  const list = idx.sentences;
  if (!list.length) return null;
  const w = Math.max(0, words);
  let lo = 0, hi = list.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].before <= w) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return list[ans].pos;
}

/**
 * "Page 12 of 240" for the whole book from the one chapter that is laid out: the words per page measured in
 * the current chapter are applied to the rest of the book (Kindle counts pages the same way, by text amount).
 */
export function bookPages(idx: BookIndex, chapter: number, pageIndex: number, pageCount: number): { page: number; total: number; wordsPerPage: number } {
  const ch = idx.chapters[chapter];
  const count = Math.max(1, pageCount);
  const wordsPerPage = ch && ch.words > 0 ? ch.words / count : 250;
  const total = Math.max(1, Math.round(idx.totalWords / wordsPerPage));
  const page = Math.min(total, Math.floor((ch?.before ?? 0) / wordsPerPage) + Math.min(pageIndex, count - 1) + 1);
  return { page, total, wordsPerPage };
}
