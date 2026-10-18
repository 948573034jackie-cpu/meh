import { describe, it, expect } from 'vitest';
import { textImporter, textToBook, assembleParagraphs, computeStats, normalizeWhitespace, decodeTextBytes, joinWrappedLines, cleanInline, looksLikeHeading, parseTextBlocks } from '@core/import/text';
import type { ImportContext } from '@core/import/types';
import type { Segmenter } from '@core/segment';
import type { Book, Sentence, Token } from '@core/model';

// ---------------------------------------------------------------------------------------------
// Test segmenter stub (the real one is written concurrently): sentences on . ! ?, tokens by regex.
// ---------------------------------------------------------------------------------------------

function stubSegmenter(): Segmenter {
  const tokenize = (text: string, base: number): Token[] => {
    const out: Token[] = [];
    const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*|[^\s\p{L}\p{N}]+/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const kind = /^\p{L}/u.test(m[0]) ? 'word' : /^\p{N}/u.test(m[0]) ? 'number' : 'punct';
      out.push({ start: base + m.index, end: base + m.index + m[0].length, text: m[0], kind });
    }
    return out;
  };
  return {
    segmentParagraph(text: string): Sentence[] {
      const out: Sentence[] = [];
      const re = /[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const raw = m[0];
        const start = m.index + (raw.length - raw.trimStart().length);
        const end = m.index + raw.trimEnd().length;
        if (end <= start) continue;
        out.push({ index: out.length, start, end, tokens: tokenize(text.slice(start, end), start) });
      }
      return out;
    },
    tokenize(text: string): Token[] { return tokenize(text, 0); },
  };
}

const ctx = (extra: Partial<ImportContext> = {}): ImportContext => ({ segmenter: stubSegmenter(), id: 'text-id', ...extra });
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));
const kinds = (book: Book): [string, string][] => book.chapters.flatMap((c) => c.paragraphs.map((p): [string, string] => [p.kind, p.text]));

/** Structural invariants every imported book must satisfy. */
function checkBook(book: Book): void {
  expect(book.names).toEqual([]);
  let paragraphs = 0, sentences = 0, words = 0;
  book.chapters.forEach((ch, ci) => {
    expect(ch.index).toBe(ci);
    expect(ch.title.length).toBeGreaterThan(0);
    expect(ch.paragraphs.length).toBeGreaterThan(0);
    ch.paragraphs.forEach((p, pi) => {
      expect(p.index).toBe(pi);
      expect(p.text.length).toBeGreaterThan(0);
      expect(p.text).toBe(p.text.trim());
      expect(p.text).not.toMatch(/\s\s|[\t\n ]/);
      expect(p.sentences.length).toBeGreaterThan(0);
      paragraphs++;
      sentences += p.sentences.length;
      for (const s of p.sentences) for (const t of s.tokens) if (t.kind === 'word' || t.kind === 'number') words++;
    });
  });
  expect(book.stats).toEqual({ words, paragraphs, sentences });
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('textImporter: paragraphs', () => {
  it('splits on blank lines and joins hard-wrapped lines with a space', async () => {
    const book = await textImporter.importBytes(bytes('First line of one.\nSecond line of one.\n\n\nParagraph two.\n'), ctx());
    checkBook(book);
    expect(kinds(book)).toEqual([['p', 'First line of one. Second line of one.'], ['p', 'Paragraph two.']]);
    expect(book.chapters.map((c) => c.title)).toEqual(['Text']);
    expect(book.source).toEqual({ kind: 'text', importedAt: expect.any(String) });
    expect(book.id).toBe('text-id');
  });

  it('strips the BOM, accepts CRLF and whitespace-only lines as blank, and collapses tabs', async () => {
    const book = await textImporter.importBytes(bytes('﻿One.\r\nstill one.\r\n \t\r\nTwo\twith\ttabs.'), ctx());
    expect(kinds(book)).toEqual([['p', 'One. still one.'], ['p', 'Two with tabs.']]);
    expect(book.title).toBe('One. still one.');
  });

  it('decodes UTF-16 with a BOM', async () => {
    const le = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello wide.', 'utf16le')]));
    const book = await textImporter.importBytes(le, ctx());
    expect(kinds(book)).toEqual([['p', 'Hello wide.']]);
    const beBuf = Buffer.from('Big end.', 'utf16le').swap16();
    expect(decodeTextBytes(new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), beBuf])))).toBe('Big end.');
  });

  it('re-joins a word hyphenated across a line break but keeps hyphens before capitals', () => {
    expect(joinWrappedLines(['some-', 'thing happened', 'to the well-', 'known man'])).toBe('something happened to the wellknown man');
    expect(joinWrappedLines(['the Anglo-', 'Saxon'])).toBe('the Anglo- Saxon');
    expect(joinWrappedLines(['  a  ', '', ' b '])).toBe('a b');
  });

  it('never produces an empty paragraph', async () => {
    const book = await textToBook('T', 'Real.\n\n   \n\n​\n\n---\n\n***\n\nMore.', ctx());
    checkBook(book);
    expect(kinds(book)).toEqual([['p', 'Real.'], ['p', 'More.']]);
  });

  it('throws when there is no readable text', async () => {
    await expect(textToBook('T', '   \n\n\t\n', ctx())).rejects.toThrow(/No readable text/);
    await expect(textImporter.importBytes(new Uint8Array(0), ctx())).rejects.toThrow(/No readable text/);
  });
});

