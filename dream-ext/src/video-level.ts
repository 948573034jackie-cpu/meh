/**
 * The vocabulary level of a whole video (or any text), with no AI: every word gets the dictionary's CEFR level,
 * and the video's level is the lowest level whose words cover about 95% of everything said. Names, numbers and
 * punctuation do not count. A word the dictionary has no level for counts as a common word, unless the word
 * table (Zipf) says it is rare. "Hard for you": the share of words above the learner's level that they do not know.
 */
import type { Book, CefrLevel, Token } from '@core/model';
import { CEFR_LEVELS, levelIndex } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import { analyzeToken } from '@core/vocab/analysis';
import { createSegmenter } from '@core/segment';

export type Coverage = Record<CefrLevel, number>;

export interface VideoLevel {
  level: CefrLevel;
  /** per level: the share (0..1) of counted words at this level or below */
  coverage: Coverage;
  /** how many words were counted */
  words: number;
  /** the share (0..1) of counted words that are above the learner's level and not known (only with opts.learner) */
  hardForYou?: number;
}

export interface VideoLevelOptions {
  /** the share of words the level must cover (default 0.95) */
  target?: number;
  /** fewer counted words than this: no level (null) */
  minWords?: number;
  /** how common a word is (Zipf: 7 = "the", 3 = rare); null = not in the table */
  zipf?: ((word: string) => number | null) | null;
  /** the learner's level ("B2", "lower B2", ...), for hardForYou */
  learner?: string;
  /** the learner's known words (vocabulary keys = dictionary lemmas) */
  known?: ReadonlySet<string> | ((lemma: string) => boolean);
}

/** what can be measured: a book (a video book's .book), sentences ({text}) or plain strings, or ready tokens */
export type LevelInput = Pick<Book, 'chapters'> | { book: Pick<Book, 'chapters'> } | ReadonlyArray<string | { text: string } | Token[]>;

/** this common or more, a word is easy whatever level the dictionary gives it (same number as level-stops COMMON_ZIPF) */
const COMMON_ZIPF = 4.8;
/** below this, a word without a dictionary level is a rare word */
const RARE_ZIPF = 3;

/** the CEFR level inside a label: "about lower B2 for reading" -> B2; null = none */
export function cefrOf(label: string | null | undefined): CefrLevel | null {
  const m = /\b([ABC][12])\b/i.exec(String(label ?? ''));
  return m ? (m[1].toUpperCase() as CefrLevel) : null;
}

function sentencesOf(input: LevelInput): Token[][] {
  const out: Token[][] = [];
  if (Array.isArray(input)) {
    let seg: ReturnType<typeof createSegmenter> | null = null;
    for (const x of input as ReadonlyArray<string | { text: string } | Token[]>) {
      if (Array.isArray(x)) { out.push(x); continue; }
      const text = typeof x === 'string' ? x : x && typeof x.text === 'string' ? x.text : '';
      if (!text.trim()) continue;
      seg ??= createSegmenter();
      out.push(seg.tokenize(text));
    }
    return out;
  }
  const book = 'book' in (input as object) ? (input as { book: Pick<Book, 'chapters'> }).book : (input as Pick<Book, 'chapters'>);
  for (const c of book.chapters ?? []) for (const p of c.paragraphs ?? []) for (const s of p.sentences ?? []) out.push(s.tokens);
  return out;
}

/** The level of one word token as it counts for a video; null = it does not count (a name, junk). */
export function tokenLevel(token: Token, sentenceFirst: boolean, dict: Dictionary, names: Set<string>, zipf?: ((w: string) => number | null) | null): { level: CefrLevel; lemma: string } | null {
  if (token.kind !== 'word') return null;
  if (!/\p{L}/u.test(token.text)) return null;
  const info = analyzeToken(token, sentenceFirst, dict, names);
  if (info.isName) return null;
  const z = zipf ? zipf(token.text) : null;
  let level = info.level;
  // an estimated C2 that no corpus knows and the dictionary cannot explain: most likely junk (see isAboveLevel)
  if (level === 'C2' && info.levelSource === 'est' && info.entry && info.entry.frq === 0 && !info.entry.zh.trim()) level = null;
  if (level === null) {
    if (!zipf) return { level: 'A2', lemma: info.lemma };
    if (z === null) return /['’]/.test(token.text) ? { level: 'A2', lemma: info.lemma } : null; // nobody knows it: a name or a caption mistake
    return { level: z < RARE_ZIPF ? 'C1' : 'A2', lemma: info.lemma };
  }
  // very common words the lists put high ("found", "themes") are not hard to hear and understand
  if (z !== null && z >= COMMON_ZIPF && levelIndex(level) > levelIndex('B1')) level = 'B1';
  return { level, lemma: info.lemma };
}

/** The video's vocabulary level; null when there are too few words to tell. */
export function videoLevel(input: LevelInput, dict: Dictionary, names: Set<string> = new Set(), opts: VideoLevelOptions = {}): VideoLevel | null {
  const target = opts.target ?? 0.95;
  const counts = CEFR_LEVELS.map(() => 0);
  const learner = cefrOf(opts.learner);
  const known = opts.known;
  const isKnown = (lemma: string): boolean => (!known ? false : typeof known === 'function' ? known(lemma) : known.has(lemma));
  let total = 0, hard = 0;
  for (const tokens of sentencesOf(input)) {
    const first = tokens.findIndex((t) => t.kind === 'word');
    tokens.forEach((t, i) => {
      const r = tokenLevel(t, i === first, dict, names, opts.zipf);
      if (!r) return;
      counts[levelIndex(r.level)]++;
      total++;
      if (learner && levelIndex(r.level) > levelIndex(learner) && !isKnown(r.lemma)) hard++;
    });
  }
  if (total < (opts.minWords ?? 20)) return null;
  const coverage = {} as Coverage;
  let sum = 0;
  let level: CefrLevel | null = null;
  CEFR_LEVELS.forEach((l, i) => {
    sum += counts[i];
    coverage[l] = Math.round((sum / total) * 1000) / 1000;
    if (!level && sum / total >= target - 1e-9) level = l;
  });
  return { level: level ?? 'C2', coverage, words: total, ...(learner ? { hardForYou: Math.round((hard / total) * 1000) / 1000 } : {}) };
}

/**
 * The level of video to look for: the learner's own level ("about lower B2 for reading" -> B2), or one step up
 * for "a little challenge". Unknown labels give B1.
 */
export function suggestLevelFor(learnerLevel: string | null | undefined, challenge = false): CefrLevel {
  const base = cefrOf(learnerLevel) ?? 'B1';
  return challenge ? CEFR_LEVELS[Math.min(CEFR_LEVELS.length - 1, levelIndex(base) + 1)] : base;
}
