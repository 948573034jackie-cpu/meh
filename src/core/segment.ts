import type { Sentence, Token, TokenKind } from './model';

/**
 * Sentence and word segmentation for English prose.
 *
 * Built on Intl.Segmenter (ICU) with a merge pass that repairs the known ICU failures on literary
 * text: title abbreviations ("Mr. Darcy"), initials ("J. K. Rowling"), common Latin abbreviations
 * ("e.g.", "etc."), closing quotes/brackets after sentence punctuation, and ellipses.
 * Word tokens keep internal apostrophes ("don't", "Darcy's") and single hyphens ("well-known").
 *
 * Conventions (consumers rely on these):
 * - All offsets index the ORIGINAL string passed in (UTF-16 code units, end exclusive), and
 *   `token.text === text.slice(token.start, token.end)` always holds.
 * - Whitespace is never emitted as a token. Tokens are sorted and non-overlapping; the gaps between
 *   them (spaces, soft hyphens, invisible format characters) are rendered as plain text by the reader.
 *   The 'space' TokenKind therefore never occurs in the output of this module.
 * - Sentences are trimmed (no leading/trailing whitespace or invisible format characters) and never
 *   empty; a paragraph with no terminal punctuation is a single sentence; a whitespace-only paragraph
 *   yields no sentences.
 * - Soft hyphens (U+00AD) are removed before segmentation so ICU sees the intact word. Offsets are
 *   mapped back, so a token that contains a soft hyphen in the middle keeps it in its text
 *   ("ab\u00ADsolutely"); a token never starts or ends with one. Dictionary lookups should fold it.
 * - Runs of adjacent punctuation collapse into one 'punct' token ("?!", "...", ".”").
 * - word + single hyphen (- U+2010 U+2011) + word, with no spaces, joins into one token
 *   ("well-known", "state-of-the-art"); a double hyphen or dash never joins. A joined token is a
 *   'number' only when every part is a number ("1-2"), otherwise a 'word' ("5-year").
 *
 * Known limitations of the heuristics (documented so the reader can explain surprising splits):
 * - A single capital letter before a period is always treated as an initial, so "Plan A. Then we
 *   left." becomes one sentence. "I." is only an initial when it follows another initial or a title.
 * - Title abbreviations always merge, so "Main St. The house..." is one sentence (spec requirement).
 * - A hard line break followed by an uppercase letter is a sentence boundary (ICU behaviour).
 */
export interface Segmenter {
  /** Splits one paragraph of plain text into sentences with word/number/punct tokens. Offsets index into `text`. */
  segmentParagraph(text: string): Sentence[];
  /** Tokenises arbitrary text (used for popups and phrase selection). */
  tokenize(text: string): Token[];
}

export type { Sentence, Token, TokenKind };

// ---------------------------------------------------------------------------------------------
// Abbreviation tables
// ---------------------------------------------------------------------------------------------

/**
 * Title-like abbreviations: a sentence practically never ends with one, so a split after them is
 * always repaired. Matched with the exact capitalisation shown, or in ALL CAPS (headings).
 */
const TITLE_ABBREVIATIONS = new Set([
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'St', 'Mt', 'Capt', 'Col', 'Gen', 'Lt', 'Sgt', 'Sr', 'Jr', 'Rev', 'Hon',
  'Messrs', 'Mme', 'Mlle',
  // a few more that behave exactly like the ones above
  'Fr', 'Sen', 'Gov', 'Pres', 'Maj', 'Adm', 'Cmdr', 'Cpl', 'Pvt', 'Supt', 'Insp', 'Brig',
]);

/**
 * Abbreviations that introduce something and therefore never end a sentence ("Brown vs. Board",
 * "e.g. Apples"). Always merged, whatever follows. Lower-cased, internal dots kept.
 */
const ALWAYS_MERGE_ABBREVIATIONS = new Set(['vs', 'v', 'e.g', 'i.e', 'cf', 'viz']);

