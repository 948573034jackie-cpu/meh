/**
 * A PDF's text as clean paragraphs, page by page (I Know Book 1.1, plan C1 / C3 / C4).
 *
 * HOW TO USE IT
 *
 *   const b = new PdfTextBuilder();
 *   for await (const p of pdfPages(bytes, { signal })) {   // p = { page, pages, items, width, height, chars, failed?, scan? }
 *     if (p.scan) break;                                    // pictures of pages (a scan): say so and stop
 *     const blocks = b.add(p);                              // the paragraphs that are finished now: { kind: 'p' | 'h2', text, page }[]
 *     ...                                                   // show "Page p.page of p.pages", keep the blocks
 *   }
 *   const rest = b.flush();                                 // the last paragraphs (also right after a cancel)
 *   b.emptyPages, b.failedPages                             // for "N pages had no text."
 *
 * Things to know:
 *  - pdfPages() gives the file's bytes to pdf.js WITHOUT a copy: the ArrayBuffer is empty afterwards. Work out the
 *    book's id from the bytes BEFORE the call, and pass the buffer itself, not `bytes.slice(0)`.
 *  - It gives the screen a turn (a new task) after every page and at least every PAUSE_MS inside a long page. A page
 *    that cannot be read is yielded with `failed: true` and no items. When the signal is aborted the loop just ends
 *    (look at `signal.aborted`); the document is destroyed in every case. A file that is no PDF at all throws.
 *  - `p.scan` is set once, on the 10th page (or the last page of a shorter file), when nearly all pages so far have
 *    no text AND a few pages taken from the rest of the file have none either. looksScanned() is the plain test on
 *    the first pages only: a book with many empty first pages can pass it, so stop on `p.scan`, not on it alone.
 *  - The builder holds the first HOLD (12) pages back to learn the running heads, and after that it is always AHEAD
 *    (6) pages behind: add() returns [] for the first 11 pages. The paragraph that is still open (it may go on on
 *    the next page) is kept inside until its end is seen; flush() gives everything that is left.
 *  - A block's `page` is the PDF page where it starts. A block is a RawParagraph (what epub.ts makes) with that one
 *    extra field. An 'h2' is a heading: a line clearly bigger than the body text (1.2 x), or "Chapter 3" /
 *    "CHAPTER III" / "Part Two". Heading lines of one size that follow each other are one block; "CHAPTER ONE" in one
 *    size and its title in another are two 'h2' blocks, one after the other.
 *  - The PDF's own outline (its bookmarks) is not read here.
 *
 * The rules of the builder (PdfTextBuilder):
 *  - lines are made from the items' places: an item whose step up or down is small against its height (a footnote
 *    mark, a superscript) stays in its line, whatever pdf.js says with hasEOL; a drop cap joins its first line;
 *  - the normal line distance is the MEDIAN of the page's line distances; a new paragraph starts at a first-line
 *    indent (the line starts right of the page's usual left edge), at a gap over 1.3 x the median, or after a short
 *    line that ends a sentence;
 *  - a line in the top or bottom 8 % of the page is dropped when it is only a page number (also a roman one) or
 *    when its text without digits is on 3 or more pages near it (running heads and feet);
 *  - a page's end ends no paragraph: the text goes on on the next page, unless that page starts with an indent or
 *    the last line was a short one that ended a sentence. (Not knowable: a paragraph that ends with a FULL last line
 *    at the page's end, in a book without indents. It is joined to the next one; about 1 in 100 paragraphs.)
 *  - a word cut with a hyphen at a line's end is joined ("exam-" + "ple"); a hyphen that belongs to the word stays
 *    when the word was seen whole somewhere before ("well-known"), else it is lost ("wellknown");
 *  - two columns: when (nearly) all the text of a page leaves an empty band in its middle, the left column is read
 *    before the right one. Other layouts (three columns, tables, text turned on its side) are left as pdf.js gives
 *    them. Footnotes are not taken out: they come where the page has them, and a footnote mark stays at its word
 *    ("claim1"). A running head that is on fewer than 3 pages stays in the text.
 */
