import { describe, it, expect } from 'vitest';
import { partRange } from '../src/part';

const spans = (ends: number[], first = 0) => ends.map((e, i) => ({ start: i ? ends[i - 1] : first, end: e }));

describe('"Explain N seconds" = complete sentences, about N seconds', () => {
  it('short sentences: as many as fit in about N seconds', () => {
    const s = spans([4, 8, 12, 16, 20, 24, 28, 32]);
    // at 31.9 s, 10 s: the sentences 20-24, 24-28, 28-32 (12 s <= 13 s); 16-20 ended before the window
    expect(partRange(s, 31.9, 10)).toEqual([5, 7]);
    expect(partRange(s, 31.9, 20)).toEqual([2, 7]);
    expect(partRange(s, 31.9, 30)).toEqual([0, 7]);
  });
  it('a long sentence that began long ago does not make a 10 s part 30 s long', () => {
    // 0-5, 5-30 (25 s long), 30-36: at 35.9 s the old rule took 5-36 (31 s) for "10 s"
    const s = spans([5, 30, 36]);
    expect(partRange(s, 35.9, 10)).toEqual([2, 2]);
    expect(partRange(s, 35.9, 30)).toEqual([1, 2]);
  });
  it('one sentence longer than N is still taken whole, alone; never two long ones', () => {
    const s = spans([20, 40, 60]);
    expect(partRange(s, 59, 10)).toEqual([2, 2]);
    expect(partRange(s, 59, 20)).toEqual([2, 2]);
    expect(partRange(s, 59, 30)).toEqual([2, 2]);
  });
  it('a sentence that has only just started is not part of what was heard', () => {
    const s = spans([4, 8, 12]);
    expect(partRange(s, 8.3, 10)).toEqual([0, 1]);
    expect(partRange(s, 9.5, 10)).toEqual([0, 2]);
  });
  it('edges: before the first sentence, no sentences', () => {
    expect(partRange(spans([4, 8], 2), 0.5, 10)).toEqual([0, 0]);
    expect(partRange([], 3, 10)).toBeNull();
  });
});
