import type { Book, Paragraph } from '@core/model';

/**
 * Speechify-style "Enhanced Skipping": parts of a book the voice leaves out. Whole paragraphs (running
 * headers and footers, page numbers, footnotes, table-of-contents lines, figure captions) are found by
 * classifySkippable(); inline spans ((…), […], {…}, citations, URLs) are removed from the SPOKEN text by
 * stripInline(), which also returns an offset map so word timings of the stripped text can be mapped
 * back to the original sentence for highlighting. The displayed text is never changed.
 */

export type SkipCategory =
  | 'headers' | 'footers' | 'footnotes' | 'braces' | 'citations' | 'parentheses' | 'brackets' | 'urls'
  | 'pageNumbers' | 'toc' | 'captions';

export type SkipSettings = Record<SkipCategory, boolean>;

/** Settings → Skip rows, in Speechify's order (then the extra ones). */
export const SKIP_OPTIONS: { id: SkipCategory; label: string; hint: string }[] = [
  { id: 'headers', label: 'Headers', hint: 'Running headers repeated at the top of pages (book or chapter title).' },
  { id: 'footers', label: 'Footers', hint: 'Running footers repeated at the bottom of pages (copyright lines, web addresses).' },
  { id: 'footnotes', label: 'Footnotes', hint: 'Notes that start with a number, [1] or ^1, and small raised note numbers¹.' },
  { id: 'braces', label: 'Braces', hint: 'Anything inside { curly braces }.' },
  { id: 'citations', label: 'Citations', hint: 'References like (Smith, 2020), (Smith et al. 2019; Lee 2021) or [12].' },
  { id: 'parentheses', label: 'Parentheses', hint: 'Anything inside ( round brackets ).' },
  { id: 'brackets', label: 'Brackets', hint: 'Anything inside [ square brackets ].' },
  { id: 'urls', label: 'URLs', hint: 'Web addresses such as https://example.com or www.example.com.' },
  { id: 'pageNumbers', label: 'Page numbers', hint: 'Lines that are only a page number, like "12" or "Page 12".' },
  { id: 'toc', label: 'Table of contents', hint: 'Contents lines ending in dots and a page number ("Chapter 1 ....... 7").' },
  { id: 'captions', label: 'Captions', hint: 'Figure and table captions ("Figure 1: …", "Table 2. …").' },
];

export const SKIP_CATEGORIES: SkipCategory[] = SKIP_OPTIONS.map((o) => o.id);

export const DEFAULT_SKIP: SkipSettings = {
  headers: false, footers: false, footnotes: false, braces: false, citations: false, parentheses: false, brackets: false, urls: false,
  pageNumbers: true, toc: false, captions: false,
};

/** Every category on (or off). */
export function skipAll(on = true): SkipSettings {
  return Object.fromEntries(SKIP_CATEGORIES.map((c) => [c, on])) as SkipSettings;
}

export function allSkipped(s: SkipSettings): boolean { return SKIP_CATEGORIES.every((c) => s[c]); }

// ---- paragraph classification ------------------------------------------------------------------

export interface SkipContext {
  /** normalised short lines (see runningKey) -> how often they occur in the book */
  repeated: Map<string, number>;
  /** the paragraph is the last one of its chapter (a repeated line there is more likely a footer) */
  lastInChapter?: boolean;
}

const MAX_RUNNING_CHARS = 80;
const MAX_RUNNING_WORDS = 12;
/** a short line repeated this often in the book is a running header or footer */
const MIN_REPEATS = 3;

function isHeading(p: Paragraph): boolean { return p.kind === 'h1' || p.kind === 'h2' || p.kind === 'h3'; }

/** Key for running header/footer detection: lower case, digits and page-number words removed, punctuation collapsed. */
export function runningKey(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > MAX_RUNNING_CHARS || t.split(/\s+/).length > MAX_RUNNING_WORDS) return null;
  const key = t.toLowerCase().replace(/\bpage\b|\bof\b(?=\s*\d)/g, ' ').replace(/\d+/g, ' ').replace(/[^\p{L}]+/gu, ' ').trim();
  return key.length >= 2 ? key : null;
}

/** Counts repeated short lines across the whole book (headings excluded: chapter titles are never skipped). */
export function buildSkipContext(book: Book): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of book.chapters) for (const p of ch.paragraphs) {
    if (isHeading(p)) continue;
    const k = runningKey(p.text);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of counts) if (n < MIN_REPEATS) counts.delete(k);
  return counts;
}

