import type { Dictionary } from '@core/dict/types';
import { levelIndex } from '@core/model';
import { BANDS, bandOfRank, rankOf } from './items';
import { randBeta, seededRng } from './rng';
import type { BandCounts, LevelResult } from './score';
import { bandKnowledge, buildResult, percentile, sizeFromKnowledge } from './score';

/**
 * Daily adaptation of the level estimate from "I know / I don't know" taps (spec section 5).
 *
 * One Beta(alpha_b, beta_b) posterior per frequency band, initialised from a test result
 * (alpha = 1 + k_b n_b, beta = 1 + (1 - k_b) n_b). A tap on a word of band b is one observation of weight 0.5:
 * "know" adds to alpha_b, "don't know" (or a lookup) adds to beta_b; a lemma counts once. Both parameters decay
 * toward the Beta(1,1) prior by 0.98 per week so recent evidence dominates. `estimate()` recomputes V and the
 * CEFR level with the section-3 formula (taps carry no pseudowords, so the counts are used uncorrected).
 */

export const TAP_WEIGHT = 0.5;
export const WEEKLY_DECAY = 0.98;
export const ESTIMATE_DRAWS = 1000;

export interface LevelModelJSON {
  version: 1;
  alpha: number[];
  beta: number[];
  /** false-alarm rate of the test the model was initialised from (0 when none) */
  falseAlarmRate: number;
  /** lemmas already counted */
  seen: string[];
  /** ISO time of the last observation or decay, for the caller's own bookkeeping */
  updatedAt: string | null;
  /** ISO time of the test the model was reset from */
  testedAt: string | null;
}

export class LevelModel {
  private alpha: number[];
  private beta: number[];
  private falseAlarm: number;
  private seen: Set<string>;
  updatedAt: string | null;
  testedAt: string | null;

  private constructor(j: LevelModelJSON) {
    this.alpha = BANDS.map((b) => (Number.isFinite(j.alpha[b.index]) ? Math.max(1, j.alpha[b.index]) : 1));
    this.beta = BANDS.map((b) => (Number.isFinite(j.beta[b.index]) ? Math.max(1, j.beta[b.index]) : 1));
    this.falseAlarm = Number.isFinite(j.falseAlarmRate) ? j.falseAlarmRate : 0;
    this.seen = new Set(j.seen ?? []);
    this.updatedAt = j.updatedAt ?? null;
    this.testedAt = j.testedAt ?? null;
  }

  /** A flat Beta(1,1) in every band: no information yet. */
  static initial(): LevelModel {
    return new LevelModel({ version: 1, alpha: BANDS.map(() => 1), beta: BANDS.map(() => 1), falseAlarmRate: 0, seen: [], updatedAt: null, testedAt: null });
  }

  /** Resets the posteriors from a test result: alpha = 1 + k n, beta = 1 + (1 - k) n per band. */
  static fromTest(result: LevelResult, testedAt: string | null = null): LevelModel {
    const alpha = BANDS.map(() => 1); const beta = BANDS.map(() => 1);
    for (const pb of result.perBand) {
      if (pb.band < 0 || pb.band >= BANDS.length) continue;
      alpha[pb.band] = 1 + pb.k * pb.n;
      beta[pb.band] = 1 + (1 - pb.k) * pb.n;
    }
    return new LevelModel({ version: 1, alpha, beta, falseAlarmRate: result.falseAlarmRate, seen: [], updatedAt: testedAt, testedAt });
  }

  static fromJSON(j: LevelModelJSON | string): LevelModel {
    const o = typeof j === 'string' ? (JSON.parse(j) as LevelModelJSON) : j;
    if (!o || o.version !== 1 || !Array.isArray(o.alpha) || !Array.isArray(o.beta)) throw new Error('not a LevelModel');
    return new LevelModel(o);
  }

  toJSON(): LevelModelJSON {
    return {
      version: 1, alpha: [...this.alpha], beta: [...this.beta], falseAlarmRate: this.falseAlarm,
      seen: [...this.seen].sort(), updatedAt: this.updatedAt, testedAt: this.testedAt,
    };
  }