describe('textImporter: headings, lists and quotes', () => {
  it('turns Markdown # headings into h1/h2/h3 and strips the hashes', async () => {
    const book = await textToBook('', '# Title One #\n\n## Sub ##\n\n### Third\n\n#### Fourth\n\n#hashtag not heading.\n\nBody.', ctx());
    expect(kinds(book)).toEqual([['h1', 'Title One'], ['h2', 'Sub'], ['h3', 'Third'], ['h3', 'Fourth'], ['p', '#hashtag not heading.'], ['p', 'Body.']]);
    expect(book.title).toBe('Title One');
  });

  it('treats a heading line directly followed by text as a separate paragraph', async () => {
    const book = await textToBook('', '## Heading\nText right under it.\nSecond line.', ctx());
    expect(kinds(book)).toEqual([['h2', 'Heading'], ['p', 'Text right under it. Second line.']]);
  });

  it('recognises setext headings', async () => {
    const book = await textToBook('', 'Main Title\n==========\n\nSection\n---\n\nBody text.', ctx());
    expect(kinds(book)).toEqual([['h1', 'Main Title'], ['h2', 'Section'], ['p', 'Body text.']]);
  });

  it('treats a lone short line without terminal punctuation as a heading when text follows', async () => {
    const text = 'Chapter 1\n\nThe quick brown fox jumped over the lazy dog, as it always does.\n\nA very long line that goes on and on and on and on and on and on and on and on and on and on\n\nEnds with period.\n\nThe end';
    const book = await textToBook('', text, ctx());
    expect(kinds(book)).toEqual([
      ['h2', 'Chapter 1'],
      ['p', 'The quick brown fox jumped over the lazy dog, as it always does.'],
      ['p', 'A very long line that goes on and on and on and on and on and on and on and on and on and on'],
      ['p', 'Ends with period.'],
      ['p', 'The end'], // nothing follows it
    ]);
  });

  it('heading heuristic details', () => {
    expect(looksLikeHeading('Chapter 1')).toBe(true);
    expect(looksLikeHeading('XII')).toBe(true);
    expect(looksLikeHeading('The Old Man and the Sea')).toBe(true);
    expect(looksLikeHeading('1984')).toBe(true);
    expect(looksLikeHeading('Part One: The Beginning')).toBe(true);
    expect(looksLikeHeading('Short sentence.')).toBe(false);
    expect(looksLikeHeading('Really?')).toBe(false);
    expect(looksLikeHeading('and then he left')).toBe(false); // lower-case start
    expect(looksLikeHeading('“Quoted”')).toBe(false);
    expect(looksLikeHeading('One two three four five six seven eight nine ten eleven twelve thirteen')).toBe(false);
    expect(looksLikeHeading('')).toBe(false);
  });

  it('turns "- ", "* ", "+ " and numbered lines into list items, with wrapped continuation lines', async () => {
    const book = await textToBook('', '- First item\n  wrapped here\n* Second\n+ Third\n1. Numbered one\n2) Numbered two\n\nNot a list - dash inside.', ctx());
    expect(kinds(book)).toEqual([
      ['li', 'First item wrapped here'], ['li', 'Second'], ['li', 'Third'], ['li', 'Numbered one'], ['li', 'Numbered two'],
      ['p', 'Not a list - dash inside.'],
    ]);
  });

  it('turns "> " lines into block quotes, splitting on bare ">" and allowing lazy continuation', async () => {
    const book = await textToBook('', '> Quoted line one\n> quoted line two\nlazy continuation\n>\n> Second quote.\n\nPlain.', ctx());
    expect(kinds(book)).toEqual([['blockquote', 'Quoted line one quoted line two lazy continuation'], ['blockquote', 'Second quote.'], ['p', 'Plain.']]);
  });

  it('turns fenced code into one pre paragraph and drops horizontal rules', async () => {
    const book = await textToBook('', 'Before.\n\n```js\nlet x = 1;\n\nlet y = 2;\n```\n\n* * *\n\nAfter.', ctx());
    expect(kinds(book)).toEqual([['p', 'Before.'], ['pre', 'let x = 1; let y = 2;'], ['p', 'After.']]);
  });

  it('cleans light inline Markdown', () => {
    expect(cleanInline('A [link](http://x.y) and ![img](a.png) and `code` and **bold** and *em* and _em_ but snake_case_name and 2 * 3 * 4.'))
      .toBe('A link and  and code and bold and em and em but snake_case_name and 2 * 3 * 4.');
    expect(cleanInline('a<br>b<br/>c')).toBe('a b c');
    expect(cleanInline('[ref link][1]')).toBe('ref link');
  });
});