/**
 * Abbreviations that usually continue the sentence but can also end one ("at 5 p.m. He left.").
 * Merged unless the next segment starts with an uppercase letter. Lower-cased, internal dots kept.
 */
const CONDITIONAL_ABBREVIATIONS = new Set([
  'etc', 'no', 'fig', 'figs', 'p', 'pp', 'ch', 'vol', 'vols', 'ed', 'eds', 'approx', 'inc', 'ltd', 'co', 'corp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'a.m', 'p.m', 'u.s', 'u.k', 'u.s.a', 'b.c', 'a.d',
  // common in non-fiction
  'al', 'sec', 'dept', 'univ', 'ave', 'blvd', 'rd', 'est', 'op', 'cit', 'ibid', 'eq', 'ff', 'cont', 'misc', 'bros',
]);

/** Closing quotes/brackets that ICU sometimes leaves at the start of the following segment. */
const UNAMBIGUOUS_CLOSERS = new Set(['”', '»', ')', ']']); // ” » ) ]
const AMBIGUOUS_CLOSERS = new Set(['"', "'", '’']); // " ' ’  (also used as openers / apostrophes)
/** Opening quotes/brackets that ICU sometimes glues to the END of the previous segment ("end.”“Start"). */
const UNAMBIGUOUS_OPENERS = new Set(['“', '‘', '«', '(', '[']); // “ ‘ « ( [

/** Hyphens that join two words into one token (ASCII hyphen-minus, U+2010 hyphen, U+2011 non-breaking hyphen). */
const JOINING_HYPHENS = new Set(['-', '\u2010', '\u2011']);

const SOFT_HYPHEN = '\u00AD';

// ---------------------------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------------------------

/** Whitespace plus invisible control/format characters (never part of a token, trimmed from sentences). */
const INVISIBLE_CHAR = /[\s\p{Cf}\p{Cc}]/u;
const ONLY_INVISIBLE = /^[\s\p{Cf}\p{Cc}]*$/u;
const STARTS_LOWER = /^\p{Ll}/u;
const STARTS_UPPER = /^\p{Lu}/u;
const STARTS_ALNUM = /^[\p{L}\p{N}]/u;
const SINGLE_UPPER = /^\p{Lu}$/u;
/** "3", "3.50", "1,000", "3,000.5" — digits with number punctuation between digit groups. */
const NUMBER_TOKEN = /^\p{Nd}+(?:[.,]\p{Nd}+)*$/u;
/**
 * The abbreviation candidate ending a segment: a run of letters (with optional internal dots, as in
 * "e.g" or "U.S") followed by exactly one period at the very end. Must not be preceded by a letter,
 * digit or dot, so "first." yields "first" (not "st") and "etc..." yields nothing (ellipsis).
 */
const TRAILING_ABBREVIATION = /(?:^|[^\p{L}\p{N}.])(\p{L}+(?:\.\p{L}+)*)\.$/u;
/** How much of a segment's tail the abbreviation check looks at; keeps the merge pass O(n). */
const TAIL_WINDOW = 64;

// ---------------------------------------------------------------------------------------------
// Soft-hyphen stripping with an offset map back to the original string
// ---------------------------------------------------------------------------------------------

interface Stripped {
  /** text without soft hyphens */
  text: string;
  /** orig[i] = index in the original string of the i-th character of `text`; null when nothing was stripped */
  orig: Int32Array | null;
}

function stripSoftHyphens(text: string): Stripped {
  if (text.indexOf(SOFT_HYPHEN) === -1) return { text, orig: null };
  const orig = new Int32Array(text.length);
  let out = '';
  let n = 0;
  // Build the kept text in chunks between soft hyphens to avoid per-character string concatenation.
  let chunkStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xad) {
      out += text.slice(chunkStart, i);
      chunkStart = i + 1;
    } else {
      orig[n++] = i;
    }
  }
  out += text.slice(chunkStart);
  return { text: out, orig: n === orig.length ? orig : orig.subarray(0, n) };
}

