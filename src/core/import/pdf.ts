import path from 'node:path';
import type { Book, Chapter, Paragraph, ParagraphKind } from '@core/model';
import type { ImportContext, Importer } from './types';

/**
 * PDF importer (Electron main process, Node; pdf.js legacy build, no worker).
 *
 * pdf.js hands us positioned text runs per page, optionally with marked-content tags. Turning those
 * into paragraphs is a heuristic pipeline. Every stage is a pure function over plain data, so the unit
 * tests feed hand-built pages as well as real files (`buildBook` is the pure entry point, `readPdf`
 * the pdf.js glue, `pdfImporter` the combination).
 *
 *  1. Runs -> lines. Within a page, runs are grouped by baseline (transform[5]) within half a font
 *     size and ordered by x; a space is inserted between runs separated by more than 0.12 em.
 *     Two-column pages are detected from a clear vertical gap in the x coverage of the runs: the page
 *     is then read left column top-to-bottom, then right column; a full-width line (a title spanning
 *     both columns) splits the columns into bands that are read one after the other.
 *     On tagged pages (a structure tree, or P/H marked content in the content stream) the structure
 *     element decides which runs belong to one paragraph, and /Artifact content (running headers,
 *     page numbers) is dropped outright.
 *  2. Running headers/footers. A line whose text repeats at the same height on >= 3 pages (>= 60% of
 *     the pages of a short document) is dropped. In the top/bottom 10% of the page the comparison
 *     also ignores digits ("Page 3 of 10"), and lines that are nothing but a page number (digits,
 *     roman numerals, "Page 3", "- 3 -") are dropped too. Headings outside that band are never
 *     treated as running lines, so "Chapter 1/2/3" at the top of chapter pages survives.
 *  3. Body statistics: the character-weighted median font size is the body size; the median
 *     baseline-to-baseline distance (ignoring big gaps) is the leading; the mean advance per
 *     character of body-sized lines is the character width.
 *  4. Headings: lines whose font size is >= 1.25 x the body size, or short ALL-CAPS lines. Adjacent
 *     heading lines of the same size merge into one heading. The largest size used by at least two
 *     headings is the chapter level (h1), anything larger (a title page) is h1 too, the next size
 *     down is h2, everything else h3.
 *  5. Lines -> paragraphs (untagged content). A new paragraph starts at a heading, at a bullet, when
 *     the gap to the previous line is clearly bigger than the leading (> 1.4 x body size and > 1.15 x
 *     leading), when the line is indented by more than 1.5 character widths after a line ending in
 *     terminal punctuation, or after a short line (< 65% of the column width) ending in terminal
 *     punctuation. Across column and page boundaries only the last two rules apply, so paragraphs
 *     continue across pages. Tagged paragraphs continue across a page boundary only when the previous
 *     line has no terminal punctuation or the next line starts with a lowercase letter.
 *  6. Lines are joined with a space. A line ending in a hyphen is joined to a following line that
 *     starts with a lowercase letter without a space; the hyphen is KEPT when the compound occurs
 *     hyphenated elsewhere in the document ("well-known") or when the part before it is a single
 *     letter or ALL CAPS ("T-shirt"), REMOVED when the closed form occurs elsewhere, and otherwise
 *     REMOVED ("hyphen-" + "ated" -> "hyphenated"). Soft hyphens (U+00AD) at a line end are always
 *     removed. A hyphen before a capital or a digit is kept with no space ("Jean-" + "Paul").
 *  7. Chapters start at h1 headings. With fewer than two h1 headings the document is cut into
 *     15-page chunks titled "Pages 1-15" etc., or is a single chapter when it is shorter than that.
 *  8. Title: PDF metadata title (ignoring producer placeholders such as "untitled" and stripping
 *     "Microsoft Word - x.docx"), else the first heading, else the file name.
 *
 * Rejected documents: image-only PDFs (fewer than 40 text characters per page on average) and text
 * layers that do not decode to English (fonts without a usable ToUnicode map give private-use or
 * shifted characters; non-Latin documents are refused for the same reason).
 *
 * Not handled in v1: rotated text (skipped), OCR, footnotes, tables, page numbers in the Book model.
 */

// ------------------------------------------------------------------------------------------------
// Input model: structurally what pdf.js returns, declared here so the pipeline is testable without it.
// ------------------------------------------------------------------------------------------------

export interface RawTextItem {
  str: string;
  /** [a, b, c, d, e, f]; e/f are the baseline origin in PDF points (y grows upwards). */
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
  fontName?: string;
  dir?: string;
}
export interface RawMarkedContent {
  type: string; // 'beginMarkedContent' | 'beginMarkedContentProps' | 'endMarkedContent'
  id?: string | null;
  tag?: string;
}
export type RawItem = RawTextItem | RawMarkedContent;

/** pdf.js `page.getStructTree()` node shapes. */
export interface StructContent { type: string; id: string }
export interface StructNode { role: string; children: Array<StructNode | StructContent> }

export interface RawPage {
  width: number;
  height: number;
  /** `getTextContent({ includeMarkedContent: true }).items` */
  items: RawItem[];
  structTree?: StructNode | null;
}

