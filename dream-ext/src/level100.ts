/**
 * ONE level from 0 (easiest) to 100 (hardest), for the learner and for every word, phrase and sentence
 * (I Know 3.8: it replaces A1–C2 and the three % sliders).
 *
 * A word's number comes from how common it is (the Zipf number of the built-in frequency table: 7.5 = the most common
 * words, 1 = very rare) and from its school level when the dictionary has one (CEFR-J / Octanove): the two are
 * averaged, so a word that frequency gets wrong is pulled back. Phrases and whole sentences get their number from the
 * one-time analysis of the video (the AI's level for them), with a floor for idioms and phrasal verbs, whose single
 * words are all easy.
 *
 * THE RULE: the tutor stops by itself only for what is HARDER than the learner's level (number > level), that is not
 * known, whose switch (Words / Phrases / Sentences) is on, and that was not explained in the last 1,000 words heard.
 * The learner's own list always wins over the table: a word they marked "known" never stops; a word they are still
 * learning stops whatever its number.
 */
import type { CefrLevel } from '@core/model';

/** the level a new learner starts with (the start of B2) */
export const DEFAULT_LEVEL = 50;
/** the middle of each school level on the 0–100 line */
export const CEFR_MID: Record<CefrLevel, number> = { A1: 8, A2: 24, B1: 40, B2: 56, C1: 73, C2: 90 } as Record<CefrLevel, number>;
/** phrases (idioms, slang, phrasal verbs) are never easier than this: their single words say nothing */
export const PHRASE_FLOOR = 50;
/** a sentence the analysis found hard, when it gave no level */
export const HARD_SENTENCE = 68;

export const clampLevel = (n: unknown): number => {
  const v = typeof n === 'number' ? n : parseFloat(String(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : DEFAULT_LEVEL;
};

/** 0–100 from the Zipf number alone: Zipf 7.5 -> 0, Zipf 1 -> 100 */
export const zipfDifficulty = (zipf: number): number => Math.max(0, Math.min(100, (100 * (7.5 - zipf)) / 6.5));

/**
 * How hard a word is, 0 (easiest) … 100 (hardest). `zipf` null = not in the frequency table (a rare word: 80 unless
 * the school level says otherwise); `cefr` '' / undefined = the dictionary has no school level for it.
 */
export function wordDifficulty(zipf: number | null | undefined, cefr?: CefrLevel | '' | null): number {
  const f = typeof zipf === 'number' ? zipfDifficulty(zipf) : null;
  const c = cefr && CEFR_MID[cefr] !== undefined ? CEFR_MID[cefr] : null;
  if (f !== null && c !== null) return Math.round((f + c) / 2);
  if (f !== null) return Math.round(f);
  if (c !== null) return c;
  return 80;
}

/** this common or more (Zipf), frequency alone decides: the dictionary's level for such a form is often for another meaning ("found", "known") */
export const TRUST_ZIPF = 4.8;
/**
 * A word AS MET in a text: the more common of its form and its dictionary word decides how common it is; a very common
 * form is easy whatever school level the dictionary gives it. null = no number (not in the dictionary and not in the
 * frequency table: a name, a typo, a caption mistake), so it can never be a reason to stop.
 */
export function wordNumber(zipfForm: number | null | undefined, zipfLemma: number | null | undefined, cefr?: CefrLevel | '' | null): number | null {
  const z = typeof zipfForm === 'number' && typeof zipfLemma === 'number' ? Math.max(zipfForm, zipfLemma) : typeof zipfForm === 'number' ? zipfForm : typeof zipfLemma === 'number' ? zipfLemma : null;
  if (z === null && !(cefr && CEFR_MID[cefr] !== undefined)) return null;
  if (z !== null && z >= TRUST_ZIPF) return Math.round(zipfDifficulty(z));
  return wordDifficulty(z, cefr);
}

/** a phrase's number from the AI's (or the dictionary's) level for it */
export function phraseDifficulty(cefr?: CefrLevel | '' | null): number {
  return Math.max(PHRASE_FLOOR, cefr && CEFR_MID[cefr] !== undefined ? CEFR_MID[cefr] : 62);
}

/** a whole hard sentence's number from the AI's level for it (none given: HARD_SENTENCE) */
export function sentenceDifficulty(cefr?: CefrLevel | '' | null): number {
  return cefr && CEFR_MID[cefr] !== undefined ? Math.max(PHRASE_FLOOR, CEFR_MID[cefr]) : HARD_SENTENCE;
}

/**
 * Where a learner of each school level starts on the 0–100 line: near the START of the level's band, not its middle,
 * because a learner "at B2" still meets many B2 words they do not know (so those words, about 50–56, must be able to
 * stop). The learner moves the slider from there.
 */
export const CEFR_START: Record<CefrLevel, number> = { A1: 4, A2: 18, B1: 34, B2: 50, C1: 66, C2: 84 } as Record<CefrLevel, number>;
/** the old A1–C2 setting as a number (once, when the app is updated) */
export const cefrToLevel = (c: string | undefined | null): number => CEFR_START[(c ?? '').toUpperCase() as CefrLevel] ?? DEFAULT_LEVEL;

/** the nearest school level of a number (only for texts that still need one: prompts, a video's label) */
export function levelToCefr(n: number): CefrLevel {
  let best: CefrLevel = 'B2' as CefrLevel, d = Infinity;
  for (const [k, v] of Object.entries(CEFR_MID) as [CefrLevel, number][]) { const x = Math.abs(v - n); if (x < d) { d = x; best = k; } }
  return best;
}

/** THE RULE's first check: harder than my level */
export const harderThan = (difficulty: number, myLevel: number): boolean => difficulty > myLevel;

/** how well a text of this difficulty fits the learner: 100 = just right (a little above the level), lower = too easy or too hard */
export function fitScore(difficulty: number, myLevel: number): number {
  const d = difficulty - (myLevel + 5);
  return Math.max(0, Math.round(100 - Math.abs(d) * (d > 0 ? 2.2 : 1.4)));
}

/** the learner's level: the slider's number; before it was ever set, the old A1–C2 level as a number */
export const myLevelOf = (extras: { myLevel?: number } | null | undefined, cefr?: string | null): number =>
  typeof extras?.myLevel === 'number' ? clampLevel(extras.myLevel) : cefrToLevel(cefr);

// ---- I Know 3.9: the learner chooses a school level again (A1 … C2) and how much to explain (0–100 %) ----
const CEFR_LIST = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
/** the dictionary (or the analysis) gave this a school level BELOW the learner's: never explained by itself */
export function belowLevel(cefr: string | null | undefined, mine: string | null | undefined): boolean {
  const a = CEFR_LIST.indexOf((cefr ?? '').toUpperCase()), b = CEFR_LIST.indexOf((mine ?? '').toUpperCase());
  return a >= 0 && b >= 0 && a < b;
}
/** how much of what is at the learner's level or above is explained, until the learner moves the slider: all of it
 *  (as before 3.9); 50 % = only the harder half */
export const DEFAULT_EXPLAIN_PCT = 100;
export const clampPct = (n: unknown): number => {
  const v = typeof n === 'number' ? n : parseFloat(String(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : DEFAULT_EXPLAIN_PCT;
};
/** how many of `n` things the share keeps: 0 % = none, anything above 0 keeps at least one, 100 % = all */
export const shareOf = (n: number, pct: number): number => (pct <= 0 || n <= 0 ? 0 : Math.min(n, Math.max(1, Math.ceil((n * clampPct(pct)) / 100 - 1e-9))));