/** Maps a half-open range in the stripped text to the original text. Requires start < end. */
function mapRange(st: Stripped, start: number, end: number): [number, number] {
  if (!st.orig) return [start, end];
  // End maps to just after the last KEPT character, so a token never ends with a trailing soft hyphen.
  return [st.orig[start], st.orig[end - 1] + 1];
}

// ---------------------------------------------------------------------------------------------
// Sentence segmentation
// ---------------------------------------------------------------------------------------------

interface Range { start: number; end: number }

function trimRange(s: string, start: number, end: number): Range {
  while (start < end && INVISIBLE_CHAR.test(s[start])) start++;
  while (end > start && INVISIBLE_CHAR.test(s[end - 1])) end--;
  return { start, end };
}

/** Returns the abbreviation candidate (without its period) that ends the trimmed text, or null. */
function trailingAbbreviation(trimmedText: string): string | null {
  const tail = trimmedText.length > TAIL_WINDOW ? trimmedText.slice(-TAIL_WINDOW) : trimmedText;
  const m = TRAILING_ABBREVIATION.exec(tail);
  return m ? m[1] : null;
}

function isTitleAbbreviation(abbr: string): boolean {
  if (TITLE_ABBREVIATIONS.has(abbr)) return true;
  // ALL CAPS headings: "MR. DARCY" -> "Mr"
  if (abbr.length > 1 && abbr === abbr.toUpperCase()) {
    return TITLE_ABBREVIATIONS.has(abbr[0] + abbr.slice(1).toLowerCase());
  }
  return false;
}

/**
 * Is a trailing single capital letter an initial ("J. K. Rowling")? Every capital letter is, except
 * the pronoun "I", which only counts when it follows another initial or a title ("J. I. Packer").
 */
function isInitial(abbr: string, trimmedText: string): boolean {
  if (!SINGLE_UPPER.test(abbr)) return false;
  if (abbr !== 'I') return true;
  const before = trimmedText.slice(0, -2).trimEnd(); // drop "I."
  const prev = trailingAbbreviation(before);
  return prev !== null && (isTitleAbbreviation(prev) || (SINGLE_UPPER.test(prev) && prev !== 'I'));
}

/**
 * Decides whether a closing quote at the start of the next segment belongs to the sentence before it
 * (merge) or opens a new quotation (keep the split). `i` is the index of the quote character.
 */
function closerBelongsToPrevious(s: string, i: number, cur: Range): boolean {
  const c = s[i];
  if (UNAMBIGUOUS_CLOSERS.has(c)) return true;
  if (!AMBIGUOUS_CLOSERS.has(c)) return false;
  const after = s.slice(i + 1, i + 3);
  // A standalone quote (followed by space, punctuation or end of text) is a closer.
  if (!STARTS_ALNUM.test(after)) return true;
  // ’ directly before a letter is an apostrophe ("’tis") or an opening single quote, never a closer.
  if (c === '’') return false;
  // " or ' directly before a letter: it closes the previous sentence only if that sentence has an
  // unmatched quote of the same kind. Apostrophes between letters (don't) are not counted.
  let count = 0;
  for (let k = cur.start; k < cur.end; k++) {
    if (s[k] !== c) continue;
    if (c === "'" && k > cur.start && k + 1 < cur.end && /\p{L}/u.test(s[k - 1]) && /\p{L}/u.test(s[k + 1])) continue;
    count++;
  }
  return count % 2 === 1;
}

