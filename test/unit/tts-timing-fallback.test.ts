import { describe, it, expect } from 'vitest';
import { estimateWordTimes } from '@core/tts/timing';

describe('proportional word timing fallback (engines without word boundaries, e.g. Azure REST)', () => {
  it('gives longer words proportionally more time and spans the audio duration', () => {
    const text = 'a extraordinary b';
    const w = estimateWordTimes(text, 10);
    expect(w.map((x) => [x.charIndex, x.charLength])).toEqual([[0, 1], [2, 13], [16, 1]]);
    expect(w[0].at).toBe(0);
    // gaps are proportional to word length (+1 for the space): 2 : 14
    expect((w[2].at - w[1].at) / (w[1].at - w[0].at)).toBeCloseTo(14 / 2, 5);
    expect(w[2].at).toBeLessThan(10);
  });
  it('is monotonic and handles text without words', () => {
    const w = estimateWordTimes('One, two. Three four!', 4);
    for (let i = 1; i < w.length; i++) expect(w[i].at).toBeGreaterThan(w[i - 1].at);
    expect(estimateWordTimes('— …', 3)).toEqual([]);
  });
});
