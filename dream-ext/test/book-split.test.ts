import { describe, it, expect } from 'vitest';
import { splitLong, splitChapters, needsSplit, wasCut, joinOldParts, partTitle, recut, offsetOfPlace, placeOfOffset, paragraphOfBlock, blockOfParagraph, searchBook, readLetters, storedLetter, MAX_BLOCK, PART_CHARS, PART_BLOCKS } from '../src/book-split';
import { chapterOf } from '../src/reader-text';
import { createSegmenter } from '@core/segment';
import type { RawChapter } from '../src/epub';

const p = (text: string, kind: 'p' | 'h1' | 'blockquote' = 'p') => ({ kind, text });
const sentence = (i: number) => `This is sentence number ${i} of a long story about a quiet garden. `;
/** a text of about `n` letters, whole sentences */
const long = (n: number, from = 0) => { let t = ''; for (let i = from; t.length < n; i++) t += sentence(i); return t; };
const letters = (cs: readonly RawChapter[]) => cs.reduce((n, c) => n + c.blocks.reduce((m, b) => m + b.text.length, 0), 0);
const textOf = (cs: readonly RawChapter[]) => cs.map((c) => c.blocks.map((b) => b.text).join('')).join('');

describe('I Know Book: a big book is kept in light parts', () => {
  it('the part size is the plan\'s: about 14,000 letters', () => {
    expect(PART_CHARS).toBe(14000);
    expect(MAX_BLOCK).toBe(1400);
  });

  it('a short paragraph is left as it is', () => {
    expect(splitLong('A short one. Two sentences.')).toEqual(['A short one. Two sentences.']);
  });

  it('a long paragraph is cut at the ends of sentences, never inside one, and no letter is lost', () => {
    const text = long(9000);
    const parts = splitLong(text);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.join('')).toBe(text);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_BLOCK);
      expect(part.trimEnd().endsWith('.')).toBe(true);
      expect(part.startsWith('This is sentence number')).toBe(true);
    }
  });

  it('"Mr. Smith", "J. K. Rowling", "e.g." and "..." in the middle of a sentence are no place to cut', () => {
    const one = 'Then Mr. Smith met J. K. Rowling, e.g. at noon... and they talked for a while about books. ';
    const text = one.repeat(60);
    const parts = splitLong(text, 200);
    expect(parts.join('')).toBe(text);
    for (const part of parts) { expect(part.startsWith('Then Mr. Smith')).toBe(true); expect(part.trimEnd().endsWith('books.')).toBe(true); }
  });

  it('a text that starts with dots, or has "!?" and quotes, is still whole after the cut', () => {
    const text = `...and so it began. "Stop!" she said?! He did not... ${long(3000)}"The end."`;
    expect(splitLong(text, 300).join('')).toBe(text);
  });

  it('a PDF text with no full stop at all is cut between words', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
    const parts = splitLong(text);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.join('')).toBe(text);
    for (const part of parts) { expect(part.length).toBeLessThanOrEqual(MAX_BLOCK); expect(/^word\d+ /.test(part)).toBe(true); expect(/word\d+ ?$/.test(part)).toBe(true); }
  });

  it('Chinese sentences (no spaces) are cut after 。', () => {
    const text = '这是一个很长的句子，用来测试。'.repeat(200);
    const parts = splitLong(text);
    expect(parts.join('')).toBe(text);
    for (const part of parts) { expect(part.length).toBeLessThanOrEqual(MAX_BLOCK); expect(part.endsWith('。')).toBe(true); }
  });

  it('a short book is not touched: the same chapters, and nothing "was cut"', () => {
    const book = [{ title: 'One', blocks: [p('Hello there.'), p('A second paragraph.')] }, { title: 'Two', blocks: [p('The end.')] }];
    const cut = splitChapters(book);
    expect(cut).toEqual(book);
    expect(needsSplit(book)).toBe(false);
    expect(wasCut(book, cut)).toBe(false);
  });

  it('one huge chapter (600,000 letters, as a PDF gives it) becomes parts of about 14,000 letters, at most 20,000', () => {
    const blocks = Array.from({ length: 1000 }, (_, i) => p(`Paragraph ${i} begins here. ${long(570, i * 10)}`.trim()));
    const book = [{ title: '', blocks }];
    expect(needsSplit(book)).toBe(true);
    const cut = splitChapters(book);
    expect(wasCut(book, cut)).toBe(true);
    expect(textOf(cut)).toBe(textOf(book));
    expect(cut.length).toBeGreaterThan(35);
    const sizes = cut.map((c) => letters([c]));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20000);
    expect(Math.min(...sizes)).toBeGreaterThan(PART_CHARS / 5 - 1);
    expect(cut[0].title).toBe(`Part 1 of ${cut.length}`);
    expect(cut[cut.length - 1].title).toBe(`Part ${cut.length} of ${cut.length}`);
    // (cut once is enough: the parts are light now)
    expect(needsSplit(cut)).toBe(false);
    expect(splitChapters(cut)).toEqual(cut);
  });

  it('one paragraph of 600,000 letters (a PDF with no paragraph breaks) is cut too', () => {
    const book = [{ title: 'Whole', blocks: [p(long(600000))] }];
    const cut = splitChapters(book);
    expect(textOf(cut)).toBe(textOf(book));
    expect(Math.max(...cut.map((c) => letters([c])))).toBeLessThanOrEqual(20000);
    expect(Math.max(...cut.flatMap((c) => c.blocks.map((b) => b.text.length)))).toBeLessThanOrEqual(MAX_BLOCK);
    expect(partTitle(cut[1].title)).toEqual({ base: 'Whole', part: 2, of: cut.length });
    expect(needsSplit(cut)).toBe(false);
  });

  it('a chapter of very many short lines is cut by their number, and the last few lines go with the part before', () => {
    const book = [{ title: 'Poem', blocks: Array.from({ length: 2 * PART_BLOCKS + 20 }, (_, i) => p(`Line ${i}.`)) }];
    const cut = splitChapters(book);
    expect(cut.map((c) => c.blocks.length)).toEqual([PART_BLOCKS, PART_BLOCKS + 20]);
    expect(needsSplit(cut)).toBe(false);
  });

  it('headings stay whole; a long quote is cut like a paragraph and stays a quote', () => {
    const book = [{ title: 'T', blocks: [p('A title', 'h1'), p(long(4000), 'blockquote')] }];
    const cut = splitChapters(book);
    expect(cut).toHaveLength(1);
    expect(cut[0].blocks[0]).toEqual(p('A title', 'h1'));
    expect(cut[0].blocks.length).toBeGreaterThan(3);
    expect(cut[0].blocks.slice(1).every((b) => b.kind === 'blockquote')).toBe(true);
  });

  it('the title of a part: the real title and "Part 2 of 7"', () => {
    expect(partTitle('The Storm · Part 2 of 7')).toEqual({ base: 'The Storm', part: 2, of: 7 });
    expect(partTitle('Part 3 of 40')).toEqual({ base: '', part: 3, of: 40 });
    expect(partTitle('The Storm')).toEqual({ base: 'The Storm', part: 1, of: 1 });
    expect(partTitle('')).toEqual({ base: '', part: 1, of: 1 });
  });

  it('the place is a letter count: there and back gives the same paragraph', () => {
    const book = [{ title: 'A', blocks: [p('One.'), p('   '), p('Two two.'), p('Three.')] }, { title: 'B', blocks: [p('Four.'), p('Five five five.')] }];
    // (the empty block is no paragraph)
    expect(paragraphOfBlock(book[0], 2)).toBe(1);
    expect(blockOfParagraph(book[0], 2)).toBe(3);
    expect(offsetOfPlace(book, { chapter: 0, paragraph: 0 })).toBe(0);
    expect(offsetOfPlace(book, { chapter: 0, paragraph: 1 })).toBe(7);
    expect(offsetOfPlace(book, { chapter: 1, paragraph: 1 })).toBe(4 + 3 + 8 + 6 + 5);
    for (let c = 0; c < book.length; c++) for (let n = 0; n < (c === 0 ? 3 : 2); n++) {
      const back = placeOfOffset(book, offsetOfPlace(book, { chapter: c, paragraph: n }));
      expect([back.chapter, back.paragraph, back.within]).toEqual([c, n, 0]);
    }
    expect(placeOfOffset(book, 99999)).toMatchObject({ chapter: 1, paragraph: 1 });
    expect(placeOfOffset(book, offsetOfPlace(book, { chapter: 1, paragraph: 1 }, 5))).toMatchObject({ chapter: 1, paragraph: 1, within: 5 });
  });

  it('a book stored the old way is cut with the reader still at the same paragraph', () => {
    const blocks = Array.from({ length: 900 }, (_, i) => p(`Paragraph ${i} begins here. ${long(600, i)}`.trim()));
    const old = [{ title: 'Intro', blocks: [p('Hello.')] }, { title: '', blocks }];
    for (const n of [0, 1, 250, 611, 899]) {
      const r = recut(old, { chapter: 1, paragraph: n });
      expect(needsSplit(r.chapters)).toBe(false);
      expect(r.place.chapter).toBeGreaterThan(n > 30 ? 1 : 0);
      const block = r.chapters[r.place.chapter].blocks[blockOfParagraph(r.chapters[r.place.chapter], r.place.paragraph)];
      expect(block.text.startsWith(`Paragraph ${n} begins here.`)).toBe(true);
      expect(r.place.within).toBe(0);
    }
  });

  it('...and at the same sentence, when its paragraph itself was cut (one PDF "paragraph" of 300 pages)', () => {
    const seg = createSegmenter();
    const text = long(300000);
    const old = [{ title: '', blocks: [p(text)] }];
    const was = chapterOf(old[0], 0, seg).paragraphs[0];
    for (const s of [0, 7, 1234, was.sentences.length - 1]) {
      const r = recut(old, { chapter: 0, paragraph: 0 }, was.sentences[s].start);
      const ch = r.chapters[r.place.chapter];
      const block = ch.blocks[blockOfParagraph(ch, r.place.paragraph)];
      // (the letter the old sentence started at is the start of a sentence in its new paragraph)
      expect(block.text.slice(r.place.within).startsWith(`This is sentence number ${s} of`)).toBe(true);
    }
  });

  it('the reader\'s letters and the stored letters (runs of spaces are one space for the reader, none in front)', () => {
    const stored = '  One  two.\n\nThree   four. Five.';
    const read = 'One two. Three four. Five.';
    for (const w of ['One', 'two', 'Three', 'four', 'Five']) {
      expect(storedLetter(stored, read.indexOf(w))).toBe(stored.indexOf(w));
      expect(readLetters(stored, stored.indexOf(w))).toBe(read.indexOf(w));
    }
    expect(storedLetter('abc', 0)).toBe(0);
    expect(readLetters('abc', 2)).toBe(2);
    expect(storedLetter('abc', 99)).toBe(3);
  });

  it('parts made the old way ("Title (2 of 5)", 250 paragraphs each) are put together before the new cut names them', () => {
    const mk = (title: string, from: number, n: number) => ({ title, blocks: Array.from({ length: n }, (_, i) => p(`Old paragraph ${from + i}. ${long(300, i)}`.trim())) });
    const old = [mk('Storm (1 of 3)', 0, 250), mk('Storm (2 of 3)', 250, 250), mk('Storm (3 of 3)', 500, 100), mk('Part (1 of 2)', 600, 250), mk('Part (2 of 2)', 850, 30), mk('Calm', 880, 3)];
    const joined = joinOldParts(old);
    expect(joined.map((c) => [c.title, c.blocks.length])).toEqual([['Storm', 600], ['', 280], ['Calm', 3]]);
    expect(textOf(joined)).toBe(textOf(old));
    const r = recut(old, { chapter: 1, paragraph: 40 });
    expect(textOf(r.chapters)).toBe(textOf(old));
    const titles = r.chapters.map((c) => c.title);
    expect(titles[0]).toMatch(/^Storm · Part 1 of \d+$/);
    expect(titles.some((t) => /\(\d+ of \d+\)/.test(t))).toBe(false);
    expect(titles[titles.length - 1]).toBe('Calm');
    const ch = r.chapters[r.place.chapter];
    expect(ch.blocks[blockOfParagraph(ch, r.place.paragraph)].text.startsWith('Old paragraph 290.')).toBe(true);
  });

  it('search: every place, big or small letters alike, with the words around it; a limit says there is more', () => {
    const book = [{ title: 'A', blocks: [p('The Garden was quiet.'), p('Nobody was there.')] }, { title: 'B', blocks: [p('In the  garden,\nthe garden gate was open.')] }];
    const r = searchBook(book, '  the GARDEN ');
    expect(r.more).toBe(false);
    expect(r.hits.map((h) => [h.chapter, h.block, h.at, h.match])).toEqual([[0, 0, 0, 'The Garden'], [1, 0, 3, 'the garden'], [1, 0, 15, 'the garden']]);
    expect(r.hits[1].before).toBe('In ');
    expect(r.hits[1].after).toBe(', the garden gate was open.');
    expect(searchBook(book, 'x').hits).toEqual([]);
    expect(searchBook(book, 'unicorn').hits).toEqual([]);
    const many = searchBook([{ title: '', blocks: [p('go go go go go go')] }], 'go', 4);
    expect(many.hits).toHaveLength(4);
    expect(many.more).toBe(true);
  });
});
