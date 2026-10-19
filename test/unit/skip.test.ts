import { describe, it, expect } from 'vitest';
import type { Paragraph } from '@core/model';
import { classifySkippable, buildSkipContext, skippedSentences, stripInline, toOriginalRange, isCitation, DEFAULT_SKIP, skipAll, allSkipped, SKIP_OPTIONS, type SkipSettings } from '@core/import/skip';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { makeBook } from './helpers';

const para = (text: string, kind: Paragraph['kind'] = 'p'): Paragraph => ({ index: 0, kind, text, sentences: [] });
const only = (...on: (keyof SkipSettings)[]): SkipSettings => ({ ...skipAll(false), ...Object.fromEntries(on.map((c) => [c, true])) });

describe('skip settings', () => {
  it('defaults to page numbers only and is persisted in settings', () => {
    expect(Object.entries(DEFAULT_SKIP).filter(([, v]) => v).map(([k]) => k)).toEqual(['pageNumbers']);
    expect(DEFAULT_SETTINGS.skip).toEqual(DEFAULT_SKIP);
  });
  it('skipAll toggles every category; options follow Speechify order', () => {
    expect(allSkipped(skipAll())).toBe(true);
    expect(Object.values(skipAll(false)).some(Boolean)).toBe(false);
    expect(SKIP_OPTIONS.slice(0, 8).map((o) => o.label)).toEqual(['Headers', 'Footers', 'Footnotes', 'Braces', 'Citations', 'Parentheses', 'Brackets', 'URLs']);
  });
});

describe('classifySkippable', () => {
  it('page numbers', () => {
    for (const t of ['12', '- 12 -', 'Page 12', 'page 3 of 10', 'xii', '— 7 —']) expect(classifySkippable(para(t)), t).toBe('pageNumbers');
    for (const t of ['I', 'It was 12 o’clock.', '1984 was a year.']) expect(classifySkippable(para(t)), t).toBeNull();
  });
  it('table of contents lines', () => {
    expect(classifySkippable(para('Chapter 1: The Beginning ........ 7'))).toBe('toc');
    expect(classifySkippable(para('Preface . . . . . ix'))).toBe('toc');
    expect(classifySkippable(para('He waited... 3 hours.'))).toBeNull();
  });
  it('captions', () => {
    expect(classifySkippable(para('Figure 1: The water cycle.'))).toBe('captions');
    expect(classifySkippable(para('Table 2. Results by year'))).toBe('captions');
    expect(classifySkippable(para('Fig. 3 – A map of London'))).toBe('captions');
    expect(classifySkippable(para('A picture of a cat', 'caption'))).toBe('captions');
    expect(classifySkippable(para('Table 2 shows the results.'))).toBeNull();
  });
  it('footnotes', () => {
    expect(classifySkippable(para('1 See the appendix for details.'))).toBe('footnotes');
    expect(classifySkippable(para('[3] Smith, J. A History of Tea.'))).toBe('footnotes');
    expect(classifySkippable(para('^2 Ibid.'))).toBe('footnotes');
    expect(classifySkippable(para('* Not his real name.'))).toBe('footnotes');
    expect(classifySkippable(para('12 men walked in.'))).toBeNull();
    expect(classifySkippable(para('1 First step', 'li'))).toBeNull();
  });
  it('citation-only paragraphs', () => {
    expect(classifySkippable(para('[12]'))).toBe('citations');
    expect(classifySkippable(para('[1, 3–5]'))).toBe('citations');
  });
  it('running headers and footers repeated across the book', () => {
    const book = makeBook([
      { title: 'One', paragraphs: ['Pride and Prejudice', 'It is a truth universally acknowledged.', '© 2020 Penguin Books', 'More text here.', 'Pride and Prejudice'] },
      { title: 'Two', paragraphs: ['Pride and Prejudice 23', 'Another story begins.', '© 2020 Penguin Books'] },
      { title: 'Three', paragraphs: ['Chapter Three', 'Text.', '© 2020 Penguin Books'] },
    ]);
    book.chapters[2].paragraphs[0].kind = 'h1';
    const repeated = buildSkipContext(book);
    expect(classifySkippable(book.chapters[1].paragraphs[0], { repeated })).toBe('headers');
    expect(classifySkippable(book.chapters[0].paragraphs[2], { repeated })).toBe('footers');
    expect(classifySkippable(book.chapters[0].paragraphs[1], { repeated })).toBeNull();
    expect(classifySkippable(book.chapters[2].paragraphs[0], { repeated })).toBeNull();
    // without the book context nothing is a running header
    expect(classifySkippable(book.chapters[1].paragraphs[0])).toBeNull();
  });
});

describe('skippedSentences', () => {
  it('returns c.p.s keys of skipped paragraphs and of sentences left empty by inline stripping', () => {
    const book = makeBook([{ title: 'A', paragraphs: ['14', 'Hello there. (See Figure 2.) Bye now.', 'Figure 2: A cat.'] }]);
    expect([...skippedSentences(book, DEFAULT_SKIP)]).toEqual(['0.0.0']);
    expect([...skippedSentences(book, only('parentheses', 'captions'))].sort()).toEqual(['0.1.1', '0.2.0']);
    expect(skippedSentences(book, skipAll(false)).size).toBe(0);
  });
});

describe('stripInline', () => {
  it('removes parentheses, brackets and braces only when switched on', () => {
    const t = 'He left (quickly) and [sadly] went {home}.';
    expect(stripInline(t, only('parentheses')).text).toBe('He left and [sadly] went {home}.');
    expect(stripInline(t, only('brackets')).text).toBe('He left (quickly) and went {home}.');
    expect(stripInline(t, only('braces')).text).toBe('He left (quickly) and [sadly] went.');
    expect(stripInline(t, skipAll(false)).text).toBe(t);
  });
  it('removes citations but keeps other parentheses', () => {
    const t = 'Tea is popular (Smith, 2020) and cheap (mostly) [12], says Lee (2019).';
    expect(stripInline(t, only('citations')).text).toBe('Tea is popular and cheap (mostly), says Lee.');
    expect(isCitation('Smith et al. 2019; Lee & Park, 2021, p. 4', '(')).toBe(true);
    expect(isCitation('1, 3–5', '[')).toBe(true);
    expect(isCitation('mostly', '(')).toBe(false);
  });
  it('removes URLs without the sentence full stop', () => {
    const r = stripInline('Visit https://example.com/a?b=1. Or www.test.org today.', only('urls'));
    expect(r.text).toBe('Visit. Or today.');
  });
  it('removes superscript note markers with footnotes on', () => {
    expect(stripInline('It was true.¹ Really²', only('footnotes')).text).toBe('It was true. Really');
  });
  it('handles nesting and unmatched brackets', () => {
    expect(stripInline('A (b (c) d) e.', only('parentheses')).text).toBe('A e.');
    expect(stripInline('A b) c (d', only('parentheses')).text).toBe('A b) c (d');
    expect(stripInline('(Note) Start here.', only('parentheses')).text).toBe('Start here.');
  });
  it('maps stripped offsets back to the original text', () => {
    const t = 'He left (quickly) and went home.';
    const r = stripInline(t, only('parentheses'));
    expect(r.text).toBe('He left and went home.');
    expect(r.map.length).toBe(r.text.length + 1);
    for (let i = 0; i < r.text.length; i++) expect(t[r.map[i]]).toBe(r.text[i]);
    const andAt = r.text.indexOf('and');
    expect(toOriginalRange(r, andAt, 3)).toEqual({ charIndex: t.indexOf('and'), charLength: 3 });
    expect(r.removed).toEqual([[7, 17]]);
  });
});