export interface PdfInput {
  pages: RawPage[];
  /** metadata title/author as pdf.js reports them (may be placeholders; cleaned here) */
  title?: string | null;
  author?: string | null;
}

export const SCANNED_ERROR = 'This PDF has no text layer (scanned images). OCR is not supported yet.';
export const GARBAGE_ERROR =
  'The text layer of this PDF cannot be read: its fonts have no usable character mapping, or the text is not English. ' +
  'Try re-exporting the PDF or using an EPUB.';

// ------------------------------------------------------------------------------------------------
// Tuning constants (see the module comment for what each one does)
// ------------------------------------------------------------------------------------------------

const MIN_CHARS_PER_PAGE = 40;
const FOREIGN_TOKEN_RATIO = 0.4;
const MIN_COMMON_WORD_RATIO = 0.08;
const BASELINE_TOLERANCE = 0.5; // x font size
const WORD_GAP_EM = 0.12;
const HEADING_SIZE_RATIO = 1.25;
const PARAGRAPH_GAP_RATIO = 1.4; // x body size
const LEADING_GAP_RATIO = 1.15; // x typical leading
const INDENT_CHAR_WIDTHS = 1.5;
const SHORT_LINE_RATIO = 0.65;
const MARGIN_BAND = 0.1; // top/bottom share of the page height where page furniture lives
const RUNNING_Y_TOLERANCE = 0.012; // share of the page height
const PAGES_PER_CHUNK = 15;
const MIN_RUNS_FOR_COLUMNS = 12;
const COLUMN_SPAN_SHARE = 0.06; // runs allowed to cross the gutter (a title)
const MAX_CAPS_HEADING_WORDS = 12;

/** Structure roles that start a paragraph, with the paragraph kind they imply. */
const BLOCK_ROLES: Record<string, ParagraphKind> = {
  P: 'p', H: 'h2', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3', Title: 'h1',
  Caption: 'caption', BlockQuote: 'blockquote', LI: 'li', LBody: 'li', Lbl: 'li',
  TD: 'p', TH: 'p', Note: 'p', Code: 'pre', Formula: 'p', TOCI: 'p', Index: 'p',
};

/**
 * Fry's most frequent English words. Any English text has well over 8% of its tokens in this list;
 * a shifted or private-use text layer has none.
 */
const COMMON_WORDS = new Set((
  'the of and a to in is you that it he was for on are as with his they i at be this have from or one had by ' +
  'word but not what all were we when your can said there use an each which she do how their if will up other ' +
  'about out many then them these so some her would make like him into time has look two more write go see ' +
  'number no way could people my than first water been call who oil its now find long down day did get come ' +
  'made may part over new sound take only little work know place year live me back give most very after thing ' +
  'our just name good sentence man think say great where help through much before line right too mean old any ' +
  'same tell boy follow came want show also around form three small set put end does another well large must ' +
  'big even such because turn here why ask went men read need land different home us move try kind hand ' +
  'picture again change off play spell air away animal house point page letter mother answer found study still ' +
  'learn should world high every near add food between own below country plant last school father keep tree ' +
  'never start city earth eye light thought head under story saw left don\'t few while along might close ' +
  'something seem next hard open example begin life always those both paper together got group often run'
).split(' '));