import type { RawParagraph } from '@core/import/text';

/** one piece of text as pdf.js gives it (getTextContent): transform[4] / [5] = x / y of its start, y grows upwards */
export interface PdfItem { str: string; hasEOL?: boolean; transform: readonly number[]; height?: number; width?: number }
export interface PdfPageSize { width?: number; height?: number }
export interface PdfPage { page: number; pages: number; items: PdfItem[]; width: number; height: number; chars: number; failed?: boolean; scan?: boolean }
export interface PdfBlock extends RawParagraph { kind: 'p' | 'h2'; page: number }

/** the first pages are held back to learn the running heads; later the builder is this many pages behind */
export const HOLD = 12;
export const AHEAD = 6;
/** a running head counts when it is on 3 pages within this many pages */
const NEAR = 8;
/** the top and the bottom of a page where heads, feet and page numbers are */
const EDGE = 0.08;
/** a page with fewer letters than this has "no text" */
export const SCAN_CHARS = 20;
/** the longest time without a turn for the screen */
export const PAUSE_MS = 40;

// ---------------------------------------------------------------------------------------------------------------
// lines

interface Line {
  text: string;
  /** the left end, the baseline and the letter height of its main text; the right end (when the widths are known) */
  x: number; y: number; h: number; x2: number; wide: boolean;
  /** the letters on the main baseline (the longest run decides what the line's baseline is) */
  n: number;
  /** the baseline of a drop cap in this line: the lines beside it are no indents */
  cap?: number;
  /** it is in the page's top or bottom edge; its text without digits */
  edge?: boolean; key?: string;
}

const heightOf = (it: PdfItem): number => it.height || Math.hypot(it.transform[2] ?? 0, it.transform[3] ?? 0);
/** a big first letter (at most 3 signs) and a line whose baseline is inside it */
const capFits = (capY: number, capH: number, capLen: number, y: number, h: number): boolean => capLen <= 3 && capH >= 1.8 * h && y >= capY - 0.1 * capH && y <= capY + capH;

export function charsOf(items: readonly PdfItem[]): number {
  let n = 0;
  for (const it of items) n += it.str.replace(/\s+/g, '').length;
  return n;
}

/** The items in their order -> lines. The places decide, not hasEOL (pdf.js ends a "line" at many footnote marks). */
function linesOf(items: readonly PdfItem[]): Line[] {
  const out: Line[] = [];
  let cur: Line | null = null;
  // (the last item: its right end and its start, and whether pdf.js ended a line after it)
  let end = 0, lastX = 0, eol = false;
  const push = (): void => { if (cur) { cur.text = cur.text.replace(/\s+/g, ' ').trim(); if (cur.text) out.push(cur); } cur = null; };
  for (const it of items) {
    const s = it.str;
    if (!s.trim()) { if (s && cur) cur.text += ' '; if (it.hasEOL) eol = true; continue; }
    const x = it.transform[4], y = it.transform[5], h = heightOf(it), w = it.width ?? 0, len = s.trim().length;
    let same = false, cap = false;
    if (cur) {
      const dy = Math.abs(y - cur.y), H = Math.max(cur.h, h);
      same = H ? dy <= 0.5 * H : dy <= 2;
      // (pdf.js ended the line and the text goes back to the left: a new line, even when the heights are odd)
      if (same && eol && x < lastX - 1 && dy > 0.25 * H) same = false;
      if (!same && (capFits(cur.y, cur.h, cur.text.trim().length, y, h) || (x < cur.x && capFits(y, h, len, cur.y, cur.h)))) same = cap = true;
    }
    if (!cur || !same) {
      push();
      cur = { text: s, x, y, h, x2: x + w, wide: w > 0, n: len };
    } else if (cap) {
      const first = h > cur.h;
      const [a, b] = first ? [s.trim(), cur.text.trim()] : [cur.text.trim(), s.trim()];
      cur.cap = first ? y : cur.y;
      // ("T" + "he old house": one word)
      cur.text = a + (/^\p{Ll}/u.test(b) ? '' : ' ') + b;
      if (!first) { cur.y = y; cur.h = h; cur.n = len; }
    } else {
      // (after a line end of pdf.js nothing says whether a space was there: the empty room does)
      const space = eol && cur.wide && w > 0 && x - end > 0.15 * Math.max(cur.h, h) && !/\s$/.test(cur.text) && !/^\s/.test(s);
      cur.text += (space ? ' ' : '') + s;
      if (Math.abs(y - cur.y) < 0.5) { cur.n += len; cur.h = Math.max(cur.h, h); } else if (len > cur.n) { cur.n = len; cur.y = y; cur.h = h; }
    }
    if (same) { cur.x = Math.min(cur.x, x); cur.x2 = Math.max(cur.x2, x + w); if (!(w > 0)) cur.wide = false; }
    end = x + w; lastX = x; eol = !!it.hasEOL;
  }
  push();
  return out;
}

