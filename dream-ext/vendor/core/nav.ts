import type { Book, Position, Paragraph, Sentence } from './model';

/** Navigation helpers over the sentence sequence of a book. */
export function getSentence(book: Book, pos: Position): { para: Paragraph; sentence: Sentence; text: string } | null {
  const para = book.chapters[pos.chapter]?.paragraphs[pos.paragraph];
  const sentence = para?.sentences[pos.sentence];
  if (!para || !sentence) return null;
  return { para, sentence, text: para.text.slice(sentence.start, sentence.end) };
}

export function firstPosition(book: Book): Position | null {
  for (let c = 0; c < book.chapters.length; c++) {
    for (let p = 0; p < book.chapters[c].paragraphs.length; p++) {
      if (book.chapters[c].paragraphs[p].sentences.length) return { chapter: c, paragraph: p, sentence: 0 };
    }
  }
  return null;
}

export function nextPosition(book: Book, pos: Position): Position | null {
  let { chapter: c, paragraph: p, sentence: s } = pos;
  s += 1;
  for (;;) {
    const ch = book.chapters[c];
    if (!ch) return null;
    const para = ch.paragraphs[p];
    if (para && s < para.sentences.length) return { chapter: c, paragraph: p, sentence: s };
    p += 1; s = 0;
    if (!ch.paragraphs[p]) { c += 1; p = 0; }
  }
}

export function prevPosition(book: Book, pos: Position): Position | null {
  let { chapter: c, paragraph: p, sentence: s } = pos;
  s -= 1;
  for (;;) {
    if (c < 0) return null;
    const ch = book.chapters[c];
    const para = ch?.paragraphs[p];
    if (para && s >= 0 && s < para.sentences.length) return { chapter: c, paragraph: p, sentence: s };
    p -= 1;
    if (p < 0) { c -= 1; p = (book.chapters[c]?.paragraphs.length ?? 0) - 1; }
    s = (book.chapters[c]?.paragraphs[p]?.sentences.length ?? 0) - 1;
  }
}

export function paragraphStart(book: Book, pos: Position, delta: 1 | -1): Position | null {
  let c = pos.chapter, p = pos.paragraph + delta;
  for (;;) {
    const ch = book.chapters[c];
    if (!ch) return null;
    if (p < 0) { c -= 1; p = (book.chapters[c]?.paragraphs.length ?? 0) - 1; continue; }
    if (p >= ch.paragraphs.length) { c += 1; p = 0; continue; }
    if (ch.paragraphs[p].sentences.length) return { chapter: c, paragraph: p, sentence: 0 };
    p += delta;
  }
}

export function comparePositions(a: Position, b: Position): number {
  return a.chapter - b.chapter || a.paragraph - b.paragraph || a.sentence - b.sentence;
}

/** Fraction of the book's words that come before `pos`. */
export function percentAt(book: Book, pos: Position): number {
  let before = 0, total = 0;
  for (const ch of book.chapters) for (const para of ch.paragraphs) {
    const n = para.sentences.reduce((s, x) => s + x.tokens.filter((t) => t.kind === 'word').length, 0);
    total += n;
    if (ch.index < pos.chapter || (ch.index === pos.chapter && para.index < pos.paragraph)) before += n;
  }
  return total ? (before / total) * 100 : 0;
}

/**
 * Text around a position for the AI: about `wordsBefore` words of preceding text and `wordsAfter` words of
 * following text, whole sentences only, within the current chapter, paragraph breaks kept as blank lines.
 */
export function contextAround(book: Book, pos: Position, wordsBefore: number, wordsAfter: number): { before: string; after: string } {
  const count = (s: Sentence) => s.tokens.filter((t) => t.kind === 'word').length;
  const collect = (dir: 1 | -1, limit: number): string => {
    const chunks: string[] = [];
    let n = 0;
    let cur: Position | null = pos;
    let lastPara = pos.paragraph;
    while (n < limit) {
      cur = dir === 1 ? nextPosition(book, cur) : prevPosition(book, cur);
      if (!cur || cur.chapter !== pos.chapter) break;
      const got = getSentence(book, cur);
      if (!got) break;
      const sep = cur.paragraph !== lastPara ? '\n\n' : ' ';
      lastPara = cur.paragraph;
      if (dir === 1) chunks.push(sep, got.text); else chunks.unshift(got.text, sep);
      n += count(got.sentence);
    }
    return chunks.join('').trim();
  };
  return { before: collect(-1, wordsBefore), after: collect(1, wordsAfter) };
}

/** Word offset of every sentence from the start of the book (prefix sums), for "within N words" rules. */
export function wordOffsets(book: Book): (pos: Position) => number {
  const table: number[][][] = [];
  let n = 0;
  for (const ch of book.chapters) {
    const chTab: number[][] = [];
    for (const para of ch.paragraphs) {
      const pTab: number[] = [];
      for (const s of para.sentences) { pTab.push(n); n += s.tokens.filter((t) => t.kind === 'word').length; }
      chTab.push(pTab);
    }
    table.push(chTab);
  }
  return (pos) => table[pos.chapter]?.[pos.paragraph]?.[pos.sentence] ?? 0;
}