/** A token looks Latin when every character is in the ranges a normal English text layer uses. */
const LATIN_TOKEN = /^[ -~ -ÿĀ-ɏḀ-ỿ‐-‧‰-⁞ﬀ-ﬆ]+$/;
const HAS_LETTER = /\p{L}/u;
const STARTS_LOWER = /^\p{Ll}/u;
const TERMINAL_END = /[.!?…:]["”’'»)\]]*$/u;
const BULLET_START = /^(?:[•·▪◦‣⁃■□●○*]|[-–—](?=\s))/u;
const LABEL_ONLY = /^(?:[•·▪◦‣⁃■□●○*\-–—]|\(?\d{1,3}[.)]?|\(?[a-z][.)]|\(?[ivx]{1,5}[.)])$/i;
const PAGE_NUMBER = /^[\s\-–—(\[|]*(?:(?:page|p\.?|pg\.?)\s*)?(?:\d{1,4}|[ivxlcdm]{1,8})(?:\s*(?:of|\/|-|–)\s*\d{1,4})?[\s\-–—)\]|]*$/i;

// ------------------------------------------------------------------------------------------------
// Internal data model
// ------------------------------------------------------------------------------------------------

/** One pdf.js text item, unrotated, in page coordinates. */
interface Run {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  blank: boolean;
  /** structure element ordinal (document-wide) or null for untagged content */
  elem: number | null;
  /** content-stream order, used as a tie breaker */
  order: number;
}

/** A line of text: runs on one baseline, in one reading-order block. */
interface Line {
  page: number;
  block: number;
  x0: number;
  x1: number;
  y: number;
  size: number;
  text: string;
  elem: number | null;
  role: ParagraphKind | null;
  /** font size class when the line is a heading, 0 otherwise */
  headingSize: number;
  running: boolean;
}

/** A reading-order region of a page: a whole single-column page, one column band, or a tagged element. */
interface Block {
  id: number;
  page: number;
  left: number;
  width: number;
}

interface Region { runs: Run[]; left: number; width: number }

interface DocState { nextBlock: number; nextElem: number; roleOf: Map<number, ParagraphKind> }

interface PageResult { lines: Line[]; blocks: Block[]; chars: number }

interface BodyStats { size: number; leading: number; charWidth: number }

interface Para {
  lines: Line[];
  role: ParagraphKind | null;
  headingSize: number;
  page: number;
  text: string;
}

const isTextItem = (it: RawItem): it is RawTextItem => typeof (it as RawTextItem).str === 'string';

// ------------------------------------------------------------------------------------------------
// Stage 1: runs -> lines (per page)
// ------------------------------------------------------------------------------------------------

/**
 * Maps every content id of a page's structure tree to the ordinal of its innermost block-level
 * element (P, H1, LI, ...). Ordinals are assigned in tree (= logical reading) order.
 */
function mapStructTree(tree: StructNode, state: DocState): Map<string, number> {
  const map = new Map<string, number>();
  const visit = (node: StructNode, block: number | null): void => {
    for (const child of node.children ?? []) {
      if ('type' in child) {
        if (child.type === 'content' && block !== null && typeof child.id === 'string') map.set(child.id, block);
        continue;
      }
      const role = BLOCK_ROLES[child.role];
      if (role !== undefined) {
        const elem = state.nextElem++;
        state.roleOf.set(elem, role);
        visit(child, elem);
      } else {
        visit(child, block);
      }
    }
  };
  visit(tree, null);
  return map;
}

/**
 * Converts a page's items into runs. Handles the marked-content stack: /Artifact content is dropped
 * (page furniture), and every run learns which structure element it belongs to, either through the
 * structure tree or, without one, through the block-level BDC tags in the content stream.
 */
function collectRuns(raw: RawPage, state: DocState): { runs: Run[]; chars: number } {
  const treeMap = raw.structTree ? mapStructTree(raw.structTree, state) : null;
  const runs: Run[] = [];
  let chars = 0;
  // One entry per open marked-content sequence: its content id, and the element it opened (BDC path).
  const stack: { id: string | null; artifact: boolean; elem: number | null }[] = [];
  let artifactDepth = 0;
  let lastRun: Run | null = null;

  const innermostElem = (): number | null => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].elem !== null) return stack[i].elem;
    return null;
  };

  for (const it of raw.items) {
    if (!isTextItem(it)) {
      if (it.type === 'endMarkedContent') {
        const top = stack.pop();
        if (top?.artifact) artifactDepth--;
        continue;
      }
      const artifact = it.tag === 'Artifact';
      if (artifact) artifactDepth++;
      let elem: number | null = null;
      if (!treeMap && it.tag !== undefined && BLOCK_ROLES[it.tag] !== undefined) {
        elem = state.nextElem++;
        state.roleOf.set(elem, BLOCK_ROLES[it.tag]);
      }
      stack.push({ id: typeof it.id === 'string' ? it.id : null, artifact, elem });
      continue;
    }

    const t = it.transform;
    const text = it.str;
    const blank = text.trim().length === 0;
    if (!blank) chars += text.replace(/\s+/g, '').length;
    // Rotated or vertical text (watermarks, margin notes) is not prose; skip it.
    if (Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3 || it.dir === 'ttb') continue;
    if (artifactDepth > 0) continue;

    let elem: number | null = null;
    if (treeMap) {
      for (let i = stack.length - 1; i >= 0 && elem === null; i--) {
        const id = stack[i].id;
        if (id !== null && treeMap.has(id)) elem = treeMap.get(id)!;
      }
    } else {
      elem = innermostElem();
      // BDC path: a new block that starts on the same baseline as the previous text continues the same
      // paragraph ("/P ... /Link ... /P ..." is how some producers tag a paragraph with a link in it).
      if (elem !== null && lastRun && lastRun.elem !== null && lastRun.elem !== elem && !blank &&
        Math.abs(lastRun.y - t[5]) <= BASELINE_TOLERANCE * Math.max(it.height, lastRun.height)) {
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].elem === elem) { stack[i].elem = lastRun.elem; break; }
        elem = lastRun.elem;
      }
    }
    const run: Run = { text, x: t[4], y: t[5], width: it.width, height: blank ? 0 : it.height, blank, elem, order: runs.length };
    runs.push(run);
    if (!blank) lastRun = run;
  }
  return { runs, chars };
}

function extentsOf(runs: Run[]): { left: number; right: number } {
  let left = Infinity;
  let right = -Infinity;
  for (const r of runs) {
    if (r.blank) continue;
    if (r.x < left) left = r.x;
    if (r.x + r.width > right) right = r.x + r.width;
  }
  return { left, right };
}

interface BaselineCluster { y: number; size: number; runs: Run[] }

