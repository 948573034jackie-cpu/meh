/**
 * Plain-text / Markdown importer, plus the paragraph and statistics helpers shared by every importer.
 *
 * Text rules (see parseBlock): paragraphs are separated by blank lines; single newlines inside a
 * paragraph are hard wraps and join with a space (a trailing hyphen followed by a lower-case line joins
 * the word back together); Markdown headings ('# ', setext underlines) become h1/h2/h3; a lone short
 * line without terminal punctuation between blank lines is a heading (h2); '- ' / '* ' / '1. ' lines are
 * list items; '> ' lines are block quotes; fenced code blocks are 'pre'. The book title comes from the
 * YAML front matter, else the first heading, else the first line. There is one chapter per '# ' heading
 * when there are at least two of them (or per "Chapter N" style heading), otherwise a single chapter.
 */
import type { Book, Chapter, Paragraph, ParagraphKind } from '@core/model';
import type { Segmenter } from '@core/segment';
import type { ImportContext, Importer } from './types';

// ---------------------------------------------------------------------------------------------
// Shared helpers (used by the EPUB importer too)
// ---------------------------------------------------------------------------------------------

/** A paragraph before segmentation: plain text with a kind. */
export interface RawParagraph { kind: ParagraphKind; text: string }

/** Zero-width space, word joiner and BOM: typesetting noise that only confuses segmentation and TTS. */
const STRIP_INVISIBLES = /[​⁠﻿]/g;
const WHITESPACE_RUN = /\s+/g;

/** Collapses every whitespace run (including no-break spaces) to one space and trims. */
export function normalizeWhitespace(s: string): string {
  return s.replace(STRIP_INVISIBLES, '').replace(WHITESPACE_RUN, ' ').trim();
}

/** Normalises, segments and numbers paragraphs, dropping those with no text or no sentences. */
export function assembleParagraphs(raw: readonly RawParagraph[], segmenter: Segmenter): Paragraph[] {
  const out: Paragraph[] = [];
  for (const r of raw) {
    const text = normalizeWhitespace(r.text);
    if (text.length === 0) continue;
    const sentences = segmenter.segmentParagraph(text);
    if (sentences.length === 0) continue; // nothing speakable (only invisible characters)
    out.push({ index: out.length, kind: r.kind, text, sentences });
  }
  return out;
}

/** Book.stats: words count 'word' and 'number' tokens (as a word processor would). */
export function computeStats(chapters: readonly Chapter[]): Book['stats'] {
  let words = 0;
  let paragraphs = 0;
  let sentences = 0;
  for (const ch of chapters) {
    for (const p of ch.paragraphs) {
      paragraphs++;
      sentences += p.sentences.length;
      for (const s of p.sentences) {
        for (const t of s.tokens) if (t.kind === 'word' || t.kind === 'number') words++;
      }
    }
  }
  return { words, paragraphs, sentences };
}

