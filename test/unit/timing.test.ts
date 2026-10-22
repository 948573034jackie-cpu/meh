import { describe, it, expect } from 'vitest';
import { estimateWordTimes, estimateDurationSec, tokenIndexAtChar } from '@core/tts/timing';
import { naiveSegment } from './helpers';

describe('timing', () => {
  it('estimates monotonic word times spanning the duration', () => {
    const words = estimateWordTimes('Hello there, how are you today?', 3);
    expect(words.map((w) => w.charIndex)).toEqual([0, 6, 13, 17, 21, 25]);
    for (let i = 1; i < words.length; i++) expect(words[i].at).toBeGreaterThan(words[i - 1].at);
    expect(words[0].at).toBe(0);
    expect(words[words.length - 1].at).toBeLessThan(3);
  });
  it('duration scales with rate', () => {
    expect(estimateDurationSec('one two three four five six', 1)).toBeGreaterThan(estimateDurationSec('one two three four five six', 2));
  });
  it('maps char indexes to tokens, including gaps', () => {
    const text = 'Mr Darcy arrived, late.';
    const s = naiveSegment(text)[0];
    expect(tokenIndexAtChar(s, 0)).toBe(0);
    expect(tokenIndexAtChar(s, 3)).toBe(1);
    expect(tokenIndexAtChar(s, 8)).toBe(2); // the space before 'arrived' maps to next token
    expect(tokenIndexAtChar(s, 100)).toBe(s.tokens.length - 1);
  });
});
