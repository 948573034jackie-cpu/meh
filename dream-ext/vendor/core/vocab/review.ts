/**
 * The spoken review class after a listening session (pure; the voice layer speaks the plan later).
 *
 * Which words: the ones explained this session, then the ones due again on a simple spaced schedule
 * (1, 3, 7, 14, 30 days after the last time they were seen, one step per explanation). How many: about one
 * review item per 300 words read, at least 3, at most 20. Two parts: the vocabulary items (word, sentence,
 * Chinese) and a context review, the sentences grouped by book and chapter in reading order.
 */
import type { VocabEntry } from '@shared/api';

export const REVIEW_INTERVALS_DAYS: readonly number[] = [1, 3, 7, 14, 30];
export const WORDS_PER_REVIEW_ITEM = 300;
export const MIN_REVIEW_ITEMS = 3;
export const MAX_REVIEW_ITEMS = 20;

export interface ReviewItem {
  lemma: string;
  word: string;
  sentence: string;
  chinese: string;
  explanation: string;
  /** why it is in the class */
  reason: 'session' | 'due';
}

export interface ContextGroup {
  bookId: string;
  bookTitle: string;
  chapter: string;
  /** reading order within the chapter */
  sentences: { lemma: string; word: string; sentence: string }[];
}

export interface ReviewPlan {
  /** how many items the session size asked for (before running out of words) */
  target: number;
  items: ReviewItem[];
  context: ContextGroup[];
  sessionCount: number;
  dueCount: number;
}

export interface ReviewOptions {
  now?: Date;
  /** lemmas explained in this session (else: entries seen since `sessionStart`) */
  sessionLemmas?: Iterable<string>;
  /** ISO time the session started; entries with lastSeenAt at or after it count as this session's */
  sessionStart?: string;
}

/** Days until the next review after the n-th explanation (1-based): 1, 3, 7, 14, 30, then 30 again. */
export function intervalDays(timesExplained: number): number {
  const i = Math.max(0, Math.min(REVIEW_INTERVALS_DAYS.length - 1, (timesExplained | 0) - 1));
  return REVIEW_INTERVALS_DAYS[i];
}

/** ISO time of the next review, or null for a known word (nothing to review). */
export function nextDue(entry: Pick<VocabEntry, 'lastSeenAt' | 'timesExplained' | 'status'>): string | null {
  if (entry.status === 'known') return null;
  const last = Date.parse(entry.lastSeenAt);
  if (Number.isNaN(last)) return null;
  return new Date(last + intervalDays(entry.timesExplained) * 86400_000).toISOString();
}

export function isDue(entry: Pick<VocabEntry, 'lastSeenAt' | 'timesExplained' | 'status'>, now: Date = new Date()): boolean {
  const due = nextDue(entry);
  return due !== null && Date.parse(due) <= now.getTime();
}

/** About one item per 300 words read, between 3 and 20. */
export function reviewSize(sessionWords: number): number {
  const n = Math.round(Math.max(0, sessionWords) / WORDS_PER_REVIEW_ITEM);
  return Math.max(MIN_REVIEW_ITEMS, Math.min(MAX_REVIEW_ITEMS, n));
}

function toItem(e: VocabEntry, reason: ReviewItem['reason']): ReviewItem {
  return { lemma: e.lemma, word: e.word || e.lemma, sentence: e.sentence, chinese: e.chinese, explanation: e.explanation, reason };
}

/** Sentences grouped by book and chapter, in reading order (position), groups in the order they were met. */
export function groupByChapter(entries: VocabEntry[]): ContextGroup[] {
  const groups = new Map<string, ContextGroup>();
  const sorted = [...entries].filter((e) => e.sentence).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const e of sorted) {
    const key = `${e.bookId}\u0000${e.chapter}`;
    let g = groups.get(key);
    if (!g) { g = { bookId: e.bookId, bookTitle: e.bookTitle, chapter: e.chapter, sentences: [] }; groups.set(key, g); }
    if (!g.sentences.some((s) => s.sentence === e.sentence)) g.sentences.push({ lemma: e.lemma, word: e.word || e.lemma, sentence: e.sentence });
  }
  const pos = (e: VocabEntry) => e.position ? [e.position.chapter, e.position.paragraph, e.position.sentence] : null;
  for (const g of groups.values()) {
    const byLemma = new Map(entries.map((e) => [e.lemma, e]));
    g.sentences.sort((a, b) => {
      const pa = pos(byLemma.get(a.lemma)!), pb = pos(byLemma.get(b.lemma)!);
      if (!pa || !pb) return 0;
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
  }
  return [...groups.values()];
}

/**
 * Builds the review class. Session words come first (the ones the learner said "I don't know" about before the
 * others, then the most recent), then due words, the most overdue first, up to the target size.
 */
export function buildReviewPlan(entries: VocabEntry[], sessionWords: number, opts: ReviewOptions = {}): ReviewPlan {
  const now = opts.now ?? new Date();
  const target = reviewSize(sessionWords);
  const sessionSet = new Set(opts.sessionLemmas ?? []);
  const start = opts.sessionStart ? Date.parse(opts.sessionStart) : NaN;
  const inSession = (e: VocabEntry) => sessionSet.has(e.lemma) || (!Number.isNaN(start) && Date.parse(e.lastSeenAt) >= start);
  const learning = entries.filter((e) => e.status !== 'known');
  const session = learning.filter(inSession).sort((a, b) => b.again - a.again || b.lastSeenAt.localeCompare(a.lastSeenAt));
  const due = learning.filter((e) => !inSession(e) && isDue(e, now)).sort((a, b) => Date.parse(nextDue(a)!) - Date.parse(nextDue(b)!));
  const items: ReviewItem[] = [];
  for (const e of session) { if (items.length >= target) break; items.push(toItem(e, 'session')); }
  for (const e of due) { if (items.length >= target) break; items.push(toItem(e, 'due')); }
  const chosen = new Set(items.map((i) => i.lemma));
  return {
    target,
    items,
    context: groupByChapter(entries.filter((e) => chosen.has(e.lemma))),
    sessionCount: items.filter((i) => i.reason === 'session').length,
    dueCount: items.filter((i) => i.reason === 'due').length,
  };
}