/** True when the ICU boundary between `cur` and `next` is spurious and the two should be one sentence. */
function shouldMerge(s: string, cur: Range, next: Range): boolean {
  const curTrim = trimRange(s, cur.start, cur.end);
  if (curTrim.start === curTrim.end) return true; // never emit an empty sentence
  const nextTrim = trimRange(s, next.start, next.end);
  if (nextTrim.start === nextTrim.end) return true; // trailing whitespace: absorb, trimming removes it

  const nextHead = s.slice(nextTrim.start, nextTrim.start + 2); // 2 code units so astral letters match
  // 1. A sentence does not start with a lowercase letter: "...!" | "he said."  "whispered..." | "and"
  if (STARTS_LOWER.test(nextHead)) return true;
  // 2. Closing quote/bracket left at the start of the next segment: 'He said. ' | '” Then.'
  if (closerBelongsToPrevious(s, nextTrim.start, curTrim)) return true;

  // 3. Abbreviations and initials before the boundary.
  const curText = s.slice(Math.max(curTrim.start, curTrim.end - TAIL_WINDOW), curTrim.end);
  const abbr = trailingAbbreviation(curText);
  if (abbr === null) return false;
  if (isTitleAbbreviation(abbr)) return true;
  if (isInitial(abbr, curText)) return true;
  const lower = abbr.toLowerCase();
  if (ALWAYS_MERGE_ABBREVIATIONS.has(lower)) return true;
  // "5 p.m. on Tuesday" merges; "5 p.m. He left." and "the U.S. Then he left." stay split.
  if (CONDITIONAL_ABBREVIATIONS.has(lower) && !STARTS_UPPER.test(nextHead)) return true;
  return false;
}

/**
 * ICU occasionally glues an opening quote/bracket to the end of the previous sentence when there is
 * no space between them ("end.”“Start" -> 'end.”“' | 'Start'). Move such openers to the next segment.
 */
function moveTrailingOpeners(s: string, raw: Range[]): void {
  for (let i = 0; i + 1 < raw.length; i++) {
    const cur = raw[i];
    let end = trimRange(s, cur.start, cur.end).end;
    while (end - 1 > cur.start && UNAMBIGUOUS_OPENERS.has(s[end - 1])) end--;
    if (end !== cur.end && end > cur.start) {
      // Only move if what we strip is openers plus whitespace (trimRange only removed whitespace).
      cur.end = end;
      raw[i + 1].start = end;
    }
  }
}

