import type { CefrLevel, Paragraph, Sentence, Token } from '@core/model';
import { levelIndex, CEFR_LEVELS } from '@core/model';
import type { Dictionary, DictEntry, LookupResult } from '@core/dict/types';
import type { PhraseHit } from '@core/ai/hints';
import { MAX_PHRASE_WORDS } from '@core/dict/dictionary';
import { nameKey } from '@core/dict/names';

/**
 * Vocabulary analysis of segmented text: which words are above the learner's level, which spans are
 * dictionary phrases, and which capitalised tokens are names (never explained).
 */

export interface WordInfo {
  /** vocabulary key: the dictionary lemma, else the folded lower-cased token */
  lemma: string;
  level: CefrLevel | null;
  levelSource: 'cefrj' | 'oct' | 'est' | null;
  isName: boolean;
  inDict: boolean;
  entry: DictEntry | null;
}

/**
 * A dictionary phrase found in a token list. `start`/`end` are token indices with `end` EXCLUSIVE (like
 * Token.start/end): the phrase's last word is `tokens[end - 1]`. The segmenter emits no whitespace tokens, so
 * `tokens[end]` is the word or punctuation AFTER the phrase ("who" in "old man who") and must not be included.
 */
export interface PhraseSpan { start: number; end: number; words: number; result: LookupResult }

export interface SentenceAnnotation {
  /** one entry per token; null for space/punct/number tokens */
  infos: (WordInfo | null)[];
  /**
   * dictionary phrases, with `level` = the level used (see phraseLevel; the chapter job's level when it
   * confirmed the phrase), `confirmed` = the chapter job found the same phrase here, `above` = that level is
   * above the learner's
   */
  phrases: (PhraseSpan & { above: boolean; level: CefrLevel; confirmed: boolean })[];
  /**
   * the chapter job's phrases in this sentence (PhraseHit, `end` INCLUSIVE) that are not already a dictionary
   * phrase over the same tokens, with `above` = the model's level is above the learner's
   */
  aiPhrases: (PhraseHit & { above: boolean })[];
  /** token indices above the learner's level (names excluded; words inside an above-level phrase are left to the phrase) */
  hardTokens: number[];
}

export function analyzeToken(token: Token, sentenceFirst: boolean, dict: Dictionary, names: Set<string>): WordInfo {
  const text = token.text;
  const r = token.kind === 'word' ? dict.lookup(text) : null;
  const lemma = r ? r.lemma : dict.lemmaOf(text);
  // A name must be capitalised in the text ("Grace" the person, not "grace"). Besides the book's name list,
  // a capitalised word mid-sentence that the dictionary has never heard of is treated as a name on the spot.
  let isName = false;
  if (token.kind === 'word' && /^\p{Lu}/u.test(text)) {
    const key = nameKey(text);
    isName = (key !== null && names.has(key)) || (!sentenceFirst && r === null);
  }
  return {
    lemma,
    level: r ? r.entry.level : null,
    levelSource: r ? r.entry.levelSource : null,
    isName,
    inDict: r !== null,
    entry: r ? r.entry : null,
  };
}

/**
 * Strictly above the learner's level. Unknown level and names are never "above". An estimated C2 with no
 * corpus frequency means ECDICT has the word but nothing else does — a rare word worth explaining only if the
 * dictionary actually has a gloss for it, otherwise it is most likely junk (an abbreviation, a misspelling).
 */
export function isAboveLevel(info: WordInfo, learner: CefrLevel): boolean {
  if (info.isName || info.level === null) return false;
  if (levelIndex(info.level) <= levelIndex(learner)) return false;
  if (info.levelSource === 'est' && info.level === 'C2' && info.entry !== null && info.entry.frq === 0) {
    return info.inDict && info.entry.zh.trim().length > 0;
  }
  return true;
}

/**
 * Longest-match, non-overlapping scan for dictionary phrases ("look forward to", "in spite of") over runs of
 * word tokens separated only by spaces. Windows of MAX_PHRASE_WORDS down to 2 are tried at each word; a window
 * matches only when its n words spell an n-word phrase headword (see Dictionary.lookupPhrase), so a span never
 * carries a word beyond the phrase.
 */