/**
 * Two columns? When (nearly) no text is in a band in the middle of the page and both sides hold real text, the
 * items are given as parts in reading order: the left column, then the right one (a line over both, a title, is a
 * `full` part of its own at its place). Otherwise one part: the items as they are.
 */
interface Part { items: readonly PdfItem[]; full?: boolean }
function columnsOf(items: readonly PdfItem[]): Part[] {
  const BIN = 2;
  let lo = Infinity, hi = -Infinity, n = 0, known = 0, all = 0;
  for (const it of items) {
    if (!it.str.trim()) continue;
    n++;
    const w = it.width ?? 0;
    if (!(w > 0)) continue;
    known++; all += it.str.length;
    lo = Math.min(lo, it.transform[4]); hi = Math.max(hi, it.transform[4] + w);
  }
  const span = hi - lo;
  if (known < 12 || known < n * 0.9 || !(span > 100)) return [{ items }];
  const bins = Math.ceil(span / BIN) + 2, diff = new Int32Array(bins + 1);
  for (const it of items) {
    const w = it.width ?? 0;
    if (!it.str.trim() || !(w > 0)) continue;
    diff[Math.floor((it.transform[4] - lo) / BIN)]++;
    diff[Math.floor((it.transform[4] + w - lo) / BIN) + 1]--;
  }
  // (the widest run of empty places in the middle 40 %; a title or a page number may cross it)
  const few = Math.max(2, Math.floor(known * 0.04));
  let best = 0, at = 0, run = 0, cover = 0;
  for (let i = 0; i < bins; i++) {
    cover += diff[i];
    if (cover <= few && i >= bins * 0.3 && i <= bins * 0.7) { run++; if (run > best) { best = run; at = i - run + 1; } } else run = 0;
  }
  if (best * BIN < Math.max(8, span * 0.02)) return [{ items }];
  const a = lo + at * BIN, b = a + best * BIN, mid = (a + b) / 2;
  let nl = 0, nr = 0;
  for (const it of items) {
    const w = it.width ?? 0;
    if (!it.str.trim() || !(w > 0)) continue;
    if (it.transform[4] + w <= a + BIN) nl += it.str.length; else if (it.transform[4] >= b - BIN) nr += it.str.length;
  }
  if (Math.min(nl, nr) < all * 0.25) return [{ items }];
  const out: Part[] = [];
  let left: PdfItem[] = [], right: PdfItem[] = [], full: PdfItem[] | null = null, to: PdfItem[] = left;
  const cols = (): void => { if (left.length) out.push({ items: left }); if (right.length) out.push({ items: right }); left = []; right = []; };
  for (const it of items) {
    if (it.str.trim()) {
      const x = it.transform[4], w = it.width ?? 0;
      if (x < a - BIN && x + w > b + BIN) { if (!full) { cols(); full = []; out.push({ items: full, full: true }); } to = full; }
      else { full = null; to = x + w / 2 < mid ? left : right; }
    }
    to.push(it);
  }
  cols();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// what a line is

const ROMAN = /^(?=.)c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;
/** "12", "- 12 -", "xiv", "Page 12 of 300": a page number and nothing else */
function numberOnly(text: string): boolean {
  if (text.length > 16) return false;
  if (/^(?:page|pg\.?|p\.)\s*\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(text)) return true;
  const t = text.replace(/[^\p{L}\p{N}]/gu, '');
  if (/^\d{1,5}$/.test(t)) return true;
  return (t === t.toLowerCase() || t === t.toUpperCase()) && ROMAN.test(t.toLowerCase());
}
/** a running head's text without its page number ("12 The Great Book" and "The Great Book 14" are the same) */
const keyOf = (text: string): string => text.toLowerCase().replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[ivxlc]+ | [ivxlc]+$/g, '');

