import type { Book, Paragraph, Token } from '@core/model';
import type { Dictionary } from './types';

/**
 * Proper-noun detection for a whole book.
 *
 * Names are never auto-explained in listening mode, so the goal is to catch the people and places of a
 * novel ("Darcy", "Elizabeth", "Netherfield") without ever swallowing ordinary words that merely start a
 * sentence ("The", "He", "Yes"). Heuristics, in order of strength:
 *
 *  1. A Title-case word directly after a title ("Mr. Darcy", "Lady Catherine", "St. James") is a name.
 *  2. A Title-case word seen at least twice where capitalisation is *not* conventional — i.e. not at the
 *     start of a sentence, nor after an opening quote, colon or sentence-final punctuation the segmenter
 *     left inside a sentence, nor inside a heading (headings are often Title Case throughout) — is a name.
 *  3. A Title-case word seen once in such a position is a name when the dictionary does not know it at all,
 *     or only knows it as an obscure term with no corpus frequency, no BNC rank and no exam tags (ECDICT
 *     glosses 'darcy' as a permeability unit and 'bennet' as a plant).
 *
 * Guards: ALL-CAPS tokens ("CHAPTER", "LONDON") are not counted — they only become names through Title-case
 * occurrences elsewhere; a word used in lower case more often than in Title-case mid-sentence is a common
 * word, not a name ("will"/"Will", "the"); 'I' and its contractions, single letters and a short stop list of
 * function words are excluded outright. Returns lower-cased, possessive-stripped, unique, sorted names.
 */

/** Titles that may be abbreviated with a period, which the segmenter usually emits as its own token. */
const ABBREV_TITLES: ReadonlySet<string> = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'st', 'capt', 'col', 'gen', 'lt', 'sgt', 'mme', 'mlle', 'hon', 'messrs',
]);
/** Full-word titles; these must be directly adjacent to the name (no period in between). */
const WORD_TITLES: ReadonlySet<string> = new Set([
  'miss', 'mister', 'master', 'madam', 'madame', 'mademoiselle', 'monsieur', 'sir', 'dame', 'lady', 'lord',
  'king', 'queen', 'prince', 'princess', 'duke', 'duchess', 'count', 'countess', 'earl', 'baron', 'baroness',
  'captain', 'colonel', 'general', 'lieutenant', 'sergeant', 'major', 'admiral', 'bishop', 'saint',
  'uncle', 'aunt', 'cousin', 'brother', 'sister', 'father', 'mother',
]);