/** Groups runs by baseline, top of the page first. Blank runs attach to the line they sit on. */
function clusterBaselines(runs: Run[]): BaselineCluster[] {
  const words = runs.filter((r) => !r.blank).sort((a, b) => b.y - a.y || a.x - b.x || a.order - b.order);
  const lines: BaselineCluster[] = [];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(w.y - cur.y) <= BASELINE_TOLERANCE * Math.max(cur.size, w.height)) {
      cur.runs.push(w);
      if (w.height > cur.size) { cur.size = w.height; cur.y = w.y; } // the biggest run defines the baseline
    } else {
      lines.push({ y: w.y, size: w.height, runs: [w] });
    }
  }
  for (const b of runs) {
    if (!b.blank) continue;
    const line = lines.find((l) => Math.abs(b.y - l.y) <= BASELINE_TOLERANCE * l.size);
    if (line) line.runs.push(b);
  }
  return lines;
}

/** Joins the runs of one baseline into text, inserting spaces where the geometry shows a word gap. */
function joinRuns(cluster: BaselineCluster): string {
  const runs = cluster.runs.slice().sort((a, b) => a.x - b.x || a.order - b.order);
  let text = '';
  let end = -Infinity;
  for (const r of runs) {
    if (text.length > 0 && !/\s$/.test(text) && !/^\s/.test(r.text) && r.x - end > WORD_GAP_EM * cluster.size) text += ' ';
    text += r.text;
    if (r.x + r.width > end) end = r.x + r.width;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function formLines(runs: Run[], page: number, block: number, state: DocState): Line[] {
  const out: Line[] = [];
  for (const cluster of clusterBaselines(runs)) {
    const text = joinRuns(cluster);
    if (!text) continue;
    const ext = extentsOf(cluster.runs);
    const elem = cluster.runs[0].elem;
    out.push({
      page, block, x0: ext.left, x1: ext.right, y: cluster.y, size: cluster.size, text, elem,
      role: elem === null ? null : state.roleOf.get(elem) ?? null, headingSize: 0, running: false,
    });
  }
  return out;
}

/**
 * Finds a vertical gap that splits the runs into two columns: a band of x positions that (almost) no
 * run crosses, at least 1.5 characters wide, somewhere in the middle half of the text width.
 */
function findColumnGap(words: Run[], left: number, right: number): { start: number; end: number; charWidth: number } | null {
  const width = right - left;
  if (width < 100) return null;
  let totalWidth = 0;
  let totalChars = 0;
  for (const w of words) { totalWidth += w.width; totalChars += w.text.trim().length; }
  const charWidth = totalWidth / Math.max(1, totalChars);
  const BINS = 256;
  const cover = new Uint16Array(BINS);
  for (const w of words) {
    const b0 = Math.max(0, Math.floor(((w.x - left) / width) * BINS));
    const b1 = Math.min(BINS - 1, Math.ceil(((w.x + w.width - left) / width) * BINS) - 1);
    for (let b = b0; b <= b1; b++) cover[b]++;
  }
  const limit = Math.max(1, Math.floor(words.length * COLUMN_SPAN_SHARE));
  let best: { start: number; end: number; charWidth: number } | null = null;
  let bestWidth = 0;
  for (let b = 0; b < BINS;) {
    if (cover[b] > limit) { b++; continue; }
    let e = b;
    while (e < BINS && cover[e] <= limit) e++;
    const gapWidth = ((e - b) / BINS) * width;
    const center = (b + e) / 2 / BINS;
    if (gapWidth >= Math.max(6, 1.5 * charWidth) && center >= 0.25 && center <= 0.75 && gapWidth > bestWidth) {
      best = { start: left + (b / BINS) * width, end: left + (e / BINS) * width, charWidth };
      bestWidth = gapWidth;
    }
    b = e;
  }
  return best;
}

/**
 * Splits untagged runs of a page into reading-order regions. A single-column page is one region. On
 * a two-column page, runs crossing the gutter (a spanning title) cut the columns into bands; each band
 * is read left column then right column.
 */
function layoutRegions(runs: Run[]): Region[] {
  const words = runs.filter((r) => !r.blank);
  if (words.length === 0) return [];
  const ext = extentsOf(words);
  const whole: Region = { runs, left: ext.left, width: ext.right - ext.left };
  if (words.length < MIN_RUNS_FOR_COLUMNS) return [whole];
  const gap = findColumnGap(words, ext.left, ext.right);
  if (!gap) return [whole];

  const eps = 0.5 * gap.charWidth;
  const left: Run[] = [];
  const right: Run[] = [];
  const span: Run[] = [];
  for (const r of runs) {
    if (r.x + r.width <= gap.start + eps) left.push(r);
    else if (r.x >= gap.end - eps) right.push(r);
    else span.push(r);
  }
  const count = (a: Run[]): number => a.filter((r) => !r.blank).length;
  if (count(left) < 3 || count(right) < 3 || count(span) > 0.2 * words.length) return [whole];

  const leftExt = extentsOf(left);
  const rightExt = extentsOf(right);
  const spanLines = clusterBaselines(span); // top to bottom
  const bandOf = (r: Run): number => {
    let band = 0;
    for (const s of spanLines) if (s.y > r.y + BASELINE_TOLERANCE * s.size) band++;
    return band;
  };
  const leftBands: Run[][] = [];
  const rightBands: Run[][] = [];
  for (const r of left) (leftBands[bandOf(r)] ??= []).push(r);
  for (const r of right) (rightBands[bandOf(r)] ??= []).push(r);

  const regions: Region[] = [];
  for (let band = 0; band <= spanLines.length; band++) {
    if (band > 0) {
      const s = spanLines[band - 1];
      const e = extentsOf(s.runs);
      regions.push({ runs: s.runs, left: e.left, width: e.right - e.left });
    }
    if (leftBands[band]?.length) regions.push({ runs: leftBands[band], left: leftExt.left, width: leftExt.right - leftExt.left });
    if (rightBands[band]?.length) regions.push({ runs: rightBands[band], left: rightExt.left, width: rightExt.right - rightExt.left });
  }
  return regions;
}

function extractPage(raw: RawPage, page: number, state: DocState): PageResult {
  const { runs, chars } = collectRuns(raw, state);
  const lines: Line[] = [];
  const blocks: Block[] = [];
  const addBlock = (region: Region): void => {
    const block: Block = { id: state.nextBlock++, page, left: region.left, width: Math.max(1, region.width) };
    const got = formLines(region.runs, page, block.id, state);
    if (got.length === 0) return;
    blocks.push(block);
    lines.push(...got);
  };

  // Tagged content first, element by element (tree order / stream order), then untagged content.
  const tagged = new Map<number, Run[]>();
  const untagged: Run[] = [];
  for (const r of runs) {
    if (r.elem === null) untagged.push(r);
    else { let a = tagged.get(r.elem); if (!a) tagged.set(r.elem, (a = [])); a.push(r); }
  }
  if (tagged.size > 0) {
    const pageExt = extentsOf(runs);
    for (const elem of [...tagged.keys()].sort((a, b) => a - b)) {
      addBlock({ runs: tagged.get(elem)!, left: pageExt.left, width: pageExt.right - pageExt.left });
    }
  }
  for (const region of layoutRegions(untagged)) addBlock(region);
  return { lines, blocks, chars };
}

// ------------------------------------------------------------------------------------------------
// Stage 2: document-level checks and running headers/footers
// ------------------------------------------------------------------------------------------------

/** Throws when the text layer is not usable English (see the module comment). */
export function checkTextLayer(text: string): void {
  let alphabetic = 0;
  let foreign = 0;
  let common = 0;
  for (const tok of text.split(/\s+/)) {
    if (!HAS_LETTER.test(tok)) continue;
    alphabetic++;
    if (!LATIN_TOKEN.test(tok)) foreign++;
    const word = tok.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}']+$/gu, '').replace(/[’]/g, "'");
    if (COMMON_WORDS.has(word)) common++;
  }
  if (alphabetic >= 20 && foreign / alphabetic > FOREIGN_TOKEN_RATIO) throw new Error(GARBAGE_ERROR);
  if (alphabetic >= 60 && common / alphabetic < MIN_COMMON_WORD_RATIO) throw new Error(GARBAGE_ERROR);
}

/** "3", "iv", "Page 3 of 10", "- 3 -", "p. 12", "3 / 10". */
export function isPageNumberLine(text: string): boolean {
  return PAGE_NUMBER.test(text.trim());
}

const normaliseKey = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Marks running headers/footers and page numbers. `candidates` are grouped by a text key; within a
 * group, lines at (almost) the same relative height on at least `need` different pages are running.
 */
function markRepeated(candidates: { line: Line; key: string; yRel: number }[], need: number): void {
  const groups = new Map<string, { line: Line; yRel: number }[]>();
  for (const c of candidates) {
    if (!c.key) continue;
    let g = groups.get(c.key);
    if (!g) groups.set(c.key, (g = []));
    g.push(c);
  }
  for (const g of groups.values()) {
    if (g.length < need) continue;
    g.sort((a, b) => a.yRel - b.yRel);
    let start = 0;
    for (let i = 1; i <= g.length; i++) {
      if (i < g.length && g[i].yRel - g[i - 1].yRel <= RUNNING_Y_TOLERANCE) continue;
      const cluster = g.slice(start, i);
      if (new Set(cluster.map((c) => c.line.page)).size >= need) for (const c of cluster) c.line.running = true;
      start = i;
    }
  }
}

function markRunningLines(lines: Line[], pageHeights: number[], bodySize: number): void {
  const numPages = pageHeights.length;
  const need = numPages >= 5 ? 3 : Math.max(2, Math.ceil(0.6 * numPages));
  const exact: { line: Line; key: string; yRel: number }[] = [];
  const digits: { line: Line; key: string; yRel: number }[] = [];
  for (const line of lines) {
    const h = pageHeights[line.page] || 1;
    const yRel = line.y / h;
    const inMargin = yRel <= MARGIN_BAND || yRel >= 1 - MARGIN_BAND;
    const heading = line.size >= HEADING_SIZE_RATIO * bodySize;
    if (inMargin && isPageNumberLine(line.text)) { line.running = true; continue; }
    const key = normaliseKey(line.text);
    if (inMargin || !heading) exact.push({ line, key, yRel });
    if (inMargin) digits.push({ line, key: key.replace(/\d+/g, '#'), yRel });
  }
  markRepeated(exact, need);
  markRepeated(digits, need);
}

// ------------------------------------------------------------------------------------------------
// Stage 3: body statistics and headings
// ------------------------------------------------------------------------------------------------

function round2(n: number): number { return Math.round(n * 2) / 2; }

function bodySizeOf(lines: Line[]): number {
  const byChars = new Map<number, number>();
  let total = 0;
  for (const l of lines) {
    const s = round2(l.size);
    byChars.set(s, (byChars.get(s) ?? 0) + l.text.length);
    total += l.text.length;
  }
  let acc = 0;
  for (const s of [...byChars.keys()].sort((a, b) => a - b)) {
    acc += byChars.get(s)!;
    if (acc * 2 >= total) return s;
  }
  return 10;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function bodyStats(lines: Line[]): BodyStats {
  const size = bodySizeOf(lines);
  const gaps: number[] = [];
  let width = 0;
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (Math.abs(l.size - size) <= 0.1 * size) { width += l.x1 - l.x0; chars += l.text.length; }
    const p = lines[i - 1];
    if (p && p.block === l.block) {
      const gap = p.y - l.y;
      if (gap > 0 && gap <= 3 * size) gaps.push(gap);
    }
  }
  const leading = gaps.length > 0 ? median(gaps) : 1.2 * size;
  const charWidth = chars > 0 ? width / chars : size * 0.5;
  return { size, leading, charWidth };
}

const isAllCaps = (s: string): boolean => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s) && s.replace(/[^\p{L}]/gu, '').length >= 2;

