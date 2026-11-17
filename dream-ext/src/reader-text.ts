/**
 * The reading mode's text: a PDF, a text file or pasted text as a book of sentences. Nothing is rewritten, cut or
 * moved: paragraphs come from blank lines, lines inside a paragraph are joined, and a word broken over two lines
 * ("exam-" + "ple") is joined back. The sentences and words are found by Dream Read's segmenter.
 * (A PDF's text comes from pdf-text.ts: there the page numbers and the running heads of the pages are dropped.)
 */
import type { Book, Chapter, Position } from '@core/model';
import { assembleParagraphs, computeStats, textToBook } from '@core/import/text';
import { createSegmenter, type Segmenter } from '@core/segment';
import type { RawBook, RawChapter } from './epub';

/** Lines -> paragraphs: a blank line (or a form feed) ends one. */
export function paragraphsOf(text: string): string[] {
  const out: string[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').replace(/\f/g, '\n\n').split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let p = lines[0];
    for (const l of lines.slice(1)) p = /\p{L}-$/u.test(p) && /^\p{Ll}/u.test(l) ? p.slice(0, -1) + l : `${p} ${l}`;
    out.push(p);
  }
  return out;
}

export function textBook(id: string, title: string, text: string, kind: 'pdf' | 'text'): Book {
  const paragraphs = assembleParagraphs(paragraphsOf(text).map((t) => ({ kind: 'p' as const, text: t })), createSegmenter());
  if (!paragraphs.length) throw new Error('No readable text was found in it.');
  const chapters = [{ index: 0, title: '', paragraphs }];
  return { id, title, source: { kind, importedAt: new Date().toISOString() }, chapters, names: [], stats: computeStats(chapters) };
}

/** A pasted text or a PDF's text as a book of one chapter: every paragraph as it is. */
export function rawFromPlain(title: string, text: string): RawBook {
  return { title, author: '', chapters: [{ title: '', blocks: paragraphsOf(text).map((t) => ({ kind: 'p' as const, text: t })) }] };
}

/**
 * A text or Markdown FILE as a book: headings ("# One", "Chapter 2") become its chapters (Dream Read's own text
 * importer). The title is the file's name unless the text names one.
 */
export async function rawFromTextFile(title: string, text: string): Promise<RawBook> {
  const b = await textToBook(title, text, { segmenter: createSegmenter(), id: 'x' });
  return { title: b.title, author: b.author ?? '', chapters: b.chapters.map((c) => ({ title: c.title, blocks: c.paragraphs.map((p) => ({ kind: p.kind, text: p.text })) })) };
}

/** One stored chapter as sentences and words (done when the chapter is opened, not for the whole book at once). */
export function chapterOf(raw: RawChapter, index: number, segmenter: Segmenter): Chapter {
  return { index, title: raw.title, paragraphs: assembleParagraphs(raw.blocks, segmenter) };
}

/** the letters of the chapter's paragraphs before this paragraph (for "how far in the book") */
export function charsBefore(ch: Pick<Chapter, 'paragraphs'>, paragraph: number): number {
  let n = 0;
  for (const p of ch.paragraphs) { if (p.index >= paragraph) break; n += p.text.length; }
  return n;
}

export function orderOf(book: Pick<Book, 'chapters'>): Position[] {
  const out: Position[] = [];
  for (const c of book.chapters) for (const p of c.paragraphs) for (const s of p.sentences) out.push({ chapter: c.index, paragraph: p.index, sentence: s.index });
  return out;
}

// (a PDF's text: pdf-text.ts; the older reader page and the tests take it from here)
export { pagesToText, pdfToText } from './pdf-text';
