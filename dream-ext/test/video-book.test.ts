import { describe, it, expect } from 'vitest';
import { buildVideoBook, alignTokenTimes } from '../src/video-book';
import { getSentence } from '@core/nav';

const words = (text: string, t0: number, step = 0.4) => text.split(' ').map((w, i) => ({ w, t: t0 + i * step, e: t0 + (i + 1) * step }));

describe('a YouTube video as a Dream Read book', () => {
  const sentences = [
    { start: 0, end: 2.4, text: 'Hello everyone, welcome to the show.', words: words('hello everyone, welcome to the show.', 0) },
    { start: 2.4, end: 4, text: 'Today we learn English.', words: words('today we learn English.', 2.4) },
    { start: 10, end: 12, text: 'It is a well-known story.', words: words('it is a well-known story.', 10) },
  ];
  const vb = buildVideoBook({ id: 'abc12345678', title: 'Lesson 1' }, sentences);

  it('keeps every subtitle sentence as one sentence, in paragraphs split at long pauses', () => {
    expect(vb.book.id).toBe('yt:abc12345678');
    expect(vb.book.chapters).toHaveLength(1);
    const paras = vb.book.chapters[0].paragraphs;
    expect(paras.map((p) => p.sentences.length)).toEqual([2, 1]);
    expect(getSentence(vb.book, { chapter: 0, paragraph: 0, sentence: 1 })?.text).toBe('Today we learn English.');
    expect(vb.order).toHaveLength(3);
  });

  it('gives each word the time it is spoken', () => {
    const t = vb.timingOf({ chapter: 0, paragraph: 0, sentence: 0 })!;
    const s = getSentence(vb.book, { chapter: 0, paragraph: 0, sentence: 0 })!;
    const welcome = s.sentence.tokens.findIndex((tk) => tk.text === 'welcome');
    expect(t.tokenStart[welcome]).toBeCloseTo(0.8);
    expect(s.text.slice(t.tokenChar[welcome], t.tokenChar[welcome] + 7)).toBe('welcome');
    // "well-known" is one token here; the word after it keeps its own time
    const t3 = vb.timingOf({ chapter: 0, paragraph: 1, sentence: 0 })!;
    const s3 = getSentence(vb.book, { chapter: 0, paragraph: 1, sentence: 0 })!;
    expect(t3.tokenStart[s3.sentence.tokens.findIndex((tk) => tk.text === 'well-known')]).toBeCloseTo(11.2);
    expect(t3.tokenStart[s3.sentence.tokens.findIndex((tk) => tk.text === 'story')]).toBeCloseTo(11.6);
    // a token that is part of a subtitle word, and one that spans two
    const toks = ['well', 'known', 'cannot', 'go'].map((text, i) => ({ start: i * 10, end: i * 10 + text.length, text, kind: 'word' as const }));
    const r = alignTokenTimes(toks, [{ w: 'well-known', t: 1, e: 2 }, { w: 'can', t: 2, e: 2.5 }, { w: 'not', t: 2.5, e: 3 }, { w: 'go', t: 3, e: 4 }], 0, 4);
    expect(r.s).toEqual([1, 1, 2, 3]);
    expect(r.e[2]).toBe(3);
  });

  it('finds the sentence at a time', () => {
    expect(vb.positionAt(0)).toEqual({ chapter: 0, paragraph: 0, sentence: 0 });
    expect(vb.positionAt(3)).toEqual({ chapter: 0, paragraph: 0, sentence: 1 });
    expect(vb.positionAt(7)).toEqual({ chapter: 0, paragraph: 0, sentence: 1 });
    expect(vb.positionAt(11)).toEqual({ chapter: 0, paragraph: 1, sentence: 0 });
    expect(vb.positionAt(-5)).toEqual({ chapter: 0, paragraph: 0, sentence: 0 });
  });

  it('fills in words that do not line up', () => {
    const toks = [{ start: 0, end: 3, text: 'Foo', kind: 'word' as const }, { start: 3, end: 4, text: ' ', kind: 'space' as const }, { start: 4, end: 7, text: 'bar', kind: 'word' as const }];
    const r = alignTokenTimes(toks, [{ w: 'zzz', t: 1, e: 2 }], 0, 4);
    expect(r.s[0]).toBeCloseTo(0); expect(r.s[2]).toBeCloseTo(2); expect(r.s[1]).toBeNull();
  });

  it('works without word times (a subtitle file)', () => {
    const v2 = buildVideoBook({ id: 'x', title: 't' }, [{ start: 5, end: 9, text: 'One two three four.' }]);
    const t = v2.timingOf({ chapter: 0, paragraph: 0, sentence: 0 })!;
    expect(t.tokenStart.filter((x) => x !== null)).toEqual([5, 6, 7, 8]);
  });
});