export function findPhrases(tokens: Token[], dict: Dictionary): PhraseSpan[] {
  const out: PhraseSpan[] = [];
  const wordIdx: number[] = [];
  for (let i = 0; i < tokens.length; i++) if (tokens[i].kind === 'word') wordIdx.push(i);
  if (wordIdx.length < 2) return out;

  // run[k] = how many consecutive word tokens starting at wordIdx[k] are joined by spaces only
  const run = new Array<number>(wordIdx.length).fill(1);
  for (let k = wordIdx.length - 2; k >= 0; k--) {
    let onlySpaces = true;
    for (let i = wordIdx[k] + 1; i < wordIdx[k + 1]; i++) if (tokens[i].kind !== 'space') { onlySpaces = false; break; }
    run[k] = onlySpaces ? run[k + 1] + 1 : 1;
  }

  let k = 0;
  while (k < wordIdx.length) {
    let matched = 0;
    for (let n = Math.min(MAX_PHRASE_WORDS, run[k]); n >= 2; n--) {
      const words = wordIdx.slice(k, k + n).map((i) => tokens[i].text);
      const result = dict.lookupPhrase(words);
      if (result) {
        out.push({ start: wordIdx[k], end: wordIdx[k + n - 1] + 1, words: n, result });
        matched = n;
        break;
      }
    }
    k += matched || 1;
  }
  return out;
}

/**
 * The level a dictionary phrase is judged at. A level from a CEFR list (cefrj/oct) is used as is. An estimated
 * one ('est': C1 by default for any phrase without a Collins rating) is not trusted: it is replaced by the
 * level of the phrase's hardest word, at least B1 (a listed multi-word headword is an idiom or a fixed
 * expression, and an idiom-marked gloss says so outright), and never above the estimate ("look forward to"
 * stays B1, "lip service" becomes B1, "in spite of" B2 from "spite").
 */
export function phraseLevel(result: LookupResult, dict: Dictionary): CefrLevel {
  const e = result.entry;
  if (e.levelSource !== 'est') return e.level;
  let lvl = levelIndex('B1');
  for (const w of result.lemma.split(' ')) {
    const r = dict.lookup(w);
    if (r) lvl = Math.max(lvl, levelIndex(r.entry.level));
  }
  return CEFR_LEVELS[Math.min(lvl, levelIndex(e.level))];
}

/**
 * Per-token analysis of one sentence. `para` is part of the addressing contract (sentence offsets index into
 * `para.text`); the tokens themselves carry the text the analysis needs.
 */
export function annotateSentence(
  para: Paragraph,
  s: Sentence,
  dict: Dictionary,
  names: Set<string>,
  learner: CefrLevel,
  /** the chapter job's phrases of THIS sentence (hintsPhrases(bookId, chapter)[sentenceKey]), when available */
  hits: readonly PhraseHit[] = [],
): SentenceAnnotation {
  void para;
  const tokens = s.tokens;
  const firstWord = tokens.findIndex((t) => t.kind === 'word');
  const infos = tokens.map((t, i) => (t.kind === 'word' ? analyzeToken(t, i === firstWord, dict, names) : null));
  const above = (l: CefrLevel): boolean => levelIndex(l) > levelIndex(learner);
  const overlaps = (h: PhraseHit, start: number, endExcl: number): boolean => h.start < endExcl && h.end >= start;
  const phrases = findPhrases(tokens, dict).map((p) => {
    // confirmed: the chapter job found this phrase here (same tokens, or the same lemma over overlapping tokens)
    const hit = hits.find((h) => (h.start === p.start && h.end === p.end - 1) || (h.lemma === p.result.lemma && overlaps(h, p.start, p.end)));
    const level = hit ? hit.level : phraseLevel(p.result, dict);
    return { ...p, level, confirmed: hit !== undefined, above: above(level) };
  });
  const aiPhrases = hits
    .filter((h) => !phrases.some((p) => h.start === p.start && h.end === p.end - 1))
    .map((h) => ({ ...h, above: above(h.level) }));

  const coveredByHardPhrase = new Set<number>();
  for (const p of phrases) if (p.above) for (let i = p.start; i < p.end; i++) coveredByHardPhrase.add(i);
  for (const h of aiPhrases) if (h.above) for (let i = h.start; i <= h.end; i++) coveredByHardPhrase.add(i);

  const hardTokens: number[] = [];
  infos.forEach((info, i) => {
    if (info && !coveredByHardPhrase.has(i) && isAboveLevel(info, learner)) hardTokens.push(i);
  });
  return { infos, phrases, aiPhrases, hardTokens };
}
