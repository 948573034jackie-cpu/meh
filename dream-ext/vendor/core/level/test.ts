import type { CefrLevel } from '@core/model';
import type { DictData } from '@shared/api';
import type { ItemPools, PoolItem } from './items';
import { BANDS, bandOfSize, buildItemPools, pickItems } from './items';
import { buildPseudowords } from './pseudowords';
import type { Rng } from './rng';
import { hashSeed, seededRng, shuffle } from './rng';
import type { BandCounts, LevelCounts, LevelResult } from './score';
import { bandKnowledge, buildResult, falseAlarmRate, percentile, sizeFromKnowledge } from './score';

/**
 * The two-stage yes/no level test (spec section 3).
 *
 *  Stage 1: 5 real words per band (8 bands) + 10 pseudowords = 50 items, shuffled; gives a provisional size.
 *  Stage 2: 40 real words from the three bands around the provisional size + 10 pseudowords = 50 items.
 *  Result:  all 80 real + 20 pseudowords scored together (score.ts), with an 80% bootstrap interval over the
 *           real items. Items are drawn from the pools with the session seed, so a run can be reproduced,
 *           and words/pseudowords of earlier runs are avoided when `previous` is given.
 */

export const STAGE1_PER_BAND = 5;
export const STAGE1_PSEUDO = 10;
export const STAGE2_REAL = 40;
export const STAGE2_PSEUDO = 10;
export const BOOTSTRAP_RESAMPLES = 1000;
/** Pseudowords are generated with a fixed seed so the pool is stable across sessions and runs can avoid repeats. */
export const PSEUDOWORD_POOL_SEED = 'readalong-pseudowords-v1';

export type Stage = 1 | 2;

export interface TestItem {
  id: string;
  word: string;
  /** the learner never sees this */
  kind: 'real' | 'pseudo';
  /** band index for real words, -1 for pseudowords */
  band: number;
  /** CEFR-J/Octanove level of a real word, null when untagged or pseudo */
  level: CefrLevel | null;
  stage: Stage;
}

/** Item pools and pseudoword pool, built once per dictionary (a few tens of ms for 50k entries). */
export interface LevelMaterials {
  pools: ItemPools;
  pseudowords: string[];
}

export interface SessionOptions {
  seed: number | string;
  /** words and pseudowords shown in earlier runs; avoided while the pools allow */
  previous?: { words?: readonly string[]; pseudowords?: readonly string[] };
  /** lemmas to leave out of the item pools altogether (e.g. met in the last 30 days of reading) */
  exclude?: Iterable<string>;
}

export interface SessionState {
  seed: number | string;
  stage: Stage;
  items: TestItem[];
  answers: Record<string, boolean>;
  previous: { words: string[]; pseudowords: string[] };
}

export interface LevelTestSession {
  readonly seed: number | string;
  /** current stage (1 until nextStage() is called) */
  readonly stage: Stage;
  /** items of a stage (default: the current one), in presentation order */
  items(stage?: Stage): TestItem[];
  /** records the learner's answer; answering again overwrites */
  answer(itemId: string, yes: boolean): void;
  answers(): Record<string, boolean>;
  /** every item of the current stage has an answer */
  stageComplete(): boolean;
  /** lemma estimate from the answers so far (unrounded) */
  provisionalSize(): number;
  /** builds stage 2 from the provisional size and returns its items; throws when already in stage 2 */
  nextStage(): TestItem[];
  /** scores the answers given so far (both stages) */
  result(): LevelResult;
  /** words / pseudowords used in this session (for `previous` of the next run) */
  usedWords(): string[];
  usedPseudowords(): string[];
  /** plain state for persistence; restore with `restoreSession` */
  toJSON(): SessionState;
}

export function prepareMaterials(data: DictData, opts: { exclude?: Iterable<string> } = {}): LevelMaterials {
  const pools = buildItemPools(data, { exclude: opts.exclude });
  return { pools, pseudowords: buildPseudowords(data, { seed: PSEUDOWORD_POOL_SEED, pools }) };
}