function markHeadings(lines: Line[], blocks: Map<number, Block>, stats: BodyStats): void {
  for (const l of lines) {
    if (l.size >= HEADING_SIZE_RATIO * stats.size) { l.headingSize = round2(l.size); continue; }
    const block = blocks.get(l.block)!;
    const words = l.text.split(' ').length;
    if (isAllCaps(l.text) && words <= MAX_CAPS_HEADING_WORDS && l.x1 - l.x0 < SHORT_LINE_RATIO * block.width && !/[!?,;]$/.test(l.text)) {
      l.headingSize = round2(l.size);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Stage 4: lines -> paragraphs
// ------------------------------------------------------------------------------------------------

interface HyphenEvidence { hyphenated: Set<string>; closed: Set<string> }

function collectHyphenEvidence(lines: Line[]): HyphenEvidence {
  const hyphenated = new Set<string>();
  const closed = new Set<string>();
  for (const l of lines) {
    for (const m of l.text.matchAll(/\p{L}+(?:-\p{L}+)+/gu)) hyphenated.add(m[0].toLowerCase());
    for (const m of l.text.matchAll(/\p{L}{3,}/gu)) closed.add(m[0].toLowerCase());
  }
  return { hyphenated, closed };
}

/** Decides whether the hyphen between `before` (end of a line) and `after` (start of the next) stays. */
export function keepHyphen(before: string, after: string, ev: HyphenEvidence): boolean {
  const a = before.toLowerCase();
  const b = after.toLowerCase();
  if (ev.hyphenated.has(`${a}-${b}`)) return true;
  if (ev.closed.has(a + b)) return false;
  // One-letter or ALL-CAPS prefixes are compounds ("T-shirt", "UN-backed"); everything else is a word
  // broken by the typesetter.
  return before.length < 2 || before === before.toUpperCase();
}

/** Joins consecutive lines of a paragraph, de-hyphenating line ends (see the module comment, rule 6). */
export function joinLineTexts(texts: string[], ev: HyphenEvidence): string {
  let text = texts[0] ?? '';
  for (let i = 1; i < texts.length; i++) {
    const next = texts[i];
    const m = /(\p{L}+)([-‐­])$/u.exec(text);
    if (m) {
      const soft = m[2] === '­';
      const letters = /^\p{L}+/u.exec(next);
      if (letters && STARTS_LOWER.test(next)) {
        text = soft || !keepHyphen(m[1], letters[0], ev) ? text.slice(0, -1) + next : text + next;
        continue;
      }
      if (soft) { text = text.slice(0, -1) + next; continue; }
      if (/^[\p{L}\p{N}]/u.test(next)) { text += next; continue; } // "Jean-" + "Paul", "COVID-" + "19"
    }
    text += ' ' + next;
  }
  return text.replace(/\s+/g, ' ').trim();
}

const endsTerminal = (s: string): boolean => TERMINAL_END.test(s);

/** Does `cur` start a new paragraph after `prev`? */
function startsParagraph(prev: Line, cur: Line, blocks: Map<number, Block>, stats: BodyStats): boolean {
  if (prev.headingSize > 0 || cur.headingSize > 0) {
    // Adjacent heading lines of the same size are one multi-line heading.
    const bothHeadings = prev.headingSize > 0 && cur.headingSize > 0 && Math.abs(prev.headingSize - cur.headingSize) < 0.5;
    const adjacent = prev.block === cur.block && prev.y - cur.y <= 1.8 * cur.size;
    return !(bothHeadings && adjacent);
  }
  if (cur.elem !== null || prev.elem !== null) {
    if (cur.elem === prev.elem) return false;
    if (cur.page === prev.page) return true;
    // A tagged paragraph split by a page break: pdf.js reports one element per page.
    return endsTerminal(prev.text) && !STARTS_LOWER.test(cur.text);
  }
  if (BULLET_START.test(cur.text)) return true;
  if (prev.block === cur.block) {
    const gap = prev.y - cur.y;
    if (gap > PARAGRAPH_GAP_RATIO * stats.size && gap > LEADING_GAP_RATIO * stats.leading) return true;
  }
  if (!endsTerminal(prev.text)) return false;
  const curBlock = blocks.get(cur.block)!;
  const prevBlock = blocks.get(prev.block)!;
  if (cur.x0 - curBlock.left > INDENT_CHAR_WIDTHS * stats.charWidth) return true;
  return prev.x1 - prev.x0 < SHORT_LINE_RATIO * prevBlock.width;
}

function assembleParagraphs(lines: Line[], blocks: Map<number, Block>, stats: BodyStats): Para[] {
  const ev = collectHyphenEvidence(lines);
  const paras: Para[] = [];
  let cur: Line[] = [];
  const flush = (): void => {
    if (cur.length === 0) return;
    const first = cur[0];
    paras.push({
      lines: cur,
      role: first.role,
      headingSize: cur.every((l) => l.headingSize > 0) ? first.headingSize : 0,
      page: first.page,
      text: joinLineTexts(cur.map((l) => l.text), ev),
    });
    cur = [];
  };
  for (const line of lines) {
    if (cur.length > 0 && startsParagraph(cur[cur.length - 1], line, blocks, stats)) flush();
    cur.push(line);
  }
  flush();

  // A paragraph that is only a list label ("1.", "•") belongs to the paragraph that follows it.
  const merged: Para[] = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const next = paras[i + 1];
    if (next && next.page === p.page && LABEL_ONLY.test(p.text) && next.headingSize === 0) {
      merged.push({ ...next, lines: [...p.lines, ...next.lines], text: `${p.text} ${next.text}`, role: next.role === null || next.role === 'p' ? 'li' : next.role, page: p.page });
      i++;
    } else {
      merged.push(p);
    }
  }
  return merged;
}

// ------------------------------------------------------------------------------------------------
// Stage 5: paragraph kinds, chapters, metadata
// ------------------------------------------------------------------------------------------------

function paragraphKinds(paras: Para[]): ParagraphKind[] {
  const counts = new Map<number, number>();
  for (const p of paras) if (p.headingSize > 0) counts.set(p.headingSize, (counts.get(p.headingSize) ?? 0) + 1);
  const sizes = [...counts.keys()].sort((a, b) => b - a);
  const chapterSize = sizes.find((s) => counts.get(s)! >= 2) ?? sizes[0] ?? Infinity;
  const secondSize = sizes.find((s) => s < chapterSize) ?? Infinity;
  return paras.map((p) => {
    if (p.role === 'h1' || p.role === 'h2' || p.role === 'h3') return p.role;
    if (p.headingSize > 0) return p.headingSize >= chapterSize ? 'h1' : p.headingSize >= secondSize ? 'h2' : 'h3';
    return p.role ?? 'p';
  });
}

/** Cleans a metadata title: producer placeholders and "Microsoft Word - name.docx" wrappers are not titles. */
export function cleanMetaTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/^microsoft (?:word|powerpoint|excel) - /i, '').replace(/\.(?:docx?|pdf|txt|rtf|odt|tex|indd|pptx?|md|html?)$/i, '').trim();
  if (!t || /^[(\[]?(?:untitled|anonymous|unspecified|unknown|none|null|document|title|microsoft word)[)\]]?$/i.test(t)) return null;
  return t;
}

