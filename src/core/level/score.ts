import type { CefrLevel } from '@core/model';
import { CEFR_LEVELS, levelIndex } from '@core/model';
import { BANDS } from './items';

/**
 * Scoring for the yes/no vocabulary test (spec section 3) and the daily model (section 5).
 *
 *  - f  = yes-rate on pseudowords (false-alarm rate)
 *  - h_b = yes-rate on the real words of band b; k_b = max(0, (h_b - f) / (1 - f))  (cfg correction)
 *  - k_b is shrunk toward a logistic curve in log(rank) fitted across bands, with Beta(1,1) pseudo-counts
 *    (two observations' worth), then made monotone non-increasing in rank
 *  - V = sum of k_b x band width (lemmas); families = V / 1.6
 */

export interface BandCounts {
  /** observations (may be fractional for the Beta model) */
  n: number;
  /** "yes" / "known" observations */
  yes: number;
}

export interface LevelResult {
  /** estimated lemmas known in the first 20,000, rounded to 250 */
  sizeLemmas: number;
  /** sizeLemmas / 1.6, rounded to 250 */
  sizeFamilies: number;
  /** CEFR level from the size (CEFR_LEMMA_FLOORS) */
  cefr: CefrLevel;
  /** levels of the 80% bootstrap interval's ends (always contains `cefr`) */
  cefrRange: [CefrLevel, CefrLevel];
  /** 80% bootstrap interval on the lemma count, rounded to 250 */
  sizeRange: [number, number];
  /** false when the false-alarm rate is above 0.3: "unreliable, retake" */
  reliable: boolean;
  perBand: { band: number; k: number; n: number }[];
  /** corrected knowledge of the CEFR-tagged items shown, per level (empty for the daily model) */
  levels: { level: CefrLevel; n: number; k: number }[];
  falseAlarmRate: number;
}

export const FAMILY_RATIO = 1.6;
/** Beta(1,1) pseudo-counts: the curve counts as two observations. */
export const PRIOR_WEIGHT = 2;
export const UNRELIABLE_FALSE_ALARM = 0.3;
/** mastery needed on CEFR-tagged items for the cross-check */
export const MASTERY = 0.8;
/** tagged items needed before the cross-check is allowed to demote */
export const MIN_CROSS_CHECK_ITEMS = 6;
export const ROUND_STEP = 250;

/**
 * Lower bound in lemmas for each level: Nation's word-family scale (A2 < 2,000 families, B1 2,000-3,500,
 * B2 3,500-5,000, C1 5,000-7,000, C2 > 7,000; A1 below 1,000) x 1.6 lemmas per family. Milton's X_Lex lemma
 * scale (B2 from 3,250 lemmas) is not used: the app's own CEFR-J/Octanove tags put the median B1 word at COCA
 * rank 3,900 and the median B2 word at 6,900, which matches Nation's bands (B1 = 3,200-5,600 lemmas,
 * B2 = 5,600-8,000) and not Milton's.
 */
export const CEFR_LEMMA_FLOORS: Record<CefrLevel, number> = {
  A1: 0, A2: 1000 * FAMILY_RATIO, B1: 2000 * FAMILY_RATIO, B2: 3500 * FAMILY_RATIO, C1: 5000 * FAMILY_RATIO, C2: 7000 * FAMILY_RATIO,
};

export function falseAlarmRate(pseudoYes: number, pseudoN: number): number {
  return pseudoN > 0 ? pseudoYes / pseudoN : 0;
}

/** cfg correction: max(0, (h - f) / (1 - f)). */
export function correctedRate(h: number, f: number): number {
  if (f >= 1) return 0;
  return Math.max(0, Math.min(1, (h - f) / (1 - f)));
}

export function roundTo(x: number, step = ROUND_STEP): number {
  return Math.round(x / step) * step;
}

export function familiesOf(lemmas: number): number {
  return lemmas / FAMILY_RATIO;
}