describe('textImporter: title and chapters', () => {
  it('derives the title from the first heading, else the first line (truncated)', async () => {
    expect((await textToBook('', 'Just prose here.\n\n# Later Heading\n\nMore.', ctx())).title).toBe('Later Heading');
    expect((await textToBook('', 'A plain first line.\nSecond line.', ctx())).title).toBe('A plain first line. Second line.');
    const long = 'word '.repeat(40).trim() + '.';
    const t = (await textToBook('', long, ctx())).title;
    expect(t.length).toBeLessThanOrEqual(81);
    expect(t.endsWith('…')).toBe(true);
    expect((await textToBook('', 'Chapter 1\n\nBody.', ctx())).title).toBe('Chapter 1');
  });

  it('uses the given title for the paste flow when it is not empty', async () => {
    const book = await textToBook('  My   Paste ', '# Heading\n\nBody.', ctx({ sourcePath: '/notes.txt' }));
    expect(book.title).toBe('My Paste');
    expect(book.source.path).toBe('/notes.txt');
  });

  it('makes one chapter per "# " heading when there are several, with a leading Introduction', async () => {
    const book = await textToBook('', 'Preamble text.\n\n# One\n\nFirst body.\n\n## Not a chapter\n\nStill first.\n\n# Two\n\nSecond body.', ctx());
    checkBook(book);
    expect(book.chapters.map((c) => [c.title, c.paragraphs.map((p) => p.text)])).toEqual([
      ['Introduction', ['Preamble text.']],
      ['One', ['One', 'First body.', 'Not a chapter', 'Still first.']],
      ['Two', ['Two', 'Second body.']],
    ]);
    expect(book.title).toBe('One');
  });

  it('keeps a single "# " heading in one chapter called Text', async () => {
    const book = await textToBook('', '# Only\n\nBody.', ctx());
    expect(book.chapters.map((c) => c.title)).toEqual(['Text']);
  });

  it('splits plain text on "Chapter N" style headings when there are at least two', async () => {
    const book = await textToBook('', 'CHAPTER I\n\nIt was the best of times.\n\nChapter 2\n\nIt was the worst of times.\n\nAn Interlude\n\nNot a chapter start.', ctx());
    expect(book.chapters.map((c) => [c.title, c.paragraphs.length])).toEqual([['CHAPTER I', 2], ['Chapter 2', 4]]);
  });

  it('reads YAML front matter for title and author and drops it from the text', async () => {
    const book = await textToBook('', '---\ntitle: "Front Title"\nauthor: Some One\nlang: en\n---\n\nBody text.', ctx());
    expect(book.title).toBe('Front Title');
    expect(book.author).toBe('Some One');
    expect(kinds(book)).toEqual([['p', 'Body text.']]);
  });

  /** The Markdown source of test/fixtures/book.epub (pandoc sample). */
  const SAMPLE_MD = `---
title: The Test Book
author: Spike Author
lang: en-GB
---

# Chapter One: Arrival

Mr. Darcy arrived at 5 p.m. on Tuesday. "Is it true," she asked, "that you never dance?" He said nothing. The old house, with its ubiquitous ivy and crumbling façade, looked melancholy in the rain.

It was an inauspicious beginning. Dr. Smith, however, remained sanguine: the weather, he insisted, would improve by Thursday... or at least by Friday!

# Chapter Two: The Letter

The letter arrived the next morning. It contained a single, perplexing sentence—“Meet me where the river bends.” Elizabeth read it twice (and then a third time) before folding it away.

- A list item that should still be read.
- Another item.

> A quoted paragraph, which is quite ordinary.
`;
  it('imports the pandoc sample book.md as two chapters', async () => {
    const book = await textImporter.importBytes(bytes(SAMPLE_MD), ctx());
    checkBook(book);
    expect(book.title).toBe('The Test Book');
    expect(book.author).toBe('Spike Author');
    expect(book.chapters.map((c) => c.title)).toEqual(['Chapter One: Arrival', 'Chapter Two: The Letter']);
    expect(book.chapters[1].paragraphs.map((p) => p.kind)).toEqual(['h1', 'p', 'li', 'li', 'blockquote']);
    expect(book.stats.paragraphs).toBe(8);
  });
});