export function cleanMetaAuthor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t || /^[(\[]?(?:anonymous|unspecified|unknown|none|null|author|user)[)\]]?$/i.test(t)) return null;
  return t;
}

function buildChapters(paras: Para[], kinds: ParagraphKind[], numPages: number, title: string): { title: string; paras: number[] }[] {
  const h1 = paras.map((_, i) => i).filter((i) => kinds[i] === 'h1');
  const chapters: { title: string; paras: number[] }[] = [];
  if (h1.length >= 2) {
    let cur: { title: string; paras: number[] } | null = null;
    for (let i = 0; i < paras.length; i++) {
      if (kinds[i] === 'h1') { cur = { title: paras[i].text, paras: [] }; chapters.push(cur); }
      else if (!cur) { cur = { title: 'Front matter', paras: [] }; chapters.push(cur); }
      cur.paras.push(i);
    }
    return chapters;
  }
  if (numPages < PAGES_PER_CHUNK) return [{ title, paras: paras.map((_, i) => i) }];
  for (let i = 0; i < paras.length; i++) {
    const chunk = Math.floor(paras[i].page / PAGES_PER_CHUNK);
    const last = chapters[chapters.length - 1] as ({ title: string; paras: number[]; chunk?: number } | undefined);
    if (!last || last.chunk !== chunk) {
      const from = chunk * PAGES_PER_CHUNK + 1;
      const to = Math.min(numPages, from + PAGES_PER_CHUNK - 1);
      chapters.push(Object.assign({ title: `Pages ${from}-${to}`, paras: [] as number[] }, { chunk }));
    }
    chapters[chapters.length - 1].paras.push(i);
  }
  return chapters;
}

