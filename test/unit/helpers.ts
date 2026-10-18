import type { Book, Paragraph, Sentence, Token } from '@core/model';

/** Minimal segmenter for tests: sentences split on . ! ? followed by space; word tokens by regex. */
export function naiveSegment(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const re = /[^.!?]+[.!?]+["”’)]?|[^.!?]+$/g;
  let m: RegExpExecArray | null; let idx = 0;
  while ((m = re.exec(text))) {
    const raw = m[0]; const lead = raw.length - raw.trimStart().length; const trail = raw.length - raw.trimEnd().length;
    const start = m.index + lead, end = m.index + raw.length - trail;
    if (end <= start) continue;
    const tokens: Token[] = [];
    const tre = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*|[^\s\p{L}\p{N}]+/gu;
    const slice = text.slice(start, end); let t: RegExpExecArray | null;
    while ((t = tre.exec(slice))) tokens.push({ start: start + t.index, end: start + t.index + t[0].length, text: t[0], kind: /^[\p{L}]/u.test(t[0]) ? 'word' : /^[\p{N}]/u.test(t[0]) ? 'number' : 'punct' });
    sentences.push({ index: idx++, start, end, tokens });
  }
  return sentences;
}

export function makeBook(chapters: { title: string; paragraphs: string[] }[]): Book {
  let words = 0, paragraphs = 0, sentences = 0;
  const book: Book = {
    id: 'test', title: 'Test Book', source: { kind: 'text', importedAt: new Date(0).toISOString() }, names: [], stats: { words: 0, paragraphs: 0, sentences: 0 },
    chapters: chapters.map((c, ci) => ({ index: ci, title: c.title, paragraphs: c.paragraphs.map((text, pi): Paragraph => {
      const sents = naiveSegment(text); paragraphs++; sentences += sents.length; words += sents.reduce((n, s) => n + s.tokens.filter((t) => t.kind === 'word').length, 0);
      return { index: pi, kind: 'p', text, sentences: sents };
    }) })),
  };
  book.stats = { words, paragraphs, sentences };
  return book;
}