/** Function words that are capitalised for structural reasons often enough to slip past the counters. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'but', 'or', 'nor', 'so', 'yet', 'for', 'he', 'she', 'it', 'they', 'we', 'you', 'me',
  'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'there', 'here', 'then', 'than', 'when', 'where', 'why', 'how', 'what', 'who', 'whom', 'which', 'if', 'as',
  'at', 'by', 'in', 'on', 'of', 'to', 'up', 'out', 'off', 'no', 'not', 'yes', 'oh', 'ah', 'well', 'now', 'one',
  'all', 'any', 'some', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'such', 'only', 'own', 'same',
  'too', 'very', 'can', 'will', 'just', 'let', 'also', 'after', 'before', 'while', 'because', 'though',
  'although', 'until', 'since', 'with', 'from', 'into', 'about', 'again', 'once', 'never', 'always', 'perhaps',
]);

/** Punctuation after which a capital letter is conventional even mid-sentence (quotes, colon, sentence-final). */
const OPENER_RE = /["“”‘’'„‚«»‹›:.!?…]/;

const HEADING_KINDS: ReadonlySet<Paragraph['kind']> = new Set(['h1', 'h2', 'h3', 'caption']);

interface Stat { cap: number; lower: number; titled: boolean }

/** Canonical key for a word token: lower-cased, curly apostrophes straightened, possessive/period stripped. */
export function nameKey(text: string): string | null {
  let t = text.replace(/[‘’ʼ]/g, "'").toLowerCase().replace(/\.$/, '');
  if (t.endsWith("'s")) t = t.slice(0, -2);
  else if (t.endsWith("'")) t = t.slice(0, -1);
  if (t.length < 2 || t === 'i' || t.startsWith("i'")) return null;
  if (!/^\p{L}[\p{L}'-]*$/u.test(t)) return null;
  return t;
}

const startsUpper = (s: string): boolean => /^\p{Lu}/u.test(s);
const startsLower = (s: string): boolean => /^\p{Ll}/u.test(s);
/** "CHAPTER", "LONDON" — but not "I", "McDonald" or "I'm". */
const isAllCaps = (s: string): boolean => s.length >= 2 && s === s.toUpperCase() && /\p{Lu}/u.test(s);

/** True when a capital at tokens[i] is conventional: nothing but spaces/openers before it in the sentence. */
function conventionalCapital(tokens: Token[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.kind === 'space') continue;
    if (t.kind === 'punct') {
      if (OPENER_RE.test(t.text)) return true;
      continue; // commas, dashes, closing brackets: keep looking for a word
    }
    return false;
  }
  return true;
}

function hasWordBefore(tokens: Token[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) if (tokens[j].kind === 'word' || tokens[j].kind === 'number') return true;
  return false;
}

/** True when the word token before position i (scanning back from i - 1) is a title such as "Mr." or "Lady". */
function titleBefore(tokens: Token[], i: number): boolean {
  let sawPeriod = false;
  for (let j = i - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.kind === 'space') continue;
    if (t.kind === 'punct') {
      if (t.text === '.' && !sawPeriod) { sawPeriod = true; continue; }
      return false;
    }
    if (t.kind !== 'word') return false;
    const w = t.text.toLowerCase().replace(/\.$/, '');
    if (ABBREV_TITLES.has(w)) return true;
    return WORD_TITLES.has(w) && !sawPeriod;
  }
  return false;
}

export function detectNames(book: Pick<Book, 'chapters'>, dict: Dictionary): string[] {
  const stats = new Map<string, Stat>();
  const stat = (key: string): Stat => {
    let s = stats.get(key);
    if (!s) { s = { cap: 0, lower: 0, titled: false }; stats.set(key, s); }
    return s;
  };

  for (const chapter of book.chapters) {
    for (const para of chapter.paragraphs) {
      const heading = HEADING_KINDS.has(para.kind);
      let prevTokens: Token[] | null = null;
      for (const sentence of para.sentences) {
        const tokens = sentence.tokens;
        for (let i = 0; i < tokens.length; i++) {
          const tok = tokens[i];
          if (tok.kind !== 'word') continue;
          const key = nameKey(tok.text);
          if (!key) continue;
          if (startsLower(tok.text)) { stat(key).lower++; continue; }
          if (!startsUpper(tok.text) || isAllCaps(tok.text)) continue;
          const st = stat(key);
          // "Mr." at the end of the previous sentence: the segmenter should repair this, but be tolerant.
          const titled = titleBefore(tokens, i) || (!hasWordBefore(tokens, i) && prevTokens !== null && titleBefore(prevTokens, prevTokens.length));
          if (titled) st.titled = true;
          if (!heading && !conventionalCapital(tokens, i)) st.cap++;
        }
        prevTokens = tokens;
      }
    }
  }

  const names: string[] = [];
  for (const [key, st] of stats) {
    // honorifics are ordinary dictionary words, not names, however often they precede one
    if (STOP_WORDS.has(key) || ABBREV_TITLES.has(key) || WORD_TITLES.has(key)) continue;
    if (!st.titled && st.cap === 0) continue;      // only ever capitalised where capitals are conventional
    if (st.lower > st.cap) continue;                // a common word that is sometimes capitalised
    if (st.titled || st.cap >= 2) { names.push(key); continue; }
    const r = dict.lookup(key);
    if (!r) { names.push(key); continue; }
    const e = r.entry;
    if (e.frq === 0 && e.bnc === 0 && e.tags.length === 0) names.push(key);
  }
  return names.sort();
}
