import { describe, it, expect } from 'vitest';
import { dailyReview, suggestLevel, reviewDue, dayKey, reviewText } from '../src/review';

const now = new Date(2026, 10, 12, 8, 0, 0);
const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86400_000).toISOString();

describe('the daily word review (no AI)', () => {
  it('runs once a day', () => {
    expect(dayKey(now)).toBe('2026-11-12');
    expect(reviewDue(undefined, now)).toBe(true);
    expect(reviewDue('2026-11-11', now)).toBe(true);
    expect(reviewDue('2026-11-12', now)).toBe(false);
  });
  it('a word explained 7 times is known; a known word not met for 90 days goes back to learn; others stay', () => {
    const r = dailyReview({
      words: { meticulous: 'learning', gregarious: 'learning', ephemeral: 'known', lucid: 'known', table: 'known', 'sentence: x y': 'learning' },
      entries: {
        meticulous: { lemma: 'meticulous', timesExplained: 7, lastSeenAt: iso(1) },
        gregarious: { lemma: 'gregarious', timesExplained: 3, lastSeenAt: iso(1) },
        ephemeral: { lemma: 'ephemeral', timesExplained: 7, lastSeenAt: iso(120) },
        lucid: { lemma: 'lucid', timesExplained: 2, lastSeenAt: iso(10) },
      },
      knownAfter: 7, now, numberOf: () => 60, myLevel: 56,
    });
    expect(r.nowKnown).toEqual(['meticulous']);
    expect(r.backToLearn).toEqual(['ephemeral']);
    // (a word known without any explanation, "table", never goes back by itself)
    expect(r.known).toBe(3);
    expect(r.learning).toBe(2);
  });
  it('"known after" 0 = never by itself; at most a few words go back per day', () => {
    const words: Record<string, 'known' | 'learning'> = { a: 'learning' };
    const entries: Record<string, { lemma: string; timesExplained: number; lastSeenAt: string }> = { a: { lemma: 'a', timesExplained: 20, lastSeenAt: iso(1) } };
    for (let i = 0; i < 30; i++) { words[`w${i}`] = 'known'; entries[`w${i}`] = { lemma: `w${i}`, timesExplained: 1, lastSeenAt: iso(100 + i) }; }
    const r = dailyReview({ words, entries, knownAfter: 0, now, numberOf: () => null, myLevel: 56 });
    expect(r.nowKnown).toEqual([]);
    expect(r.backToLearn.length).toBe(10);
    expect(r.backToLearn[0]).toBe('w29'); // the one not met for the longest time first
    expect(r.suggested).toBeNull();
  });
  it('what the words say about the level: the number that best divides known from still learning', () => {
    const known = Array.from({ length: 40 }, (_, i) => 20 + i);        // 20..59
    const learning = Array.from({ length: 40 }, (_, i) => 62 + i / 2); // 62..81
    const s = suggestLevel(known, learning, 40)!;
    expect(s).toBeGreaterThanOrEqual(59);
    expect(s).toBeLessThan(62);
    expect(suggestLevel(known.slice(0, 5), learning, 40)).toBeNull();
    expect(reviewText({ nowKnown: ['a'], backToLearn: [], suggested: s, known: 40, learning: 40 }, 40)).toMatch(/1 word now known .* about (59|60|61) \(yours is 40/);
    expect(reviewText({ nowKnown: [], backToLearn: [], suggested: 42, known: 40, learning: 40 }, 40)).toBe('');
  });
});
