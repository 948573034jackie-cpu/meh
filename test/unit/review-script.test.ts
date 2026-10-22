import { describe, it, expect } from 'vitest';
import type { ExplainRequest } from '../../src/shared/api';
import type { ReviewItem, ReviewPlan, ContextGroup } from '../../src/core/vocab/review';
import { reviewIntro, buildReviewRequests, estimateReviewMinutes, PASSAGE_REVIEW_QUESTION } from '../../src/core/vocab/reviewScript';

const item = (lemma: string, reason: ReviewItem['reason'] = 'session', o: Partial<ReviewItem> = {}): ReviewItem => ({
  lemma, word: lemma, sentence: `The ${lemma} was there.`, chinese: '东西', explanation: `${lemma}: a thing`, reason, ...o,
});

function plan(items: ReviewItem[], context: ContextGroup[] = []): ReviewPlan {
  return {
    target: Math.max(3, items.length), items, context,
    sessionCount: items.filter((i) => i.reason === 'session').length,
    dueCount: items.filter((i) => i.reason === 'due').length,
  };
}

const group = (chapter: string, lemmas: string[], bookTitle = 'The Old Man and the Sea'): ContextGroup => ({
  bookId: 'b1', bookTitle, chapter, sentences: lemmas.map((l) => ({ lemma: l, word: l, sentence: `The ${l} was there.` })),
});

describe('reviewIntro', () => {
  it('counts the words and mentions the story when there is context', () => {
    const p = plan(['a', 'b', 'c', 'd', 'e', 'f'].map((l) => item(l)), [group('Part 1', ['a'])]);
    expect(reviewIntro(p)).toBe("Let's review 6 words from today, then the story so far.");
  });
  it('splits today and earlier words, handles one word, no story and an empty plan', () => {
    expect(reviewIntro(plan([item('a'), item('b', 'due')], [group('1', ['a'])]))).toBe("Let's review 2 words: 1 from today and 1 from earlier, then the story so far.");
    expect(reviewIntro(plan([item('a', 'due')]))).toBe("Let's review 1 word from earlier sessions.");
    expect(reviewIntro(plan([item('a')]))).toBe("Let's review 1 word from today.");
    expect(reviewIntro(plan([]))).toBe('Nothing to review right now. Well done!');
  });
});

describe('buildReviewRequests', () => {
  it('emits one word request per item, then one passage request per context group, in order', () => {
    const p = plan([item('skiff'), item('salao', 'due', { word: 'Salao', chinese: '' })], [group('Part 1', ['skiff', 'salao']), group('Part 2', ['skiff'])]);
    const reqs = buildReviewRequests(p, { bookTitle: 'The Old Man and the Sea' });
    expect(reqs.map((r) => [r.kind, r.target])).toEqual([
      ['word', 'skiff'],
      ['word', 'Salao'],
      ['passage', 'The skiff was there. The salao was there.'],
      ['passage', 'The skiff was there.'],
    ]);
    const w: ExplainRequest = reqs[0];
    expect(w).toEqual({
      kind: 'word', target: 'skiff', sentence: 'The skiff was there.', before: '', after: '',
      book: { title: 'The Old Man and the Sea', chapter: 'Part 1' }, dict: { zh: '东西' }, history: [], again: false,
    });
    expect(reqs[1].dict).toBeUndefined();   // no Chinese meaning stored: no dict hint
    const ps = reqs[2];
    expect(ps).toMatchObject({ kind: 'passage', sentence: ps.target, before: '', after: '', book: { title: 'The Old Man and the Sea', chapter: 'Part 1' }, history: [], again: false });
    expect(ps.question).toBe(PASSAGE_REVIEW_QUESTION);
    expect(ps.question).toMatch(/retell/i);
    expect(ps.question).toMatch(/one short question/);
    expect(ps.question).toMatch(/\[PAUSE\] followed by the answer\.$/);
    expect(reqs[3].book.chapter).toBe('Part 2');
  });

  it('falls back to the given title, skips empty groups and handles an empty plan', () => {
    const p = plan([item('orphan')], [group('Ch 1', [], ''), { ...group('Ch 2', ['x'], ''), sentences: [{ lemma: 'x', word: 'x', sentence: '  ' }] }]);
    const reqs = buildReviewRequests(p, { bookTitle: 'Fallback' });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].book).toEqual({ title: 'Fallback', chapter: '' });
    const withTitle = buildReviewRequests(plan([], [group('Ch 3', ['y'], '')]), { bookTitle: 'Fallback' });
    expect(withTitle[0].book).toEqual({ title: 'Fallback', chapter: 'Ch 3' });
    expect(buildReviewRequests(plan([]), { bookTitle: 'X' })).toEqual([]);
  });

  it('is pure: the plan is not modified', () => {
    const p = plan([item('a')], [group('1', ['a'])]);
    const before = JSON.stringify(p);
    buildReviewRequests(p, { bookTitle: 'T' });
    reviewIntro(p);
    estimateReviewMinutes(p);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('estimateReviewMinutes', () => {
  it('is 0.75 min per word plus 1 min per context group, rounded up', () => {
    expect(estimateReviewMinutes(plan([]))).toBe(0);
    expect(estimateReviewMinutes(plan([item('a')]))).toBe(1);
    expect(estimateReviewMinutes(plan(['a', 'b', 'c', 'd'].map((l) => item(l))))).toBe(3);
    expect(estimateReviewMinutes(plan(['a', 'b', 'c', 'd', 'e', 'f'].map((l) => item(l)), [group('1', ['a']), group('2', ['b'])]))).toBe(7);   // 4.5 + 2
    expect(estimateReviewMinutes(plan(['a', 'b', 'c', 'd', 'e'].map((l) => item(l)), [group('1', ['a'])]))).toBe(5);   // 3.75 + 1
  });
});