const isMaterials = (x: DictData | LevelMaterials): x is LevelMaterials => 'pools' in x && 'pseudowords' in x;

export function createSession(dict: DictData | LevelMaterials, opts: SessionOptions): LevelTestSession {
  const materials = isMaterials(dict) ? dict : prepareMaterials(dict, { exclude: opts.exclude });
  const previous = {
    words: [...(opts.previous?.words ?? [])],
    pseudowords: [...(opts.previous?.pseudowords ?? [])],
  };
  const session = new Session(materials, { seed: opts.seed, stage: 1, items: [], answers: {}, previous });
  session.buildStage1();
  return session;
}

export function restoreSession(materials: LevelMaterials, state: SessionState): LevelTestSession {
  return new Session(materials, {
    seed: state.seed, stage: state.stage, items: state.items.map((i) => ({ ...i })),
    answers: { ...state.answers },
    previous: { words: [...(state.previous?.words ?? [])], pseudowords: [...(state.previous?.pseudowords ?? [])] },
  });
}

/* ------------------------------------------------------------------------------------------------ */

class Session implements LevelTestSession {
  private readonly state: SessionState;

  constructor(private readonly materials: LevelMaterials, state: SessionState) {
    this.state = state;
  }

  get seed(): number | string { return this.state.seed; }
  get stage(): Stage { return this.state.stage; }

  items(stage: Stage = this.state.stage): TestItem[] {
    return this.state.items.filter((i) => i.stage === stage);
  }

  answer(itemId: string, yes: boolean): void {
    if (!this.state.items.some((i) => i.id === itemId)) throw new Error(`unknown item ${itemId}`);
    this.state.answers[itemId] = yes;
  }

  answers(): Record<string, boolean> { return { ...this.state.answers }; }

  stageComplete(): boolean {
    return this.items().every((i) => i.id in this.state.answers);
  }

  provisionalSize(): number {
    const { counts, f } = this.counts();
    return sizeFromKnowledge(bandKnowledge(counts, f));
  }

  nextStage(): TestItem[] {
    if (this.state.stage !== 1) throw new Error('stage 2 already built');
    const centre = bandOfSize(this.provisionalSize());
    const first = Math.max(0, Math.min(BANDS.length - 3, centre - 1));
    const bands = [first, first + 1, first + 2];
    const per = Math.floor(STAGE2_REAL / 3);
    const extra = STAGE2_REAL - per * 3;
    const rng = seededRng(`${hashSeed(this.state.seed)}:stage2`);
    const avoid = this.avoidWords();
    const real: PoolItem[] = [];
    for (const b of bands) {
      const n = b === Math.max(first, Math.min(first + 2, centre)) ? per + extra : per;
      real.push(...pickItems(this.materials.pools.bands[b], n, rng, { avoid }));
    }
    // top up from the same bands if one of them ran short
    for (const b of bands) {
      if (real.length >= STAGE2_REAL) break;
      const have = new Set(real.map((p) => p.word));
      for (const p of pickItems(this.materials.pools.bands[b], STAGE2_REAL - real.length, rng, { avoid: new Set([...avoid, ...have]) })) {
        if (real.length < STAGE2_REAL && !have.has(p.word)) { real.push(p); have.add(p.word); }
      }
    }
    const pseudo = this.pickPseudowords(STAGE2_PSEUDO, rng);
    this.state.items.push(...this.compose(2, real, pseudo, rng));
    this.state.stage = 2;
    return this.items(2);
  }