describe('shared helpers', () => {
  it('normalizeWhitespace collapses runs, no-break spaces and invisible characters', () => {
    expect(normalizeWhitespace('  a    b\n\tc​ d ﻿')).toBe('a b c d');
    expect(normalizeWhitespace('soft­hyphen kept')).toBe('soft­hyphen kept');
  });

  it('assembleParagraphs numbers paragraphs and drops empty or unsegmentable ones', () => {
    const seg = stubSegmenter();
    const out = assembleParagraphs([{ kind: 'p', text: ' Hello world. Bye. ' }, { kind: 'h1', text: '   ' }, { kind: 'li', text: '...' }, { kind: 'p', text: 'Last' }], seg);
    expect(out.map((p) => [p.index, p.kind, p.text])).toEqual([[0, 'p', 'Hello world. Bye.'], [1, 'p', 'Last']]);
    expect(out[0].sentences.map((s) => out[0].text.slice(s.start, s.end))).toEqual(['Hello world.', 'Bye.']);
  });

  it('computeStats counts words (and numbers), paragraphs and sentences', () => {
    const seg = stubSegmenter();
    const paragraphs = assembleParagraphs([{ kind: 'p', text: 'I have 3 cats. They sleep!' }, { kind: 'p', text: 'Short' }], seg);
    const stats = computeStats([{ index: 0, title: 'T', paragraphs }, { index: 1, title: 'U', paragraphs }]);
    expect(stats).toEqual({ words: 14, paragraphs: 4, sentences: 6 });
  });

  it('parseTextBlocks marks level-1 headings as chapter candidates', () => {
    const blocks = parseTextBlocks('# A\n\nB\n===\n\n## C');
    expect(blocks.map((b) => [b.kind, b.text, b.top ?? false])).toEqual([['h1', 'A', true], ['h1', 'B', true], ['h2', 'C', false]]);
  });
});