/** "12", "- 12 -", "Page 12", "page 3 of 10", "xii" (lower-case roman numerals only: "I" or "MIX" alone are words) */
const PAGE_NUMBER = /^[\s\-–—|]*(?:(?:[Pp]age|PAGE|[Pp]\.|[Pp]g\.?)\s*)?(?:\d{1,4}|[ivxlc]{1,7})(?:\s*(?:of|OF|\/)\s*\d{1,4})?[\s\-–—|]*$/;
const TOC_LINE = /(?:\.\s*){3,}\s*(?:\d{1,4}|[ivxlc]{1,7})\s*$|(?:…\s*)+(?:\d{1,4}|[ivxlc]{1,7})\s*$/i;
const CAPTION = /^(?:figure|fig\.|table|chart|plate|illustration|image|photo|map|diagram|exhibit|listing|graph)\s*\d+(?:\.\d+)*[a-z]?\s*[:.—–-](?:\s|$)/i;
const FOOTNOTE = /^(?:\[\d{1,3}\]|\^\d{1,3}|\d{1,3}\s+(?=[\p{Lu}“"‘'(])|[*†‡§¶]+\s*(?=\S)|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s*(?=\S))/u;
const FOOTER_HINT = /©|\bcopyright\b|all rights reserved|https?:\/\/|www\.|\bpage\b|\.(?:com|org|net)\b/i;
const CITATION_ONLY = /^\s*(?:\[\d{1,4}(?:\s*[,–-]\s*\d{1,4})*\]\s*)+$/;

/**
 * The skip category of a whole paragraph, or null when it is ordinary text. The caller decides whether
 * that category is switched on. `ctx.repeated` comes from buildSkipContext(book); without it running
 * headers/footers are not detected.
 */
export function classifySkippable(paragraph: Paragraph, ctx?: SkipContext): SkipCategory | null {
  const text = paragraph.text.trim();
  if (!text) return null;
  if (PAGE_NUMBER.test(text)) return 'pageNumbers';
  if (TOC_LINE.test(text)) return 'toc';
  if (paragraph.kind === 'caption' || CAPTION.test(text)) return 'captions';
  if (CITATION_ONLY.test(text)) return 'citations';
  if (isHeading(paragraph)) return null;
  if (paragraph.kind !== 'li' && paragraph.kind !== 'pre' && FOOTNOTE.test(text)) return 'footnotes';
  const key = ctx ? runningKey(text) : null;
  if (key && ctx!.repeated.has(key)) return FOOTER_HINT.test(text) || ctx!.lastInChapter ? 'footers' : 'headers';
  return null;
}

/** Category of a paragraph if it is switched on in `settings`, else null. */
export function paragraphSkip(paragraph: Paragraph, settings: SkipSettings, ctx?: SkipContext): SkipCategory | null {
  const c = classifySkippable(paragraph, ctx);
  return c && settings[c] ? c : null;
}

function anyOn(s: SkipSettings): boolean { return SKIP_CATEGORIES.some((c) => s[c]); }
const INLINE: SkipCategory[] = ['parentheses', 'brackets', 'braces', 'citations', 'urls', 'footnotes'];

/**
 * Keys ("chapter.paragraph.sentence", as sentenceKey()) of every sentence the voice should skip: all
 * sentences of skipped paragraphs, plus sentences left with nothing to say once inline spans are stripped.
 */
export function skippedSentences(book: Book, settings: SkipSettings): Set<string> {
  const out = new Set<string>();
  if (!anyOn(settings)) return out;
  const repeated = buildSkipContext(book);
  const inline = INLINE.some((c) => settings[c]);
  for (const ch of book.chapters) {
    ch.paragraphs.forEach((p, i) => {
      const whole = paragraphSkip(p, settings, { repeated, lastInChapter: i === ch.paragraphs.length - 1 });
      for (const s of p.sentences) {
        const key = `${ch.index}.${p.index}.${s.index}`;
        if (whole) { out.add(key); continue; }
        if (inline && !/[\p{L}\p{N}]/u.test(stripInline(p.text.slice(s.start, s.end), settings).text)) out.add(key);
      }
    });
  }
  return out;
}

// ---- inline stripping ----------------------------------------------------------------------------

export interface StrippedText {
  /** the text to speak */
  text: string;
  /** map[i] = offset in the original text of text[i]; map[text.length] = original length */
  map: number[];
  /** removed [start, end) ranges of the original text */
  removed: [number, number][];
}

const PAIRS: Record<string, { close: string; cat: 'parentheses' | 'brackets' | 'braces' }> = {
  '(': { close: ')', cat: 'parentheses' }, '[': { close: ']', cat: 'brackets' }, '{': { close: '}', cat: 'braces' },
};
const CITE_PART = /^(?:(?:see(?:\s+also)?|cf\.|e\.g\.,?|i\.e\.,?)\s+)?(?:\p{Lu}[\p{L}'’\-]+(?:\s+(?:et\s+al\.?|and|&)(?:\s+\p{Lu}[\p{L}'’\-]+)?)?,?\s+)?(?:\d{4}[a-z]?|n\.d\.|in\s+press|forthcoming)(?:\s*,\s*(?:pp?\.\s*)?\d+(?:\s*[–-]\s*\d+)?)?$/u;
const NUMERIC_CITE = /^\d{1,4}(?:\s*[,–-]\s*\d{1,4})*$/;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"'”’]+/gi;
const SUPERSCRIPT_NOTE = /(?<=[\p{L}\p{N}.,;:!?”"')\]])[¹²³⁴⁵⁶⁷⁸⁹⁰]+/gu;

/** True when the content of (…) or […] is a reference: "Smith, 2020", "Smith et al. 2019; Lee 2021, p. 4", "12", "3–5". */
export function isCitation(inner: string, open: string): boolean {
  const t = inner.trim();
  if (!t) return false;
  if (open === '[') return NUMERIC_CITE.test(t) || t.split(/\s*;\s*/).every((p) => CITE_PART.test(p));
  if (open === '(') return t.split(/\s*;\s*/).every((p) => CITE_PART.test(p));
  return false;
}

/** Balanced (…)/[…]/{…} spans of `text`, nested ones included, sorted by start. */
function bracketSpans(text: string): { start: number; end: number; open: string }[] {
  const out: { start: number; end: number; open: string }[] = [];
  const stack: { ch: string; at: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (PAIRS[c]) stack.push({ ch: c, at: i });
    else if (c === ')' || c === ']' || c === '}') {
      // pop to the matching opener; an unmatched closer is ignored
      let j = stack.length - 1;
      while (j >= 0 && PAIRS[stack[j].ch].close !== c) j--;
      if (j < 0) continue;
      const open = stack[j];
      stack.length = j;
      // nested spans are kept too, so an inner citation can go when only citations are skipped
      out.push({ start: open.at, end: i + 1, open: open.ch });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Removes the switched-on inline spans from text to be spoken and returns the remaining text with an
 * offset map back to the original. Whitespace left doubled by a removal is collapsed, and a space before
 * following punctuation is dropped ("word (x)." -> "word.").
 */
export function stripInline(text: string, settings: SkipSettings): StrippedText {
  const spans: [number, number][] = [];
  if (settings.parentheses || settings.brackets || settings.braces || settings.citations) {
    for (const s of bracketSpans(text)) {
      const cat = PAIRS[s.open].cat;
      if (settings[cat] || (settings.citations && isCitation(text.slice(s.start + 1, s.end - 1), s.open))) spans.push([s.start, s.end]);
    }
  }
  if (settings.urls) {
    for (const m of text.matchAll(URL)) {
      let end = m.index! + m[0].length;
      while (end > m.index! && /[.,;:!?)\]]/.test(text[end - 1])) end--;
      spans.push([m.index!, end]);
    }
  }
  if (settings.footnotes) for (const m of text.matchAll(SUPERSCRIPT_NOTE)) spans.push([m.index!, m.index! + m[0].length]);
  if (!spans.length) return { text, map: identity(text.length), removed: [] };

  // merge overlapping spans, then widen each over one side of its surrounding whitespace
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  for (const r of merged) {
    let [a, b] = r;
    const before = a > 0 && /\s/.test(text[a - 1]);
    const after = b < text.length && /\s/.test(text[b]);
    if (before && (after || b === text.length || /[.,;:!?…)\]}”"’]/.test(text[b]))) { while (a > 0 && /\s/.test(text[a - 1])) a--; }
    else if (!before && after && a === 0) { while (b < text.length && /\s/.test(text[b])) b++; }
    r[0] = a; r[1] = b;
  }
  let out = '';
  const map: number[] = [];
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    while (k < merged.length && i >= merged[k][1]) k++;
    if (k < merged.length && i >= merged[k][0] && i < merged[k][1]) continue;
    out += text[i];
    map.push(i);
  }
  map.push(text.length);
  return { text: out, map, removed: merged };
}

function identity(n: number): number[] { return Array.from({ length: n + 1 }, (_, i) => i); }

/** Maps a (charIndex, charLength) in the stripped text back to the original text. */
export function toOriginalRange(s: StrippedText, charIndex: number, charLength: number): { charIndex: number; charLength: number } {
  const i = Math.max(0, Math.min(charIndex, s.map.length - 1));
  const j = Math.max(i, Math.min(charIndex + Math.max(1, charLength) - 1, s.map.length - 2));
  const start = s.map[i];
  const end = j >= 0 && j < s.map.length - 1 ? s.map[j] + 1 : start + charLength;
  return { charIndex: start, charLength: Math.max(0, end - start) };
}
