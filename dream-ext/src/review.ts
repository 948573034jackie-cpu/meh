/**
 * The daily review of the whole word list: once a day, by itself, plain counting, NO AI.
 *  1. A word explained `knownAfter` times (7) is known from now on (a catch-up: normally this happens at once).
 *  2. A word that became known through explanations and was not met for a long time (90 days) goes back to "still
 *     learning": the tutor may stop for it once more (a few a day at most).
 *  3. What the words say about the level: the number (0-100) that best divides the words the learner knows from the
 *     ones they are still learning. It is only SAID (the learner moves the slider themself: their level never moves
 *     by itself).
 * Every change it makes is saved like any other and goes to the online copy at once.
 */
import type { WordStatus } from '@shared/settings';

export interface ReviewEntry { lemma: string; timesExplained: number; lastSeenAt?: string }
export interface ReviewInput {
  words: Record<string, WordStatus>;
  entries: Record<string, ReviewEntry>;
  /** explained this many times = known (0 = never by itself) */
  knownAfter: number;
  now: Date;
  /** the day a word got the status it has now ("I know" said today = met today), when the list knows it */
  statusAt?: (lemma: string) => string | undefined;
  /** a word's number, 0 (easiest) … 100 (hardest); null = it has none */
  numberOf: (lemma: string) => number | null;
  myLevel: number;
  /** not met for this many days: back to "still learning" */
  staleDays?: number;
  /** at most this many go back per day */
  maxBack?: number;
}
export interface ReviewResult {
  /** explained often enough: known from now on */
  nowKnown: string[];
  /** not met for a long time: still learning again */
  backToLearn: string[];
  /** the level the words suggest (null = too few words to say) */
  suggested: number | null;
  known: number;
  learning: number;
}

export const REVIEW_KEY = 'drReview';
/** the day of a date, in the learner's own time ("2026-11-12") */
export const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** the review runs once per day */
export const reviewDue = (last: string | undefined | null, now: Date): boolean => last !== dayKey(now);

/**
 * The number that best divides "known" (should be at or below it) from "still learning" (should be above it): the
 * level at which the fewest of the learner's own words are on the wrong side. Needs at least 12 words with a number
 * on each side to say anything; ties go to the number nearest the level now.
 */
export function suggestLevel(known: readonly number[], learning: readonly number[], myLevel: number): number | null {
  if (known.length < 12 || learning.length < 12) return null;
  // (weights: the two groups count the same, however many seed words one of them has)
  const wk = 1 / known.length, wl = 1 / learning.length;
  let best = myLevel, bestErr = Infinity;
  for (let L = 5; L <= 95; L++) {
    let err = 0;
    for (const n of known) if (n > L) err += wk;
    for (const n of learning) if (n <= L) err += wl;
    if (err < bestErr - 1e-9 || (Math.abs(err - bestErr) <= 1e-9 && Math.abs(L - myLevel) < Math.abs(best - myLevel))) { bestErr = err; best = L; }
  }
  return best;
}

export function dailyReview(i: ReviewInput): ReviewResult {
  const nowKnown: string[] = [], backToLearn: string[] = [];
  const staleMs = (i.staleDays ?? 90) * 86400_000;
  const stale: { lemma: string; at: number }[] = [];
  for (const [lemma, st] of Object.entries(i.words)) {
    if (lemma.startsWith('sentence: ')) continue;
    const e = i.entries[lemma];
    if (st === 'learning' && e && i.knownAfter > 0 && e.timesExplained >= i.knownAfter) nowKnown.push(lemma);
    // (back to learn: known through a FEW explanations and not met for long. A word explained often enough to be
    // known for good never goes back: the two rules must not undo each other day after day. "Met" is its last
    // explanation or the day it got its status, whichever is newer: an "I know" said at a stop counts.)
    if (st === 'known' && e && e.timesExplained > 0 && !(i.knownAfter > 0 && e.timesExplained >= i.knownAfter) && e.lastSeenAt) {
      const seen = Date.parse(e.lastSeenAt), set = Date.parse(i.statusAt?.(lemma) ?? '');
      const at = Math.max(Number.isFinite(seen) ? seen : 0, Number.isFinite(set) ? set : 0);
      if (at > 0 && i.now.getTime() - at > staleMs) stale.push({ lemma, at });
    }
  }
  stale.sort((a, b) => a.at - b.at);
  for (const s of stale.slice(0, i.maxBack ?? 10)) backToLearn.push(s.lemma);
  const kn: number[] = [], ln: number[] = [];
  let known = 0, learning = 0;
  const becomes = new Map<string, WordStatus>([...nowKnown.map((l) => [l, 'known'] as [string, WordStatus]), ...backToLearn.map((l) => [l, 'learning'] as [string, WordStatus])]);
  for (const [lemma, st0] of Object.entries(i.words)) {
    if (lemma.startsWith('sentence: ') || lemma.includes(' ')) continue;
    const st = becomes.get(lemma) ?? st0;
    if (st !== 'known' && st !== 'learning') continue;
    if (st === 'known') known++; else learning++;
    const n = i.numberOf(lemma);
    if (n === null) continue;
    (st === 'known' ? kn : ln).push(n);
  }
  return { nowKnown, backToLearn, suggested: suggestLevel(kn, ln, i.myLevel), known, learning };
}

/** the review in one calm line for the learner ('' = nothing worth saying) */
export function reviewText(r: ReviewResult, myLevel: number): string {
  const parts: string[] = [];
  if (r.nowKnown.length) parts.push(`${r.nowKnown.length} word${r.nowKnown.length === 1 ? '' : 's'} now known`);
  if (r.backToLearn.length) parts.push(`${r.backToLearn.length} not met for a long time: to review again`);
  if (r.suggested !== null && Math.abs(r.suggested - myLevel) >= 8) parts.push(`your words say your level is about ${r.suggested} (yours is ${myLevel}; move it in Settings if you like)`);
  return parts.length ? `Today's word review: ${parts.join(' · ')}.` : '';
}
