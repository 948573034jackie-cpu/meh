/**
 * The reading mode's text: a PDF, a text file or pasted text as a book of sentences. Nothing is rewritten, cut or
 * moved: paragraphs come from blank lines, lines inside a paragraph are joined, and a word broken over two lines
 * ("exam-" + "ple") is joined back. The sentences and words are found by Dream Read's segmenter.
 */
import type { Book, Position } from '@core/model';
import { assembleParagraphs, computeStats } from '@core/import/text';
import { createSegmenter } from '@core/segment';

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

export function orderOf(book: Pick<Book, 'chapters'>): Position[] {
  const out: Position[] = [];
  for (const c of book.chapters) for (const p of c.paragraphs) for (const s of p.sentences) out.push({ chapter: c.index, paragraph: p.index, sentence: s.index });
  return out;
}

interface PdfTextItem { str: string; hasEOL?: boolean; transform: number[]; height?: number }
/**
 * The lines of a PDF page's text items -> plain text: a bigger gap between two lines is a new paragraph. A page's end
 * is no paragraph's end: the sentence goes on on the next page unless the line had ended it.
 */
export function pagesToText(pages: readonly (readonly PdfTextItem[])[]): string {
  const paras: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) paras.push(cur.join('\n')); cur = []; };
  for (const items of pages) {
    let line = '';
    let lastY: number | null = null, gap = 0;
    const endLine = (y: number | null) => {
      const t = line.trim();
      line = '';
      if (!t) return;
      if (y !== null && lastY !== null) {
        const d = Math.abs(lastY - y);
        // (the normal distance between lines is the smallest seen so far on the page)
        if (gap === 0 || d < gap) gap = d;
        if (gap > 0 && d > gap * 1.5) flush();
      }
      cur.push(t);
      if (y !== null) lastY = y;
    };
    let y: number | null = null;
    for (const it of items) {
      const iy = it.transform[5];
      if (y !== null && Math.abs(iy - y) > 2 && line.trim()) endLine(y);
      y = iy;
      line += it.str;
      if (it.hasEOL) { endLine(y); }
    }
    endLine(y);
    // (a sentence that ended with the page: its paragraph too)
    if (cur.length && /[.!?]["”’)]?$/.test(cur[cur.length - 1])) flush();
  }
  flush();
  return paras.join('\n\n');
}

export async function pdfToText(bytes: ArrayBuffer): Promise<string> {
  // (pdf.js does its work in this page, not in a worker of its own: a worker file may not load inside the iPhone apps)
  // (pdf.js uses Promise.withResolvers, which Safari has only from iOS 17.4)
  const P = Promise as unknown as { withResolvers?: () => unknown };
  if (!P.withResolvers) P.withResolvers = () => { let resolve!: (v: unknown) => void, reject!: (e: unknown) => void; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
  await import('pdfjs-dist/build/pdf.worker.mjs');
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages: PdfTextItem[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const c = await page.getTextContent();
    pages.push((c.items as (PdfTextItem | { type: string })[]).filter((x): x is PdfTextItem => 'str' in x));
    page.cleanup();
  }
  await doc.destroy();
  return pagesToText(pages);
}