function segmentSentenceRanges(sentenceSegmenter: Intl.Segmenter, s: string): Range[] {
  if (s.length === 0) return [];
  const raw: Range[] = [];
  for (const seg of sentenceSegmenter.segment(s)) {
    raw.push({ start: seg.index, end: seg.index + seg.segment.length });
  }
  if (raw.length === 0) return [];
  moveTrailingOpeners(s, raw);

  const merged: Range[] = [];
  let cur: Range = { start: raw[0].start, end: raw[0].end };
  for (let i = 1; i < raw.length; i++) {
    const next = raw[i];
    if (shouldMerge(s, cur, next)) cur.end = next.end;
    else { merged.push(cur); cur = { start: next.start, end: next.end }; }
  }
  merged.push(cur);

  const out: Range[] = [];
  for (const r of merged) {
    const t = trimRange(s, r.start, r.end);
    if (t.end > t.start) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------------------------

/** Token in stripped-text coordinates, before mapping back to the original string. */
interface RawToken { start: number; end: number; kind: TokenKind }

/**
 * Tokenises the whole of `s` in one ICU pass (one call per paragraph is ~2x faster than one per
 * sentence). Whitespace and invisible characters are skipped, punctuation runs collapse, and
 * hyphenated compounds are joined.
 */
function tokenizeText(wordSegmenter: Intl.Segmenter, s: string): RawToken[] {
  const out: RawToken[] = [];
  for (const seg of wordSegmenter.segment(s)) {
    const text = seg.segment;
    const start = seg.index;
    const end = start + text.length;
    if (seg.isWordLike) {
      out.push({ start, end, kind: NUMBER_TOKEN.test(text) ? 'number' : 'word' });
      continue;
    }
    if (ONLY_INVISIBLE.test(text)) continue; // spaces are not tokens (see module doc)
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev && prev.kind === 'punct' && prev.end === start) prev.end = end; // collapse "?!", "..."
    else out.push({ start, end, kind: 'punct' });
  }
  joinHyphenatedWords(s, out);
  return out;
}

/** In place: word + single hyphen + word (no spaces) -> one token. Chains ("state-of-the-art") join too. */
function joinHyphenatedWords(s: string, tokens: RawToken[]): void {
  let w = 0; // write index
  for (let r = 0; r < tokens.length; r++) {
    const t = tokens[r];
    if (
      w >= 2 &&
      t.kind !== 'punct' &&
      tokens[w - 1].kind === 'punct' &&
      tokens[w - 1].end - tokens[w - 1].start === 1 &&
      JOINING_HYPHENS.has(s[tokens[w - 1].start]) &&
      tokens[w - 2].kind !== 'punct' &&
      tokens[w - 2].end === tokens[w - 1].start &&
      tokens[w - 1].end === t.start
    ) {
      const head = tokens[w - 2];
      head.end = t.end;
      if (head.kind === 'number' && t.kind !== 'number') head.kind = 'word';
      w -= 1; // drop the hyphen token; `head` stays at w-1
      continue;
    }
    tokens[w++] = t;
  }
  tokens.length = w;
}

function toTokens(st: Stripped, original: string, raw: RawToken[]): Token[] {
  const out: Token[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const [start, end] = mapRange(st, raw[i].start, raw[i].end);
    out[i] = { start, end, text: original.slice(start, end), kind: raw[i].kind };
  }
  return out;
}

/**
 * Hands the paragraph's tokens out to its sentences by offset. `raw` and `ranges` are both sorted.
 * Sentence boundaries and ICU word boundaries agree in practice; the one exception is a collapsed
 * punctuation run spanning a boundary we moved ("end.\u201D\u201CStart" -> '.\u201D' | '\u201C'),
 * which is clipped at the boundary so every token lies inside its sentence.
 */
function distributeTokens(s: string, raw: RawToken[], ranges: Range[]): RawToken[][] {
  const out: RawToken[][] = new Array(ranges.length);
  let j = 0;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const toks: RawToken[] = [];
    while (j < raw.length && raw[j].start < r.end) {
      const t = raw[j];
      if (t.end <= r.start) { j++; continue; } // entirely in the gap before this sentence
      if (t.start >= r.start && t.end <= r.end) {
        toks.push(t);
        j++;
        continue;
      }
      const start = Math.max(t.start, r.start);
      const end = Math.min(t.end, r.end);
      if (end > start) {
        const kind: TokenKind = t.kind === 'punct' ? 'punct' : NUMBER_TOKEN.test(s.slice(start, end)) ? 'number' : 'word';
        toks.push({ start, end, kind });
      }
      if (t.end <= r.end) j++; else break; // the rest of a straddling token belongs to the next sentence
    }
    out[i] = toks;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------------------------

export function createSegmenter(): Segmenter {
  const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

  return {
    segmentParagraph(text: string): Sentence[] {
      const st = stripSoftHyphens(text);
      const ranges = segmentSentenceRanges(sentenceSegmenter, st.text);
      if (ranges.length === 0) return [];
      const perSentence = distributeTokens(st.text, tokenizeText(wordSegmenter, st.text), ranges);
      const sentences: Sentence[] = new Array(ranges.length);
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        const [start, end] = mapRange(st, r.start, r.end);
        sentences[i] = { index: i, start, end, tokens: toTokens(st, text, perSentence[i]) };
      }
      return sentences;
    },

    tokenize(text: string): Token[] {
      if (text.length === 0) return [];
      const st = stripSoftHyphens(text);
      return toTokens(st, text, tokenizeText(wordSegmenter, st.text));
    },
  };
}
