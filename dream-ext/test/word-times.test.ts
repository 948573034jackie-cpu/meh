/**
 * The line under the spoken word: when each word is said. Exact times from the letter times of ElevenLabs, estimated
 * ones for the voices that give none, and the reading of them (a little early, never late).
 */
import { describe, it, expect } from 'vitest';
import { wordSpans, wordsFromAlignment, estimateWordTimes, wordAt, type Alignment, type WordTime } from '../src/word-times';

/** every letter of `text` lasts `per` seconds, one after the other, from `from` */
function letters(text: string, per = 0.1, from = 0): Alignment {
  const characters = text.split('');
  return { characters, character_start_times_seconds: characters.map((_, i) => from + i * per), character_end_times_seconds: characters.map((_, i) => from + (i + 1) * per) };
}
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);
const word = (text: string, w: WordTime) => text.slice(w.charStart, w.charEnd);

describe('the words of a text', () => {
  it('letters and digits, with \' and - inside; quotation marks and other signs are not part of a word', () => {
    const t = '“Well-known,” she said: don’t — it’s 1984!';
    expect(wordSpans(t).map((w) => t.slice(w.charStart, w.charEnd))).toEqual(['Well-known', 'she', 'said', 'don’t', 'it’s', '1984']);
    const u = "the dogs' bowl - twenty-";
    expect(wordSpans(u).map((w) => u.slice(w.charStart, w.charEnd))).toEqual(['the', 'dogs', 'bowl', 'twenty']);
    expect(wordSpans('  …  ')).toEqual([]);
  });
});

describe('ElevenLabs: the times of the letters -> the times of the words', () => {
  it('each word starts with its first letter and ends with its last one', () => {
    const t = 'Hello there, my friend.';
    const w = wordsFromAlignment(t, letters(t));
    expect(w.map((x) => word(t, x))).toEqual(['Hello', 'there', 'my', 'friend']);
    near(w[0].start, 0); near(w[0].end, 0.5);
    near(w[1].start, 0.6); near(w[1].end, 1.1);   // "there" without its comma
    near(w[2].start, 1.3); near(w[2].end, 1.5);
    near(w[3].start, 1.6); near(w[3].end, 2.2);   // "friend" without the full stop
    expect(w[1]).toMatchObject({ charStart: 6, charEnd: 11 });
  });
  it('the service spoke the text without the spaces around it: the places are those of MY text', () => {
    const t = '  “Run!” he cried.  ';
    const w = wordsFromAlignment(t, letters(t.trim(), 0.05, 0.2));
    expect(w.map((x) => word(t, x))).toEqual(['Run', 'he', 'cried']);
    expect(w[0].charStart).toBe(3);
    near(w[0].start, 0.2 + 0.05);                 // after the opening quotation mark
    near(w[0].end, 0.2 + 4 * 0.05);
  });
  it('a letter the service changed or left out is passed over; the other words keep their exact times', () => {
    const t = 'It costs $5 today, I’m sure.';
    // the service said it with a plain apostrophe and without the dollar sign
    const spoken = "It costs 5 today, I'm sure.";
    const w = wordsFromAlignment(t, letters(spoken));
    expect(w.map((x) => word(t, x))).toEqual(['It', 'costs', '5', 'today', 'I’m', 'sure']);
    near(w[2].start, 0.9); near(w[2].end, 1.0);
    near(w[4].start, spoken.indexOf("I'm") * 0.1); near(w[4].end, (spoken.indexOf("I'm") + 3) * 0.1);
    near(w[5].end, (spoken.length - 1) * 0.1);
  });
  it('a word with no letter found gets the gap between its neighbours; times never go back', () => {
    const t = 'one XXXXXXXX three';
    const w = wordsFromAlignment(t, letters('one three'));
    expect(w).toHaveLength(3);
    near(w[1].start, w[0].end);
    near(w[1].end, w[2].start);
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeGreaterThanOrEqual(w[i - 1].start);
    for (const x of w) expect(x.end).toBeGreaterThanOrEqual(x.start);
  });
  it('several letters in one entry, and an empty answer', () => {
    const t = 'so far';
    const a: Alignment = { characters: ['so', ' ', 'far'], character_start_times_seconds: [0, 0.3, 0.4], character_end_times_seconds: [0.3, 0.4, 0.9] };
    const w = wordsFromAlignment(t, a);
    expect(w.map((x) => [x.start, x.end])).toEqual([[0, 0.3], [0.4, 0.9]]);
    expect(wordsFromAlignment('Hello.', { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] })).toEqual([]);
    expect(wordsFromAlignment('…', letters('…'))).toEqual([]);
  });
});