  result(): LevelResult {
    const { counts, f, answered } = this.counts();
    const k = bandKnowledge(counts, f);
    const real = answered.filter((a) => a.item.kind === 'real');
    // CEFR-tagged items for the cross-check
    const levelCounts: LevelCounts = {};
    for (const a of real) {
      if (!a.item.level) continue;
      const c = levelCounts[a.item.level] ?? (levelCounts[a.item.level] = { n: 0, yes: 0 });
      c.n++; if (a.yes) c.yes++;
    }
    // 80% bootstrap interval over the real items (f fixed)
    const rng = seededRng(`${hashSeed(this.state.seed)}:bootstrap`);
    const sizes: number[] = [];
    if (real.length > 0) {
      for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
        const c: BandCounts[] = BANDS.map(() => ({ n: 0, yes: 0 }));
        for (let i = 0; i < real.length; i++) {
          const a = real[Math.floor(rng() * real.length)];
          c[a.item.band].n++; if (a.yes) c[a.item.band].yes++;
        }
        sizes.push(sizeFromKnowledge(bandKnowledge(c, f)));
      }
      sizes.sort((x, y) => x - y);
    }
    const v = sizeFromKnowledge(k);
    const interval: [number, number] = sizes.length ? [percentile(sizes, 0.1), percentile(sizes, 0.9)] : [v, v];
    return buildResult({ k, counts, f, interval, levelCounts });
  }

  usedWords(): string[] { return this.state.items.filter((i) => i.kind === 'real').map((i) => i.word); }
  usedPseudowords(): string[] { return this.state.items.filter((i) => i.kind === 'pseudo').map((i) => i.word); }

  toJSON(): SessionState {
    return {
      seed: this.state.seed, stage: this.state.stage, items: this.state.items.map((i) => ({ ...i })),
      answers: { ...this.state.answers },
      previous: { words: [...this.state.previous.words], pseudowords: [...this.state.previous.pseudowords] },
    };
  }

  /* ---- internals ---- */

  buildStage1(): void {
    const rng = seededRng(`${hashSeed(this.state.seed)}:stage1`);
    const avoid = this.avoidWords();
    const real: PoolItem[] = [];
    for (const band of BANDS) real.push(...pickItems(this.materials.pools.bands[band.index], STAGE1_PER_BAND, rng, { avoid }));
    const pseudo = this.pickPseudowords(STAGE1_PSEUDO, rng);
    this.state.items.push(...this.compose(1, real, pseudo, rng));
  }

  private avoidWords(): Set<string> {
    return new Set([...this.state.previous.words, ...this.usedWords()]);
  }

  private pickPseudowords(n: number, rng: Rng): string[] {
    const pool = this.materials.pseudowords;
    const avoid = new Set([...this.state.previous.pseudowords, ...this.usedPseudowords()]);
    const order = shuffle(pool, rng);
    const fresh = order.filter((w) => !avoid.has(w));
    const chosen = fresh.slice(0, n);
    if (chosen.length < n) {
      // pool exhausted for this learner: fall back to repeats rather than fewer pseudowords
      const used = new Set(this.usedPseudowords());
      for (const w of order) { if (chosen.length >= n) break; if (!chosen.includes(w) && !used.has(w)) chosen.push(w); }
    }
    return chosen;
  }

  private compose(stage: Stage, real: PoolItem[], pseudo: string[], rng: Rng): TestItem[] {
    const items: TestItem[] = [
      ...real.map((p): TestItem => ({ id: '', word: p.word, kind: 'real', band: p.band, level: p.level, stage })),
      ...pseudo.map((w): TestItem => ({ id: '', word: w, kind: 'pseudo', band: -1, level: null, stage })),
    ];
    return shuffle(items, rng).map((it, i) => ({ ...it, id: `s${stage}-${String(i + 1).padStart(2, '0')}` }));
  }

  private counts(): { counts: BandCounts[]; f: number; answered: { item: TestItem; yes: boolean }[] } {
    const answered: { item: TestItem; yes: boolean }[] = [];
    for (const item of this.state.items) {
      const yes = this.state.answers[item.id];
      if (yes !== undefined) answered.push({ item, yes });
    }
    const counts: BandCounts[] = BANDS.map(() => ({ n: 0, yes: 0 }));
    let pseudoN = 0; let pseudoYes = 0;
    for (const a of answered) {
      if (a.item.kind === 'pseudo') { pseudoN++; if (a.yes) pseudoYes++; }
      else { counts[a.item.band].n++; if (a.yes) counts[a.item.band].yes++; }
    }
    return { counts, f: falseAlarmRate(pseudoYes, pseudoN), answered };
  }
}