const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty';
/** "Chapter 3", "CHAPTER III", "Part Two", "Chapter 3: The River" (the words after the number are in group 1) */
const CHAPTER = new RegExp(`^(?:chapter|part|book)\\s+(?:\\d{1,3}|[ivxlc]+|${NUMBER_WORDS})\\b[\\s.:—–-]*(.*)$`, 'i');
const SENT_END = /[.!?…]["”’'»)\]]*$/u;
/** a line that ends here, not in the middle of a sentence (also "he said:" and a closing quote) */
const LINE_END = /[.!?…:—–]["”’'»)\]]*$|["”’»]$/u;
const HYPHEN_END = /(\p{L}+)([-\u00AD\u2010])$/u;

const median = (xs: readonly number[]): number => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** the page's usual left edge: the leftmost place where several lines start (a tenth of them, at least two) */
function leftEdge(lines: readonly Line[]): number {
  const xs = lines.map((l) => l.x).sort((a, b) => a - b);
  const need = Math.max(2, Math.ceil(xs.length * 0.1));
  for (let i = 0; i < xs.length; i++) {
    let n = 1;
    while (i + n < xs.length && xs[i + n] - xs[i] <= 1.5) n++;
    if (n >= need) return xs[i];
  }
  return xs[0];
}
/** where a full line ends (0 = not known: no widths, or too few lines) */
function rightEdge(lines: readonly Line[]): number {
  const xs = lines.filter((l) => l.wide).map((l) => l.x2).sort((a, b) => a - b);
  return xs.length >= 3 ? xs[Math.floor((xs.length - 1) * 0.85)] : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// the builder

/** `hard` = the layout changes here (one column <-> two): no paragraph goes on over it */
interface Held { no: number; parts: { lines: Line[]; hard: boolean }[] }
interface Open { kind: 'p' | 'h2'; text: string; page: number; lines: number; big?: boolean }

export class PdfTextBuilder {
  /** pages given so far; those of them without any text; those that could not be read; all letters */
  pages = 0;
  emptyPages = 0;
  failedPages = 0;
  chars = 0;

  private queue: Held[] = [];
  /** page -> the texts (without digits) of the lines in its top and bottom edge */
  private seen = new Map<number, string[]>();
  private heads = new Set<string>();
  /** letter height -> letters in that height (the most used one is the body text) */
  private sizes = new Map<number, number>();
  /** words with a hyphen that were seen whole ("well-known") */
  private compounds = new Set<string>();
  private cur: Open | null = null;
  private med = 0;
  /** how wide a full line was on the last page that showed it */
  private measure = 0;
  /** was the last line a short one (null = not known) */
  private lastShort: boolean | null = null;
  /** paragraph starts seen inside pages, and how many of them had an indent */
  private breaks = 0;
  private dents = 0;

  /** One page of pdfPages(). Returns the blocks that are finished now. */
  add(p: PdfPage): PdfBlock[] { return this.take(p.items, p, !!p.failed); }
  /** One page as plain data: its text items and its size (without a height the top and bottom lines are the edge). */
  addPage(items: readonly PdfItem[], size: PdfPageSize = {}): PdfBlock[] { return this.take(items, size, false); }
  /** The end of the file (or a cancel): everything that is still held back. */
  flush(): PdfBlock[] {
    const out = this.drain(true);
    this.close(out);
    return out;
  }

  private take(items: readonly PdfItem[], size: PdfPageSize, failed: boolean): PdfBlock[] {
    const no = ++this.pages, n = charsOf(items);
    this.chars += n;
    if (failed) this.failedPages++; else if (!n) this.emptyPages++;
    const cols = columnsOf(items);
    const parts = cols.map((c, i) => ({ lines: linesOf(c.items), hard: !!c.full || !!cols[i - 1]?.full })).filter((p) => p.lines.length);
    const all = parts.flatMap((p) => p.lines);
    const height = size.height ?? 0;
    let top = -Infinity, bottom = Infinity;
    for (const l of all) { top = Math.max(top, l.y); bottom = Math.min(bottom, l.y); }
    const keys: string[] = [];
    for (const l of all) {
      const k = Math.round(l.h * 2) / 2;
      this.sizes.set(k, (this.sizes.get(k) ?? 0) + l.text.length);
      for (const m of l.text.matchAll(/\p{L}+(?:-\p{L}+)+/gu)) { const w = m[0].toLowerCase().split('-'); for (let i = 1; i < w.length; i++) this.compounds.add(`${w[i - 1]}-${w[i]}`); }
      l.edge = height > 0 ? l.y > height * (1 - EDGE) || l.y < height * EDGE : all.length >= 3 && (l.y === top || l.y === bottom);
      if (l.edge) { l.key = keyOf(l.text); keys.push(l.key); }
    }
    this.seen.set(no, keys);
    this.seen.delete(no - 2 * NEAR - AHEAD - 1);
    this.queue.push({ no, parts });
    return this.drain(false);
  }

  private drain(all: boolean): PdfBlock[] {
    const out: PdfBlock[] = [];
    while (this.queue.length && (all || (this.pages >= HOLD && this.pages - this.queue[0].no >= AHEAD))) {
      const p = this.queue.shift()!;
      for (const part of p.parts) this.body(part.lines.filter((l) => !this.noise(l, p.no)), p.no, out, part.hard);
    }
    return out;
  }

  /** a page number, or a running head / foot (the same text on 3 or more pages near this one) */
  private noise(l: Line, no: number): boolean {
    if (!l.edge) return false;
    if (numberOnly(l.text)) return true;
    const key = l.key ?? '';
    if (!key) return false;
    if (this.heads.has(key)) return true;
    let n = 0;
    for (let p = no - NEAR; p <= no + NEAR; p++) if (this.seen.get(p)?.includes(key)) n++;
    if (n < 3) return false;
    this.heads.add(key);
    return true;
  }

  private bodyHeight(): number {
    let best = 0, most = 0;
    for (const [h, n] of this.sizes) if (n > most) { most = n; best = h; }
    return best;
  }

  /** a book whose paragraphs start with an indent: there a line at the left edge goes on with its paragraph */
  private indentBook(): boolean { return this.dents >= 3 && this.dents >= this.breaks * 0.8; }

  private heading(l: Line, bodyH: number, full: boolean): boolean {
    const t = l.text;
    if (bodyH > 0 && l.h >= 1.2 * bodyH && t.length <= 120 && /\p{L}{2}|\d/u.test(t)) return true;
    const m = CHAPTER.exec(t);
    if (!m || t.length > 60 || !/^\p{Lu}/u.test(t)) return false;
    // ("Part two of the plan was that he would" is a sentence: its words go on small, or to the line's end)
    const rest = m[1];
    return !rest || (!full && /^[\p{Lu}\p{N}"“‘']/u.test(rest) && !/[.,;!?]$/.test(rest));
  }

  /** the lines of a page (or of one column) after the paragraph that is open */
  private body(lines: readonly Line[], page: number, out: PdfBlock[], hard: boolean): void {
    if (!lines.length) return;
    // (a page with one or two lines: as wide as the page before)
    const left = leftEdge(lines), edge = rightEdge(lines), right = edge || (this.measure && lines.every((l) => l.wide) ? left + this.measure : 0), bodyH = this.bodyHeight();
    if (edge) this.measure = edge - left;
    const ds: number[] = [];
    for (let i = 1; i < lines.length; i++) { const d = lines[i - 1].y - lines[i].y; if (d >= 0.5 * Math.max(lines[i - 1].h, lines[i].h)) ds.push(d); }
    // (and the line distance of the page before)
    const med = ds.length >= 2 ? median(ds) : this.med || ds[0] || 0;
    if (ds.length >= 2) this.med = med;
    const short = (l: Line): boolean => right > 0 && l.wide && l.x2 < right - 0.2 * (right - left);
    let prev: Line | null = null, capY = Infinity;
    for (const l of lines) {
      const d = prev ? prev.y - l.y : 0, H = prev ? Math.max(prev.h, l.h) : l.h;
      // (an indent is half a letter height or more; lines of one edge differ by less)
      const tol = Math.max(2.5, 0.45 * (l.h || bodyH));
      if (l.y < capY - 1) capY = Infinity;
      const indent = l.x > left + tol && capY === Infinity;
      if (l.cap !== undefined) capY = l.cap;
      // (a new page or column, or the text jumps up: the sentence may go on) / (one line that came in two pieces)
      const fresh = !prev || d <= -1.5 * H, sameLine = !fresh && d < 0.5 * H;
      const cur = this.cur;
      const follows = !!prev && !fresh && Math.abs(prev.h - l.h) <= 0.1 * l.h && d <= 1.8 * l.h;
      if (!sameLine && this.heading(l, bodyH, right > 0 && l.wide && l.x2 > right - 0.1 * (right - left))) {
        if (cur && follows && (cur.kind === 'h2' || cur.big)) {
          // (a fourth line in the big letters: this is no heading, it is text set big)
          if (cur.kind === 'h2' && cur.lines >= 3) { cur.kind = 'p'; cur.big = true; }
          this.append(l.text);
        } else { this.close(out); this.cur = { kind: 'h2', text: l.text, page, lines: 1 }; }
      } else {
        let brk: boolean;
        if (!cur) brk = true;
        else if (sameLine) brk = false;
        else if (cur.kind === 'h2') brk = true;
        else if (HYPHEN_END.test(cur.text) && /^\p{Ll}/u.test(l.text)) brk = false;
        else if (!prev || fresh) brk = (hard && !prev) || indent || (SENT_END.test(cur.text) && (this.lastShort ?? !this.indentBook()));
        else {
          const gap = med > 0 && d > 1.3 * med;
          const dent = indent && (l.x > prev.x + tol || LINE_END.test(prev.text) || short(prev));
          brk = gap || dent || (short(prev) && SENT_END.test(prev.text));
          if (brk) { this.breaks++; if (indent) this.dents++; }
        }
        if (brk) { this.close(out); this.cur = { kind: 'p', text: l.text, page, lines: 1 }; } else this.append(l.text);
      }
      prev = l;
      this.lastShort = right > 0 && l.wide ? short(l) : null;
    }
  }

  /** the next line of the open block: a word cut at the line's end is joined */
  private append(text: string): void {
    const c = this.cur!;
    c.lines++;
    const m = HYPHEN_END.exec(c.text), w = /^\p{L}+/u.exec(text);
    if (!m || !w) { c.text += ` ${text}`; return; }
    // ("Anglo-" + "Saxon" and a "well-known" seen whole keep the hyphen; "exam-" + "ple" loses it)
    const keep = m[2] !== '\u00AD' && (!/^\p{Ll}/u.test(text) || this.compounds.has(`${m[1]}-${w[0]}`.toLowerCase()));
    c.text = c.text.slice(0, -1) + (keep ? '-' : '') + text;
  }

  private close(out: PdfBlock[]): void {
    const c = this.cur;
    if (c?.text) out.push({ kind: c.kind, text: c.text, page: c.page });
    this.cur = null;
  }
}

/** The whole text at once, paragraphs with an empty line between them (the older reader page; tests). */
export function pagesToText(pages: readonly (readonly PdfItem[])[]): string {
  const b = new PdfTextBuilder(), out: string[] = [];
  for (const items of pages) for (const k of b.addPage(items)) out.push(k.text);
  for (const k of b.flush()) out.push(k.text);
  return out.join('\n\n');
}

// ---------------------------------------------------------------------------------------------------------------
// scans

/**
 * Pictures of pages? `chars` = the letters of the pages read so far, in order. True when the first 10 pages (or all
 * `pages` of a shorter file) are known and at least 8 in 10 of them have under SCAN_CHARS letters. (Not "6 in 10":
 * a real book can start with a cover, empty pages and a title page.)
 */
export function looksScanned(chars: readonly number[], pages = 10): boolean {
  const n = Math.min(10, pages);
  if (n < 1 || chars.length < n) return false;
  let empty = 0;
  for (let i = 0; i < n; i++) if (chars[i] < SCAN_CHARS) empty++;
  return empty >= Math.ceil(n * 0.8);
}

// ---------------------------------------------------------------------------------------------------------------
// pdf.js

interface JsPage {
  view: number[]; rotate: number;
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
  streamTextContent?: () => ReadableStream<{ items: unknown[] }>;
  cleanup(): void;
}
interface JsDoc { numPages: number; getPage(n: number): Promise<JsPage> }
interface JsTask { promise: Promise<JsDoc>; destroy(): Promise<void> }
interface JsLib { getDocument(o: Record<string, unknown>): JsTask }

let lib: Promise<JsLib> | null = null;
function pdfjs(): Promise<JsLib> {
  lib ??= (async () => {
    // (pdf.js does its work in this page, not in a worker of its own: a worker file may not load inside the iPhone apps)
    // (pdf.js uses Promise.withResolvers, which Safari has only from iOS 17.4)
    const P = Promise as unknown as { withResolvers?: () => unknown };
    if (!P.withResolvers) P.withResolvers = () => { let resolve!: (v: unknown) => void, reject!: (e: unknown) => void; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
    await import('pdfjs-dist/build/pdf.worker.mjs');
    return (await import('pdfjs-dist/build/pdf.mjs')) as JsLib;
  })();
  lib.catch(() => { lib = null; });
  return lib;
}

const now = (): number => performance.now();
/** a turn for the screen (a paint, a tap on Cancel): a new task, without the 4 ms a timer inside a timer costs */
const turn = (): Promise<void> => new Promise((done) => {
  if (typeof MessageChannel === 'undefined') { setTimeout(done, 0); return; }
  const c = new MessageChannel();
  c.port1.onmessage = () => { c.port1.close(); done(); };
  c.port2.postMessage(0);
});

const isItem = (x: unknown): x is PdfItem => typeof x === 'object' && x !== null && 'str' in x;

export interface PdfPagesOptions {
  signal?: AbortSignal;
  /** where pdf.js finds its CMap files, when the app ships them (fonts of some Chinese / Japanese PDFs need them) */
  cMapUrl?: string;
}

/**
 * The pages of a PDF, one after the other. See the top of this file. `bytes` is taken over by pdf.js (no copy is
 * made of a whole ArrayBuffer, or of a Uint8Array that covers its whole buffer): it is empty afterwards.
 */
export async function* pdfPages(bytes: ArrayBuffer | Uint8Array, opts: PdfPagesOptions = {}): AsyncGenerator<PdfPage, void, void> {
  const { signal } = opts;
  if (signal?.aborted) return;
  const js = await pdfjs();
  const task = js.getDocument({ data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), ...(opts.cMapUrl ? { cMapUrl: opts.cMapUrl, cMapPacked: true } : {}) });
  const stop = (): void => { void task.destroy().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    let doc: JsDoc;
    try { doc = await task.promise; } catch (e) { if (signal?.aborted) return; throw e; }
    const pages = doc.numPages, counts: number[] = [];
    let last = now(), asked = false;
    const breathe = async (always: boolean): Promise<void> => { if (always || now() - last > PAUSE_MS) { await turn(); last = now(); } };
    /** the text of one page, in the page's own upright frame (x to the right, y up from its bottom left corner) */
    const read = async (n: number): Promise<PdfPage> => {
      const page = await doc.getPage(n);
      try {
        const items: PdfItem[] = [];
        if (typeof page.streamTextContent === 'function') {
          const reader = page.streamTextContent().getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const x of value.items) if (isItem(x)) items.push(x);
            if (signal?.aborted) { void reader.cancel().catch(() => {}); break; }
            await breathe(false);
          }
        } else for (const x of (await page.getTextContent()).items) if (isItem(x)) items.push(x);
        const v = page.getViewport({ scale: 1 }), [x0, y0] = page.view;
        if (x0 || y0 || page.rotate % 360) {
          // (a page box that does not start at 0, or a page that is shown turned: the places as they are seen)
          const m = v.transform;
          for (let i = 0; i < items.length; i++) {
            const t = items[i].transform;
            items[i] = { ...items[i], transform: [m[0] * t[0] + m[2] * t[1], -(m[1] * t[0] + m[3] * t[1]), m[0] * t[2] + m[2] * t[3], -(m[1] * t[2] + m[3] * t[3]), m[0] * t[4] + m[2] * t[5] + m[4], v.height - (m[1] * t[4] + m[3] * t[5] + m[5])] };
          }
        }
        return { page: n, pages, items, width: v.width, height: v.height, chars: charsOf(items) };
      } finally { page.cleanup(); }
    };
    for (let n = 1; n <= pages; n++) {
      if (signal?.aborted) return;
      let p: PdfPage;
      try { p = await read(n); } catch { p = { page: n, pages, items: [], width: 0, height: 0, chars: 0, failed: true }; }
      if (signal?.aborted) return;
      counts.push(p.chars);
      if (!asked && looksScanned(counts, pages)) {
        // (the start has no text: a look at a few pages of the rest, so that a book with empty first pages is no "scan")
        asked = true;
        const look = new Set<number>();
        for (let k = 1; k <= 6; k++) { const at = n + Math.round((k * (pages - n)) / 6); if (at > n) look.add(at); }
        let empty = 0;
        for (const at of look) {
          try { if ((await read(at)).chars < SCAN_CHARS) empty++; } catch { empty++; }
          if (signal?.aborted) return;
          await breathe(true);
        }
        if (empty >= look.size * 0.8) p.scan = true;
      }
      yield p;
      await breathe(true);
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    await task.destroy().catch(() => {});
  }
}

/** The whole text of a PDF at once (the older reader page). Pictures of pages give ''. */
export async function pdfToText(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const b = new PdfTextBuilder(), out: string[] = [];
  for await (const p of pdfPages(bytes)) {
    if (p.scan) break;
    for (const k of b.add(p)) out.push(k.text);
  }
  for (const k of b.flush()) out.push(k.text);
  return out.join('\n\n');
}