  /** Posterior parameters per band (for display: "2-3k: 14 of 18 known"). */
  bands(): { band: number; alpha: number; beta: number; mean: number }[] {
    return BANDS.map((b) => ({ band: b.index, alpha: this.alpha[b.index], beta: this.beta[b.index], mean: this.alpha[b.index] / (this.alpha[b.index] + this.beta[b.index]) }));
  }

  /**
   * One tap on a word as it appears in text. Returns false (and changes nothing) when the word is unknown to
   * the dictionary, has no corpus rank in the test's range, or its lemma was already counted.
   */
  observe(word: string, knows: boolean, dict: Dictionary, at: string | null = null): boolean {
    const r = dict.lookup(word);
    if (!r) return false;
    const band = bandOfRank(rankOf({ f: r.entry.frq, b: r.entry.bnc }));
    if (band < 0) return false;
    if (this.seen.has(r.lemma)) return false;
    this.seen.add(r.lemma);
    if (knows) this.alpha[band] += TAP_WEIGHT; else this.beta[band] += TAP_WEIGHT;
    if (at) this.updatedAt = at;
    return true;
  }

  /** Decays the evidence (the part above the Beta(1,1) prior) by 0.98 per week. */
  decay(weeks: number, at: string | null = null): void {
    if (!(weeks > 0)) return;
    const d = Math.pow(WEEKLY_DECAY, weeks);
    for (let b = 0; b < BANDS.length; b++) {
      this.alpha[b] = 1 + (this.alpha[b] - 1) * d;
      this.beta[b] = 1 + (this.beta[b] - 1) * d;
    }
    if (at) this.updatedAt = at;
  }

  /** Evidence counted so far (alpha + beta - 2 summed over bands). */
  observations(): number {
    return this.alpha.reduce((s, a, b) => s + a + this.beta[b] - 2, 0);
  }

  /**
   * Current estimate in the test's result shape. The point estimate uses the posterior counts (n = alpha + beta - 2,
   * yes = alpha - 1) through the section-3 shrinkage; the 80% interval is a parametric bootstrap from the
   * posteriors (deterministic for a given seed). There are no CEFR-tagged items here, so `cefr` is the size level.
   */
  estimate(seed: number | string = 'level-model'): LevelResult {
    const counts: BandCounts[] = BANDS.map((b) => ({ n: this.alpha[b.index] + this.beta[b.index] - 2, yes: this.alpha[b.index] - 1 }));
    const k = bandKnowledge(counts, 0);
    const rng = seededRng(seed);
    const sizes: number[] = [];
    for (let r = 0; r < ESTIMATE_DRAWS; r++) {
      const draw: BandCounts[] = BANDS.map((b) => {
        const p = randBeta(rng, this.alpha[b.index], this.beta[b.index]);
        return { n: counts[b.index].n, yes: p * counts[b.index].n };
      });
      sizes.push(sizeFromKnowledge(bandKnowledge(draw, 0)));
    }
    sizes.sort((x, y) => x - y);
    return buildResult({ k, counts, f: this.falseAlarm, interval: [percentile(sizes, 0.1), percentile(sizes, 0.9)] });
  }
}

/**
 * Whether a nightly re-estimate should be surfaced to the learner: only when the 80% interval has moved a whole
 * CEFR level in the same direction (both ends up, or both ends down), or the point level changed by two.
 */
export function significantChange(prev: LevelResult, next: LevelResult): boolean {
  const dLo = levelIndex(next.cefrRange[0]) - levelIndex(prev.cefrRange[0]);
  const dHi = levelIndex(next.cefrRange[1]) - levelIndex(prev.cefrRange[1]);
  if ((dLo > 0 && dHi > 0) || (dLo < 0 && dHi < 0)) return true;
  return Math.abs(levelIndex(next.cefr) - levelIndex(prev.cefr)) >= 2;
}