export function cefrForLemmas(lemmas: number): CefrLevel {
  let level: CefrLevel = 'A1';
  for (const l of CEFR_LEVELS) if (lemmas >= CEFR_LEMMA_FLOORS[l]) level = l;
  return level;
}

/* ------------------------------------------------------------------------------------------------
 * Per-band knowledge
 * ---------------------------------------------------------------------------------------------- */

/** Ranks at which a band's curve value is sampled: its mean over the band is the share of the band's lemmas known. */
const BAND_SAMPLES = 16;
const bandSamples = (b: number): number[] => {
  const { lo, hi } = BANDS[b];
  return Array.from({ length: BAND_SAMPLES }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / BAND_SAMPLES);
};

/** Mean of k(rank) over the ranks of band b. */
export function bandAverage(curve: (rank: number) => number, b: number): number {
  const xs = bandSamples(b);
  return xs.reduce((s, r) => s + curve(r), 0) / xs.length;
}

/** The (mu, s) grid the logistic fit searches, with each curve's mean over every band precomputed once. */
interface GridPoint { mu: number; s: number; avg: number[] }
let GRID: GridPoint[] | null = null;
const logistic = (mu: number, s: number) => (rank: number): number => 1 / (1 + Math.exp((Math.log(rank) - mu) / s));
function grid(): GridPoint[] {
  if (GRID) return GRID;
  const out: GridPoint[] = [];
  const muLo = Math.log(50); const muHi = Math.log(100000); const steps = 120;
  for (const s of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.55, 0.7, 0.9, 1.2, 1.6]) {
    for (let i = 0; i <= steps; i++) {
      const mu = muLo + ((muHi - muLo) * i) / steps;
      const c = logistic(mu, s);
      out.push({ mu, s, avg: BANDS.map((b) => bandAverage(c, b.index)) });
    }
  }
  GRID = out;
  return out;
}

/**
 * Fits k(rank) = 1 / (1 + exp((ln rank - mu) / s)) across bands by weighted least squares on a grid (the curve
 * is monotone decreasing in rank by construction), comparing each band's k with the curve's mean over the band.
 * Returns the fitted curve's mean per band; all zeros when there is nothing to fit.
 */
export function fitLogistic(points: { band: number; k: number; w: number }[]): number[] {
  const pts = points.filter((p) => p.w > 0);
  if (pts.length === 0) return BANDS.map(() => 0);
  let best: GridPoint | null = null; let bestErr = Infinity;
  for (const g of grid()) {
    let err = 1e-6 / g.s;                         // tiny preference for gentler curves so ties resolve smoothly
    for (const p of pts) { const d = p.k - g.avg[p.band]; err += p.w * d * d; }
    if (err < bestErr) { bestErr = err; best = g; }
  }
  return best!.avg.slice();
}

