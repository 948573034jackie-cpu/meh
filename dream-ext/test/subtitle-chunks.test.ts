import { describe, it, expect } from 'vitest';
import { chunkWords, lettersPerLine } from '../src/subtitle-chunks';

const lens = (text: string) => text.split(' ').map((w) => w.length + 1);
const brk = (text: string) => text.split(' ').map((w) => /[,.;:!?]$/.test(w));
const pieces = (text: string, budget: number) => {
  const c = chunkWords(lens(text), budget, brk(text));
  const words = text.split(' ');
  const out: string[] = [];
  c.forEach((p, i) => { out[p] = out[p] ? `${out[p]} ${words[i]}` : words[i]; });
  return out;
};

describe('film-like subtitles: one or two lines, only what is said now', () => {
  it('a short sentence is one piece', () => {
    expect(pieces('We will talk about it again very soon.', 60)).toEqual(['We will talk about it again very soon.']);
  });
  it('a long sentence is cut into pieces that fit two lines, nothing lost, in order', () => {
    const t = 'When I was a child my grandmother, who had lived through two wars, used to tell me that patience is not the ability to wait but the ability to keep a good attitude while waiting for something.';
    const p = pieces(t, 60);
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.join(' ')).toBe(t);
    for (const x of p) expect(x.length).toBeLessThanOrEqual(61);
    // (no tiny last piece: the pieces are about the same length)
    expect(p[p.length - 1].length).toBeGreaterThan(15);
  });
  it('a comma near the right place is where it is cut', () => {
    const t = 'My friend was very careful about her work, and she checked every page again before she sent it away.';
    const p = pieces(t, 60);
    expect(p[0].endsWith(',')).toBe(true);
  });
  it('how many letters fit in a line: a narrow phone fewer, never more than a film line', () => {
    expect(lettersPerLine(343, 21)).toBe(31);
    expect(lettersPerLine(2000, 20)).toBe(42);
    expect(lettersPerLine(50, 40)).toBe(14);
  });
});