/** Decodes a text file: UTF-16 with a BOM, else UTF-8 (a UTF-8 BOM is consumed by the decoder). */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16be(bytes.subarray(2));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** UTF-16BE without relying on ICU (small-icu Node builds lack the 'utf-16be' label): swap to LE. */
function decodeUtf16be(bytes: Uint8Array): string {
  const even = bytes.length & ~1;
  const swapped = new Uint8Array(even);
  for (let i = 0; i < even; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return new TextDecoder('utf-16le').decode(swapped);
}

// ---------------------------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------------------------

type LineType = 'blank' | 'fence' | 'atx' | 'hr' | 'underline' | 'list' | 'quote' | 'text';

const RE = {
  blank: /^\s*$/,
  fence: /^\s{0,3}(?:```|~~~)/,
  /** '# Title', '## Title ##' (closing hashes stripped later). A bare '#' line matches atxBare instead. */
  atx: /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/,
  atxBare: /^\s{0,3}#{1,6}[ \t]*$/,
  trailingHashes: /[ \t]+#+$/,
  /** setext underlines: '===' under a line is h1, '---' (three or more) is h2 */
  underlineH1: /^\s{0,3}=+[ \t]*$/,
  underlineH2: /^\s{0,3}-{3,}[ \t]*$/,
  /** horizontal rule / scene break: '---', '* * *', '___' */
  hr: /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  /** '- item', '* item', '+ item', '• item', '1. item', '2) item' */
  list: /^\s{0,8}(?:[-*+•]|\d{1,3}[.)])[ \t]+(\S.*)$/,
  quote: /^\s{0,3}>[ \t]?(.*)$/,
};

function lineType(line: string): LineType {
  if (RE.blank.test(line)) return 'blank';
  if (RE.fence.test(line)) return 'fence';
  if (RE.atx.test(line) || RE.atxBare.test(line)) return 'atx';
  if (RE.hr.test(line)) return 'hr'; // before list: '- - -' is a rule, not an item
  if (RE.underlineH1.test(line)) return 'underline';
  if (RE.list.test(line)) return 'list';
  if (RE.quote.test(line)) return 'quote';
  return 'text';
}

function isUnderline(line: string): boolean {
  return RE.underlineH1.test(line) || RE.underlineH2.test(line);
}

/**
 * Heading heuristic for plain text: short, starts with a capital or digit, no terminal punctuation,
 * at most a dozen words. Callers also require it to be a block of its own with text after it.
 */
export function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 80) return false;
  if (!/^[\p{Lu}\p{N}]/u.test(t)) return false;
  if (/[.!?,;…]$/.test(t)) return false;
  if (/[”"’')\]]$/.test(t)) return false;
  return t.split(/\s+/).length <= 12;
}

/** "Chapter 3", "CHAPTER XII", "Part Two", "Book 1: The Beginning" — used to split plain text into chapters. */
const CHAPTER_HEADING = /^(?:chapter|part|book|act|canto|letter|section)\s+(?:\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|first|second|third|last)\b/i;

// ---------------------------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------------------------

interface TextBlock extends RawParagraph {
  /** A level-1 Markdown heading ('# ' or a '===' underline): candidate chapter start. */
  top?: boolean;
}

/** Joins hard-wrapped lines with spaces, re-joining a word hyphenated across the break ("some-\nthing"). */
export function joinWrappedLines(lines: readonly string[]): string {
  let out = '';
  for (const raw of lines) {
    const l = raw.trim();
    if (l.length === 0) continue;
    if (out.length === 0) out = l;
    else if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(l)) out = out.slice(0, -1) + l;
    else out += ' ' + l;
  }
  return out;
}

/** Removes light Markdown inline syntax so the reader sees prose: links, images, code spans, emphasis. */
export function cleanInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url)
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // [text][ref]
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}])([*_])(?=\S)([^*_]+?)(?<=\S)\1(?![\p{L}\p{N}])/gu, '$2');
}

function headingKind(level: number): ParagraphKind {
  return level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
}

/** Turns one blank-line-delimited block into paragraphs. `hasFollowing`: more blocks come after it. */
function parseBlock(lines: readonly string[], hasFollowing: boolean): TextBlock[] {
  const out: TextBlock[] = [];
  if (lines.length === 1 && hasFollowing && lineType(lines[0]) === 'text' && looksLikeHeading(lines[0])) {
    out.push({ kind: 'h2', text: cleanInline(lines[0].trim()) });
    return out;
  }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const type = lineType(line);

    if (type === 'text' && i + 1 < lines.length && isUnderline(lines[i + 1])) {
      const h1 = RE.underlineH1.test(lines[i + 1]);
      out.push({ kind: h1 ? 'h1' : 'h2', text: cleanInline(line.trim()), top: h1 });
      i += 2;
      continue;
    }
    if (type === 'atx') {
      const m = RE.atx.exec(line);
      if (m) {
        const text = cleanInline(m[2].replace(RE.trailingHashes, '').trim());
        if (text) out.push({ kind: headingKind(m[1].length), text, top: m[1].length === 1 });
      }
      i++;
      continue;
    }
    if (type === 'hr' || type === 'underline' || type === 'blank' || type === 'fence') { i++; continue; }
    if (type === 'list') {
      const item = [RE.list.exec(line)![1]];
      i++;
      while (i < lines.length && lineType(lines[i]) === 'text') item.push(lines[i++]); // wrapped item
      out.push({ kind: 'li', text: cleanInline(joinWrappedLines(item)) });
      continue;
    }
    if (type === 'quote') {
      let para: string[] = [];
      const flush = (): void => {
        if (para.length) out.push({ kind: 'blockquote', text: cleanInline(joinWrappedLines(para)) });
        para = [];
      };
      while (i < lines.length) {
        const t = lineType(lines[i]);
        if (t === 'quote') {
          const inner = RE.quote.exec(lines[i])![1];
          if (RE.blank.test(inner)) flush(); else para.push(inner); // a bare '>' separates quote paragraphs
          i++;
        } else if (t === 'text' && para.length) {
          para.push(lines[i++]); // lazy continuation line
        } else break;
      }
      flush();
      continue;
    }
    // plain text: consecutive text lines are one hard-wrapped paragraph
    const para: string[] = [];
    while (i < lines.length && lineType(lines[i]) === 'text') {
      if (para.length && i + 1 < lines.length && isUnderline(lines[i + 1])) break; // leave "line + underline" to the heading branch
      para.push(lines[i++]);
    }
    if (para.length) out.push({ kind: 'p', text: cleanInline(joinWrappedLines(para)) });
  }
  return out;
}

/** Splits the body into blank-line-delimited blocks (fenced code is its own block) and parses each. */
export function parseTextBlocks(body: string): TextBlock[] {
  const lines = body.split('\n');
  const blocks: { lines: string[]; pre: boolean }[] = [];
  let cur: string[] = [];
  const flush = (): void => { if (cur.length) { blocks.push({ lines: cur, pre: false }); cur = []; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE.fence.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !RE.fence.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of text)
      if (code.some((l) => !RE.blank.test(l))) blocks.push({ lines: code, pre: true });
      continue;
    }
    if (RE.blank.test(line)) flush(); else cur.push(line);
    i++;
  }
  flush();
  const out: TextBlock[] = [];
  blocks.forEach((b, idx) => {
    if (b.pre) out.push({ kind: 'pre', text: b.lines.map((l) => l.trim()).filter(Boolean).join(' ') });
    else out.push(...parseBlock(b.lines, idx < blocks.length - 1));
  });
  return out;
}

interface FrontMatter { title?: string; author?: string; body: string }

/** Pandoc/Jekyll style YAML front matter: only `title:` and `author:` scalars are read; the block is removed. */
function stripFrontMatter(text: string): FrontMatter {
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (!m || m[1].split('\n').length > 50) return { body: text };
  const fm: FrontMatter = { body: text.slice(m[0].length) };
  for (const line of m[1].split('\n')) {
    const kv = /^(title|author)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!kv || kv[2].startsWith('[')) continue;
    const value = kv[2].replace(/^(["'])(.*)\1$/, '$2');
    if (kv[1].toLowerCase() === 'title') fm.title ??= value; else fm.author ??= value;
  }
  return fm;
}

interface ChapterGroup { title: string; paragraphs: RawParagraph[] }

/** One chapter per level-1 heading (or "Chapter N" heading) when there are at least two; else one chapter 'Text'. */
function groupChapters(blocks: readonly TextBlock[]): ChapterGroup[] {
  let starts: number[] = [];
  blocks.forEach((b, i) => { if (b.top) starts.push(i); });
  if (starts.length < 2) {
    starts = [];
    blocks.forEach((b, i) => { if ((b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3') && CHAPTER_HEADING.test(b.text)) starts.push(i); });
  }
  if (starts.length < 2) return [{ title: 'Text', paragraphs: [...blocks] }];
  const out: ChapterGroup[] = [];
  if (starts[0] > 0) out.push({ title: 'Introduction', paragraphs: blocks.slice(0, starts[0]) });
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : blocks.length;
    out.push({ title: normalizeWhitespace(blocks[start].text), paragraphs: blocks.slice(start, end) });
  });
  return out;
}

const MAX_DERIVED_TITLE = 80;

/** The first heading, else the first line cut at a word boundary. */
function deriveTitle(blocks: readonly TextBlock[]): string {
  const heading = blocks.find((b) => b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3');
  if (heading) return normalizeWhitespace(heading.text);
  const first = blocks.find((b) => normalizeWhitespace(b.text).length > 0);
  if (!first) return 'Untitled';
  const text = normalizeWhitespace(first.text);
  if (text.length <= MAX_DERIVED_TITLE) return text;
  const cut = text.lastIndexOf(' ', MAX_DERIVED_TITLE);
  return text.slice(0, cut > 20 ? cut : MAX_DERIVED_TITLE).replace(/[\s,;:]+$/, '') + '…';
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Builds a Book from plain text or Markdown. `title` wins when non-empty (the paste flow); otherwise the
 * title is derived from the text. Throws when the text contains no readable paragraphs.
 */
export async function textToBook(title: string, text: string, ctx: ImportContext): Promise<Book> {
  const source = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n\n');
  const fm = stripFrontMatter(source);
  const blocks = parseTextBlocks(fm.body);
  const chapters: Chapter[] = [];
  for (const group of groupChapters(blocks)) {
    const paragraphs = assembleParagraphs(group.paragraphs, ctx.segmenter);
    if (paragraphs.length === 0) continue;
    chapters.push({ index: chapters.length, title: group.title, paragraphs });
  }
  if (chapters.length === 0) throw new Error('No readable text found');
  const bookTitle = normalizeWhitespace(title) || (fm.title ? normalizeWhitespace(fm.title) : '') || deriveTitle(blocks);
  const book: Book = {
    id: ctx.id,
    title: bookTitle,
    source: { kind: 'text', importedAt: new Date().toISOString() },
    chapters,
    names: [],
    stats: computeStats(chapters),
  };
  if (fm.author) book.author = normalizeWhitespace(fm.author);
  if (ctx.sourcePath) book.source.path = ctx.sourcePath;
  return book;
}

export const textImporter: Importer = {
  kind: 'text',
  importBytes(bytes: Uint8Array, ctx: ImportContext): Promise<Book> {
    return textToBook('', decodeTextBytes(bytes), ctx);
  },
};