/** Pool-adjacent-violators: weighted isotonic regression, non-increasing. */
export function monotoneDecreasing(values: readonly number[], weights: readonly number[]): number[] {
  const blocks: { v: number; w: number; len: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    blocks.push({ v: values[i], w: Math.max(weights[i], 1e-9), len: 1 });
    while (blocks.length >= 2 && blocks[blocks.length - 2].v < blocks[blocks.length - 1].v) {
      const b = blocks.pop()!; const a = blocks.pop()!;
      const w = a.w + b.w;
      blocks.push({ v: (a.v * a.w + b.v * b.w) / w, w, len: a.len + b.len });
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.len; i++) out.push(b.v);
  return out;
}

/**
 * Corrected, shrunk, monotone knowledge estimate per band. `counts` has one entry per band (BANDS order);
 * bands with n = 0 take the fitted curve's value. `f` is the false-alarm rate to correct with (0 when the
 * counts are already corrected, as in the Beta model).
 */
export function bandKnowledge(counts: readonly BandCounts[], f: number): number[] {
  const raw = counts.map((c) => (c.n > 0 ? correctedRate(c.yes / c.n, f) : null));
  const curve = fitLogistic(raw.map((k, b) => ({ band: b, k: k ?? 0, w: k === null ? 0 : counts[b].n })));
  const shrunk = raw.map((k, b) => {
    const c = curve[b];
    const n = counts[b].n;
    return k === null ? c : (n * k + PRIOR_WEIGHT * c) / (n + PRIOR_WEIGHT);
  });
  return monotoneDecreasing(shrunk, counts.map((c) => c.n + PRIOR_WEIGHT)).map((k) => Math.max(0, Math.min(1, k)));
}

/** V = sum of k_b x band width. */
export function sizeFromKnowledge(k: readonly number[]): number {
  let v = 0;
  for (let b = 0; b < BANDS.length && b < k.length; b++) v += k[b] * BANDS[b].width;
  return v;
}

/* ------------------------------------------------------------------------------------------------
 * CEFR cross-check and result assembly
 * ---------------------------------------------------------------------------------------------- */

export type LevelCounts = Partial<Record<CefrLevel, BandCounts>>;

/**
 * The spec's CEFR cross-check (VLT-style mastery): award a level only if the learner knows, corrected for
 * guessing, at least 80% of the CEFR-tagged words of that level; demote while that fails. Exported for callers
 * that want it, but NOT applied by the session: the test samples words by frequency band, so the tagged words
 * it shows are not representative of their level (CEFR-J B1 words span COCA ranks 2.4k-6.9k interquartile, and
 * stage 2 of a 15k-lemma learner shows the few A2 words ranked above 14k), and on the real dictionary the check
 * demotes simulated learners of every size by two to four levels. The per-level knowledge is reported in
 * `LevelResult.levels` instead.
 */
export function crossCheck(level: CefrLevel, counts: LevelCounts, f: number): CefrLevel {
  let idx = levelIndex(level);
  while (idx > 0) {
    const c = counts[CEFR_LEVELS[idx]];
    if (!c || c.n < MIN_CROSS_CHECK_ITEMS) break;
    if (correctedRate(c.yes / c.n, f) >= MASTERY) break;
    idx--;
  }
  return CEFR_LEVELS[idx];
}

export function buildResult(args: {
  k: readonly number[];
  counts: readonly BandCounts[];
  f: number;
  /** 80% interval on V (lemmas), unrounded */
  interval: [number, number];
  levelCounts?: LevelCounts;
}): LevelResult {
  const v = sizeFromKnowledge(args.k);
  const cefr = cefrForLemmas(v);
  const lo = Math.max(0, Math.min(args.interval[0], v));
  const hi = Math.min(sizeFromKnowledge(BANDS.map(() => 1)), Math.max(args.interval[1], v));
  const lowLevel = CEFR_LEVELS[Math.min(levelIndex(cefr), levelIndex(cefrForLemmas(lo)))];
  const highLevel = CEFR_LEVELS[Math.max(levelIndex(cefr), levelIndex(cefrForLemmas(hi)))];
  return {
    sizeLemmas: roundTo(v),
    sizeFamilies: roundTo(familiesOf(v)),
    cefr,
    cefrRange: [lowLevel, highLevel],
    sizeRange: [roundTo(lo), roundTo(hi)],
    reliable: args.f <= UNRELIABLE_FALSE_ALARM,
    perBand: args.k.map((k, band) => ({ band, k: Math.round(k * 1000) / 1000, n: Math.round((args.counts[band]?.n ?? 0) * 1000) / 1000 })),
    levels: CEFR_LEVELS.flatMap((level) => {
      const c = args.levelCounts?.[level];
      return c && c.n > 0 ? [{ level, n: c.n, k: Math.round(correctedRate(c.yes / c.n, args.f) * 1000) / 1000 }] : [];
    }),
    falseAlarmRate: Math.round(args.f * 1000) / 1000,
  };
}

/** Percentile of a sorted numeric array (p in [0, 1]). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}
