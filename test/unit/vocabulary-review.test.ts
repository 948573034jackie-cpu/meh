import { describe, it, expect } from 'vitest';
import type { VocabEntry } from '../../src/shared/api';
import { buildReviewPlan, nextDue, isDue, intervalDays, reviewSize, groupByChapter, REVIEW_INTERVALS_DAYS } from '../../src/core/vocab/review';

const NOW = new Date('2026-10-19T12:00:00Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86400_000).toISOString();

function entry(lemma: string, o: Partial<VocabEntry> = {}): VocabEntry {
  return {
    lemma, word: lemma, sentence: `The ${lemma} was there.`, explanation: `${lemma}: a thing`, chinese: '东西',
    bookId: 'b1', bookTitle: 'Book One', chapter: 'Chapter 1', position: { chapter: 0, paragraph: 0, sentence: 0 },
    createdAt: daysAgo(10), lastSeenAt: daysAgo(10), timesExplained: 1, status: 'learning', again: 0, ...o,
  };
}

describe('spaced schedule', () => {
  it('steps through 1, 3, 7, 14, 30 days and stays at 30', () => {
    expect([1, 2, 3, 4, 5, 6, 0].map(intervalDays)).toEqual([1, 3, 7, 14, 30, 30, 1]);
    expect(REVIEW_INTERVALS_DAYS).toEqual([1, 3, 7, 14, 30]);
  });
  it('nextDue adds the interval to lastSeenAt; a known word is never due', () => {
    expect(nextDue(entry('a', { lastSeenAt: '2026-10-01T00:00:00.000Z', timesExplained: 1 }))).toBe('2026-10-02T00:00:00.000Z');
    expect(nextDue(entry('a', { lastSeenAt: '2026-10-01T00:00:00.000Z', timesExplained: 3 }))).toBe('2026-10-08T00:00:00.000Z');
    expect(nextDue(entry('a', { status: 'known' }))).toBeNull();
    expect(nextDue(entry('a', { lastSeenAt: 'not a date' }))).toBeNull();
    expect(isDue(entry('a', { lastSeenAt: daysAgo(2), timesExplained: 1 }), NOW)).toBe(true);
    expect(isDue(entry('a', { lastSeenAt: daysAgo(2), timesExplained: 2 }), NOW)).toBe(false);
  });
});

describe('review size', () => {
  it('is about one item per 300 words, between 3 and 20', () => {
    expect(reviewSize(0)).toBe(3);
    expect(reviewSize(500)).toBe(3);
    expect(reviewSize(1500)).toBe(5);
    expect(reviewSize(3000)).toBe(10);
    expect(reviewSize(9000)).toBe(20);
    expect(reviewSize(100000)).toBe(20);
    expect(reviewSize(-5)).toBe(3);
  });
});

describe('buildReviewPlan', () => {
  it('takes the session words first, "I don\'t know" words before the others, then due words', () => {
    const entries = [
      entry('calm', { lastSeenAt: daysAgo(0), createdAt: daysAgo(0) }),
      entry('vivid', { lastSeenAt: daysAgo(0), createdAt: daysAgo(0), again: 2 }),
      entry('ledger', { lastSeenAt: daysAgo(5), timesExplained: 1 }),            // due 4 days ago
      entry('serene', { lastSeenAt: daysAgo(20), timesExplained: 2 }),           // due 17 days ago (most overdue)
      entry('brisk', { lastSeenAt: daysAgo(1), timesExplained: 2 }),             // not due (3-day step)
      entry('known1', { lastSeenAt: daysAgo(40), status: 'known' }),             // never
    ];
    const plan = buildReviewPlan(entries, 1500, { now: NOW, sessionStart: daysAgo(0.5) });
    expect(plan.target).toBe(5);
    expect(plan.items.map((i) => i.lemma)).toEqual(['vivid', 'calm', 'serene', 'ledger']);
    expect(plan.items.map((i) => i.reason)).toEqual(['session', 'session', 'due', 'due']);
    expect(plan.sessionCount).toBe(2);
    expect(plan.dueCount).toBe(2);
    expect(plan.items[0]).toMatchObject({ word: 'vivid', chinese: '东西', sentence: 'The vivid was there.' });
  });

  it('respects the size limit and accepts session lemmas explicitly', () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`w${i}`, { lastSeenAt: daysAgo(3) }));
    const plan = buildReviewPlan(entries, 600, { now: NOW, sessionLemmas: ['w3', 'w7', 'w9', 'w11'] });
    expect(plan.target).toBe(3);
    expect(plan.items).toHaveLength(3);
    expect(plan.items.every((i) => i.reason === 'session')).toBe(true);
    const big = buildReviewPlan(entries, 100000, { now: NOW });
    expect(big.items).toHaveLength(20);
    expect(big.items.every((i) => i.reason === 'due')).toBe(true);
    expect(big.target).toBe(20);
  });

  it('is short when there is little to review and empty without entries', () => {
    expect(buildReviewPlan([], 5000, { now: NOW }).items).toEqual([]);
    const plan = buildReviewPlan([entry('one', { lastSeenAt: daysAgo(0) })], 5000, { now: NOW, sessionStart: daysAgo(1) });
    expect(plan.items).toHaveLength(1);
    expect(plan.target).toBe(17);
  });

  it('groups the context review by book and chapter in reading order', () => {
    const entries = [
      entry('late', { chapter: 'Chapter 2', position: { chapter: 1, paragraph: 5, sentence: 0 }, createdAt: daysAgo(3), lastSeenAt: daysAgo(0) }),
      entry('early', { chapter: 'Chapter 2', position: { chapter: 1, paragraph: 1, sentence: 0 }, createdAt: daysAgo(2), lastSeenAt: daysAgo(0) }),
      entry('other', { bookId: 'b2', bookTitle: 'Book Two', chapter: 'I', createdAt: daysAgo(1), lastSeenAt: daysAgo(0) }),
      entry('same', { chapter: 'Chapter 2', sentence: 'The early was there.', position: { chapter: 1, paragraph: 1, sentence: 0 }, createdAt: daysAgo(1), lastSeenAt: daysAgo(0) }),
      entry('nosentence', { sentence: '', lastSeenAt: daysAgo(0) }),
    ];
    const plan = buildReviewPlan(entries, 3000, { now: NOW, sessionStart: daysAgo(0.5) });
    expect(plan.context.map((g) => [g.bookTitle, g.chapter])).toEqual([['Book One', 'Chapter 2'], ['Book Two', 'I']]);
    // same sentence listed once; paragraph 1 before paragraph 5
    expect(plan.context[0].sentences.map((s) => s.lemma)).toEqual(['early', 'late']);
    expect(groupByChapter([])).toEqual([]);
  });
});