// ------------------------------------------------------------------------------------------------
// Pure entry point
// ------------------------------------------------------------------------------------------------

/** Builds a Book from extracted pages. Throws SCANNED_ERROR / GARBAGE_ERROR for unusable text layers. */
export function buildBook(input: PdfInput, ctx: ImportContext): Book {
  const numPages = input.pages.length;
  if (numPages === 0) throw new Error('This PDF has no pages.');
  const state: DocState = { nextBlock: 0, nextElem: 0, roleOf: new Map() };
  const allLines: Line[] = [];
  const blocks = new Map<number, Block>();
  let chars = 0;
  input.pages.forEach((raw, i) => {
    const res = extractPage(raw, i, state);
    chars += res.chars;
    allLines.push(...res.lines);
    for (const b of res.blocks) blocks.set(b.id, b);
  });
  if (chars / numPages < MIN_CHARS_PER_PAGE) throw new Error(SCANNED_ERROR);
  checkTextLayer(allLines.map((l) => l.text).join('\n'));

  markRunningLines(allLines, input.pages.map((p) => p.height), bodySizeOf(allLines));
  const lines = allLines.filter((l) => !l.running);
  if (lines.length === 0) throw new Error(SCANNED_ERROR);
  const stats = bodyStats(lines);
  markHeadings(lines, blocks, stats);
  const paras = assembleParagraphs(lines, blocks, stats);
  const kinds = paragraphKinds(paras);

  const fileName = ctx.sourcePath ? path.basename(ctx.sourcePath, path.extname(ctx.sourcePath)) : '';
  const firstHeading = paras.find((_, i) => kinds[i] === 'h1' || kinds[i] === 'h2' || kinds[i] === 'h3');
  const title = cleanMetaTitle(input.title) ?? firstHeading?.text ?? (fileName.trim() || 'Untitled PDF');
  const author = cleanMetaAuthor(input.author) ?? undefined;

  let words = 0;
  let sentenceCount = 0;
  let paragraphCount = 0;
  const chapters: Chapter[] = buildChapters(paras, kinds, numPages, title).map((c, ci) => {
    const paragraphs: Paragraph[] = [];
    for (const pi of c.paras) {
      const text = paras[pi].text;
      const sentences = ctx.segmenter.segmentParagraph(text);
      if (sentences.length === 0) continue;
      for (const s of sentences) for (const t of s.tokens) if (t.kind === 'word') words++;
      sentenceCount += sentences.length;
      paragraphs.push({ index: paragraphs.length, kind: kinds[pi], text, sentences });
    }
    paragraphCount += paragraphs.length;
    return { index: ci, title: c.title, paragraphs };
  }).filter((c) => c.paragraphs.length > 0).map((c, ci) => ({ ...c, index: ci }));

  return {
    id: ctx.id,
    title,
    author,
    language: 'en',
    source: { kind: 'pdf', path: ctx.sourcePath, importedAt: new Date().toISOString() },
    chapters,
    names: [],
    stats: { words, paragraphs: paragraphCount, sentences: sentenceCount },
  };
}

