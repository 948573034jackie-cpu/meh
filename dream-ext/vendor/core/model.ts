/** Core data model shared by importers, analysis, the reader and the listening controller. */

export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export const CEFR_LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
export function levelIndex(l: CefrLevel): number { return CEFR_LEVELS.indexOf(l); }

export type ParagraphKind = 'p' | 'h1' | 'h2' | 'h3' | 'li' | 'blockquote' | 'pre' | 'caption';

export interface Book {
  /** sha256 hex of the source bytes (or of the pasted text); stable identity for progress + vocabulary. */
  id: string;
  title: string;
  author?: string;
  language?: string;
  source: { kind: 'epub' | 'pdf' | 'text'; path?: string; importedAt: string };
  chapters: Chapter[];
  /** Capitalised tokens judged to be names/places in this book; never auto-explained. Lower-cased. */
  names: string[];
  stats: { words: number; paragraphs: number; sentences: number };
}

export interface Chapter {
  /** 0-based index within the book */
  index: number;
  title: string;
  paragraphs: Paragraph[];
}

export interface Paragraph {
  /** 0-based index within the chapter */
  index: number;
  kind: ParagraphKind;
  /** Plain text with whitespace normalised to single spaces, no leading/trailing space. */
  text: string;
  sentences: Sentence[];
}

export interface Sentence {
  /** 0-based index within the paragraph */
  index: number;
  /** char offsets into Paragraph.text (end exclusive) */
  start: number;
  end: number;
  tokens: Token[];
}

export type TokenKind = 'word' | 'number' | 'punct' | 'space';

export interface Token {
  /** char offsets into Paragraph.text (end exclusive) */
  start: number;
  end: number;
  text: string;
  kind: TokenKind;
}

/** A position in a book, addressing a sentence (and optionally a token inside it). */
export interface Position {
  chapter: number;
  paragraph: number;
  sentence: number;
  token?: number;
}

export function sentenceKey(p: Position): string { return `${p.chapter}.${p.paragraph}.${p.sentence}`; }
export function sentenceText(para: Paragraph, s: Sentence): string { return para.text.slice(s.start, s.end); }
export function samePosition(a: Position, b: Position): boolean {
  return a.chapter === b.chapter && a.paragraph === b.paragraph && a.sentence === b.sentence;
}