describe('a voice without word times (Microsoft, OpenAI): estimated from the length of the sound', () => {
  const t = 'The cat sat, and the meticulous dog waited. Then it left.';
  it('the same shape; every word inside the sound, in order, none on top of another', () => {
    const w = estimateWordTimes(t, 6);
    expect(w.map((x) => word(t, x))).toEqual(['The', 'cat', 'sat', 'and', 'the', 'meticulous', 'dog', 'waited', 'Then', 'it', 'left']);
    expect(w[0].start).toBe(0);
    for (let i = 0; i < w.length; i++) {
      expect(w[i].end).toBeGreaterThan(w[i].start);
      if (i) expect(w[i].start).toBeGreaterThanOrEqual(w[i - 1].end - 1e-9);
    }
    expect(w[w.length - 1].end).toBeLessThanOrEqual(6);
  });
  it('a long word takes longer than a short one', () => {
    const w = estimateWordTimes(t, 6);
    const len = (i: number) => w[i].end - w[i].start;
    expect(len(5)).toBeGreaterThan(len(4) * 2.5);  // "meticulous" against "the"
    expect(len(7)).toBeGreaterThan(len(6));        // "waited" against "dog"
  });
  it('the voice rests after a comma, and longer after a full stop; not between plain words', () => {
    const w = estimateWordTimes(t, 6);
    const gap = (i: number) => w[i + 1].start - w[i].end;
    near(gap(0), 0);                                // The | cat
    expect(gap(2)).toBeGreaterThan(0.05);           // sat, | and
    expect(gap(7)).toBeGreaterThan(gap(2) * 1.5);   // waited. | Then
    const q = 'He said: “Stop!” — and she did; really?';
    const g = estimateWordTimes(q, 5);
    const gq = (i: number) => g[i + 1].start - g[i].end;
    expect(gq(1)).toBeGreaterThan(0);               // said: | Stop
    expect(gq(2)).toBeGreaterThan(gq(1));           // Stop!” | and
    expect(gq(5)).toBeGreaterThan(0);               // did; | really
  });
  it('the silence at the start and the end of the sound: the words lie between them', () => {
    const w = estimateWordTimes(t, 6, { lead: 0.4, tail: 0.6 });
    near(w[0].start, 0.4);
    near(w[w.length - 1].end, 5.4);
    // no numbers given: no silence at the start, a little at the end (the line is then early, never late)
    const d = estimateWordTimes(t, 6);
    expect(d[d.length - 1].end).toBeLessThan(6);
    expect(d[d.length - 1].end).toBeGreaterThan(5.5);
    // numbers that can not be right (more silence than sound) do not squeeze the words into nothing
    const odd = estimateWordTimes(t, 2, { lead: 3, tail: 3 });
    expect(odd[odd.length - 1].end - odd[0].start).toBeGreaterThan(0.75);
    expect(odd[odd.length - 1].end).toBeLessThanOrEqual(2);
  });
  it('twice the sound = twice the times; nothing to say = nothing', () => {
    const a = estimateWordTimes(t, 4, { lead: 0, tail: 0 }), b = estimateWordTimes(t, 8, { lead: 0, tail: 0 });
    a.forEach((w, i) => { near(w.start * 2, b[i].start); near(w.end * 2, b[i].end); });
    near(a[a.length - 1].end, 4);
    expect(estimateWordTimes('', 3)).toEqual([]);
    expect(estimateWordTimes('Hello.', 0)).toEqual([]);
    expect(estimateWordTimes('你好 world', 2).map((w) => [w.charStart, w.charEnd])).toEqual([[0, 2], [3, 8]]);
  });
});

describe('which word is being said now', () => {
  const times: WordTime[] = [
    { start: 0.3, end: 0.6, charStart: 0, charEnd: 3 },
    { start: 0.6, end: 1.0, charStart: 4, charEnd: 9 },
    { start: 1.4, end: 1.9, charStart: 11, charEnd: 15 },
  ];
  it('the line is on a word a little before the voice gets there (100 ms), never after', () => {
    expect(wordAt(times, 0)).toBe(-1);
    expect(wordAt(times, 0.19)).toBe(-1);
    expect(wordAt(times, 0.21)).toBe(0);
    expect(wordAt(times, 0.49)).toBe(0);
    expect(wordAt(times, 0.51)).toBe(1);
    // in the rest after a word the line stays on it, then moves on early
    expect(wordAt(times, 1.2)).toBe(1);
    expect(wordAt(times, 1.31)).toBe(2);
    expect(wordAt(times, 99)).toBe(2);
  });
  it('the lead can be set (0 = exactly with the voice); no words = no line', () => {
    expect(wordAt(times, 0.59, 0)).toBe(0);
    expect(wordAt(times, 0.6, 0)).toBe(1);
    expect(wordAt(times, 0.2, 0.25)).toBe(0);
    expect(wordAt([], 1)).toBe(-1);
  });
  it('with the estimated times of a whole sentence: every moment has the right word, in order', () => {
    const t = 'She had never seen such a quiet, empty street before.';
    const w = estimateWordTimes(t, 4);
    let last = -1;
    for (let s = 0; s <= 4; s += 0.02) { const i = wordAt(w, s); expect(i).toBeGreaterThanOrEqual(last); expect(i - last).toBeLessThanOrEqual(1); last = i; }
    expect(last).toBe(w.length - 1);
  });
});