// ------------------------------------------------------------------------------------------------
// pdf.js glue
// ------------------------------------------------------------------------------------------------

/** Loads the file with pdf.js and extracts text items, marked content, structure trees and metadata. */
export async function readPdf(bytes: Uint8Array): Promise<PdfInput> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js refuses Node Buffers and may transfer the buffer, so always hand it a private copy.
  // (pdf.js 6 dropped the `isEvalSupported` option: fonts are never compiled with `new Function` now.)
  const data = new Uint8Array(bytes);
  const task = pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: RawPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: true });
      const items = content.items as unknown as RawItem[];
      let structTree: StructNode | null = null;
      if (items.some((it) => !isTextItem(it) && typeof it.tag === 'string')) {
        structTree = (await page.getStructTree().catch(() => null)) as StructNode | null;
      }
      pages.push({ width: viewport.width, height: viewport.height, items, structTree });
      page.cleanup();
    }
    let title: string | null = null;
    let author: string | null = null;
    try {
      const meta = await doc.getMetadata();
      const info = (meta.info ?? {}) as Record<string, unknown>;
      title = typeof info.Title === 'string' ? info.Title : null;
      author = typeof info.Author === 'string' ? info.Author : null;
      if (!cleanMetaTitle(title) && meta.metadata) {
        const dc = (meta.metadata as { get(name: string): unknown }).get('dc:title');
        if (typeof dc === 'string') title = dc;
        else if (Array.isArray(dc) && typeof dc[0] === 'string') title = dc[0];
      }
    } catch {
      // metadata is optional
    }
    return { pages, title, author };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

export const pdfImporter: Importer = {
  kind: 'pdf',
  async importBytes(bytes: Uint8Array, ctx: ImportContext): Promise<Book> {
    let input: PdfInput;
    try {
      input = await readPdf(bytes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/password|encrypted/i.test(msg)) throw new Error('This PDF is password-protected. Remove the password and try again.');
      throw new Error(`Could not open this PDF: ${msg}`);
    }
    return buildBook(input, ctx);
  },
};
