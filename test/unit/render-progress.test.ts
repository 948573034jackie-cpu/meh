import { describe, it, expect } from 'vitest';
import { makeBook } from './helpers';
import { indexBook, wordsBefore, timeAt, totalTime, positionAtTime, positionAtWords, chapterMarks, fractionAt, wordsLeft, formatMinutes, formatClock, progressText, nextProgressKind, wordsPerMinute, clampRate, bookPages, sentenceIndexAt } from '../../src/renderer/reader/progress';

const book = makeBook([
  { title: 'One', paragraphs: ['Alpha beta gamma. Delta epsilon.', 'Zeta eta theta iota.'] }, // 5 + 4 = 9 words
  { title: 'Two', paragraphs: ['Kappa lambda mu nu xi omicron.'] }, // 6 words
  { title: 'Three', paragraphs: ['Pi rho sigma tau upsilon.'] }, // 5 words
]);

describe('book index', () => {
  it('counts words per sentence and chapter', () => {
    const idx = indexBook(book);
    expect(idx.totalWords).toBe(20);
    expect(idx.sentences.map((s) => s.words)).toEqual([3, 2, 4, 6, 5]);
    expect(idx.chapters.map((c) => [c.before, c.words])).toEqual([[0, 9], [9, 6], [15, 5]]);
  });
  it('maps positions to word offsets and back', () => {
    const idx = indexBook(book);
    expect(wordsBefore(idx, { chapter: 0, paragraph: 0, sentence: 1 })).toBe(3);
    expect(wordsBefore(idx, { chapter: 2, paragraph: 0, sentence: 0 })).toBe(15);
    expect(sentenceIndexAt(idx, { chapter: 1, paragraph: 0, sentence: 0 })).toBe(3);
    expect(positionAtWords(idx, 0)).toEqual({ chapter: 0, paragraph: 0, sentence: 0 });
    expect(positionAtWords(idx, 4)).toEqual({ chapter: 0, paragraph: 0, sentence: 1 });
    expect(positionAtWords(idx, 9)).toEqual({ chapter: 1, paragraph: 0, sentence: 0 });
    expect(positionAtWords(idx, 999)).toEqual({ chapter: 2, paragraph: 0, sentence: 0 });
    expect(positionAtWords(indexBook(makeBook([])), 3)).toBeNull();
  });
});

describe('timeline', () => {
  const idx = indexBook(book);
  it('time at a position and total time follow the words per minute', () => {
    expect(totalTime(idx, 60)).toBe(20); // 20 words at 60 wpm = 20 s
    expect(timeAt(idx, { chapter: 1, paragraph: 0, sentence: 0 }, 60)).toBe(9);
    expect(timeAt(idx, { chapter: 0, paragraph: 0, sentence: 0 }, 60)).toBe(0);
  });
  it('seeking by time lands on the sentence being read then', () => {
    expect(positionAtTime(idx, 0, 60)).toEqual({ chapter: 0, paragraph: 0, sentence: 0 });
    expect(positionAtTime(idx, 3.5, 60)).toEqual({ chapter: 0, paragraph: 0, sentence: 1 });
    expect(positionAtTime(idx, 9, 60)).toEqual({ chapter: 1, paragraph: 0, sentence: 0 });
    expect(positionAtTime(idx, 100, 60)).toEqual({ chapter: 2, paragraph: 0, sentence: 0 });
    expect(positionAtTime(idx, -5, 60)).toEqual({ chapter: 0, paragraph: 0, sentence: 0 });
  });
  it('chapter marks are fractions of the book', () => {
    expect(chapterMarks(idx)).toEqual([{ index: 0, title: 'One', at: 0 }, { index: 1, title: 'Two', at: 0.45 }, { index: 2, title: 'Three', at: 0.75 }]);
    expect(fractionAt(idx, { chapter: 2, paragraph: 0, sentence: 0 })).toBe(0.75);
  });
  it('words left in chapter and book', () => {
    expect(wordsLeft(idx, { chapter: 0, paragraph: 0, sentence: 1 })).toEqual({ chapter: 6, book: 17 });
    expect(wordsLeft(idx, { chapter: 2, paragraph: 0, sentence: 0 })).toEqual({ chapter: 5, book: 5 });
  });
  it('wpm: the voice pace when listening or playing, 200 when reading silently', () => {
    expect(wordsPerMinute('listening', 1, false)).toBe(160);
    expect(wordsPerMinute('listening', 1.5, true)).toBe(240);
    expect(wordsPerMinute('reading', 1.5, false)).toBe(200);
    expect(wordsPerMinute('reading', 1.5, true)).toBe(240);
    expect(wordsPerMinute('listening', NaN, true)).toBe(160);
  });
});

describe('formatting', () => {
  it('minutes', () => {
    expect(formatMinutes(0.3)).toBe('less than a minute');
    expect(formatMinutes(12.4)).toBe('12 min');
    expect(formatMinutes(130)).toBe('2 h 10 min');
    expect(formatMinutes(65)).toBe('1 h 05 min');
    expect(formatMinutes(120)).toBe('2 h');
  });
  it('clock', () => {
    expect(formatClock(5020)).toBe('1:23:40');
    expect(formatClock(33120)).toBe('9:12:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(0)).toBe('0:00');
  });
  it('progress text cycles through its four kinds', () => {
    const p = { page: 12, pageCount: 240, wordsLeftChapter: 2400, wordsLeftBook: 26000, wpm: 200, fraction: 0.345 };
    expect(progressText('page', p)).toBe('Page 12 of 240');
    expect(progressText('chapter', p)).toBe('12 min left in chapter');
    expect(progressText('book', p)).toBe('2 h 10 min left in book');
    expect(progressText('percent', p)).toBe('34%');
    expect(nextProgressKind('page')).toBe('chapter');
    expect(nextProgressKind('percent')).toBe('page');
  });
  it('rates clamp to 0.5–2.0 in tenths', () => {
    expect(clampRate(0.1 + 0.2 + 1)).toBe(1.3);
    expect(clampRate(0.2)).toBe(0.5);
    expect(clampRate(3)).toBe(2);
    expect(clampRate(NaN)).toBe(1);
  });
  it('whole-book pages are extrapolated from the laid-out chapter', () => {
    const idx = indexBook(book);
    // chapter 1 (9 words) shown as 3 pages -> 3 words per page -> 20 words = 7 pages
    expect(bookPages(idx, 0, 0, 3)).toEqual({ page: 1, total: 7, wordsPerPage: 3 });
    expect(bookPages(idx, 0, 2, 3)).toEqual({ page: 3, total: 7, wordsPerPage: 3 });
    expect(bookPages(idx, 1, 0, 2)).toEqual({ page: 4, total: 7, wordsPerPage: 3 });
    expect(bookPages(idx, 2, 5, 1).page).toBe(4);
  });
});
