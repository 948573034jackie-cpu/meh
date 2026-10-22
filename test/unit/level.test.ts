import { describe, it, expect } from 'vitest';
import type { DictData, DictRaw } from '@shared/api';
import { createDictionary } from '@core/dict/dictionary';
import { levelIndex } from '@core/model';
import {
  BANDS, MAX_RANK, bandOfRank, bandOfSize, buildItemPools, contentPos, derivationStems, pickItems, rankOf,
} from '@core/level/items';
import { buildPseudowords, syllabify } from '@core/level/pseudowords';
import { seededRng, shuffle } from '@core/level/rng';
import {
  CEFR_LEMMA_FLOORS, bandKnowledge, cefrForLemmas, correctedRate, crossCheck, monotoneDecreasing, sizeFromKnowledge,
} from '@core/level/score';
import {
  STAGE1_PER_BAND, STAGE1_PSEUDO, STAGE2_PSEUDO, STAGE2_REAL, createSession, prepareMaterials, restoreSession,
} from '@core/level/test';
import type { LevelTestSession, TestItem } from '@core/level/test';
import { LevelModel, significantChange } from '@core/level/adapt';

/* ------------------------------------------------------------------------------------------------
 * Synthetic dictionary: ~6,000 pronounceable generated words with COCA-like ranks 1..18,000, POS glosses,
 * CEFR tags by rank, an inflection map, plus a handful of hand-made entries that exercise each selection rule.
 * No real data is loaded (the real dictionary is covered by dictionary.test.ts).
 * ---------------------------------------------------------------------------------------------- */

const ONSETS = ['', 'b', 'c', 'd', 'f', 'g', 'h', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'br', 'cl', 'dr', 'fl', 'gr', 'pl', 'pr', 'st', 'tr', 'sh', 'th', 'ch', 'sp'];
const NUCLEI = ['a', 'e', 'i', 'o', 'u', 'ai', 'ea', 'ee', 'oa', 'ou', 'oo'];
const CODAS = ['', 'b', 'd', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'nd', 'nt', 'st', 'rt', 'ck', 'll', 'ss', 'ng', 'sh', 'ch', 'th'];
const POS_GLOSS = { n: 'n. 名词', v: 'vt. 动词', adj: 'a. 形容词', adv: 'adv. 副词' } as const;
type Pos = keyof typeof POS_GLOSS;

function levelForRank(rank: number): string {
  if (rank <= 1200) return 'A1';
  if (rank <= 2800) return 'A2';
  if (rank <= 5000) return 'B1';
  if (rank <= 9000) return 'B2';
  if (rank <= 14000) return 'C1';
  return 'C2';
}

function synthDict(count = 6000, seed = 42): DictData {
  const rng = seededRng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const w: Record<string, DictRaw> = {};
  const f: Record<string, string> = {};
  const used = new Set<string>();
  const posCycle: Pos[] = ['n', 'n', 'v', 'adj', 'n', 'v', 'adv', 'n'];
  let i = 0;
  while (i < count) {
    const syllables = 2 + (rng() < 0.4 ? 1 : 0);
    let word = '';
    for (let s = 0; s < syllables; s++) word += pick(ONSETS) + pick(NUCLEI) + (s === syllables - 1 || rng() < 0.4 ? pick(CODAS) : '');
    if (word.length < 4 || word.length > 11 || used.has(word) || /(.)\1\1/.test(word)) continue;
    used.add(word);
    const rank = i * 3 + 1;                                    // 1, 4, 7 ... 17998
    const pos = posCycle[i % posCycle.length];
    const tagged = i % 5 !== 4;                                // 80% CEFR-tagged
    w[word] = {
      i: `/${word}/`, t: POS_GLOSS[pos], g: tagged || i % 3 === 0 ? 'cet4' : '', f: rank, b: rank + 10,
      c: rank < 3000 ? 3 : 0, o: rank < 2000 ? 1 : 0, l: levelForRank(rank), s: tagged ? 'cefrj' : 'est',
    };
    if (i % 4 === 0) { f[`${word}s`] = word; f[`${word}ed`] = word; }
    i++;
  }
  // hand-made entries that exercise the selection rules
  const base = (o: Partial<DictRaw>): DictRaw => ({ i: '/x/', t: 'n. 名词', g: 'cet4', f: 3500, b: 3500, c: 0, o: 0, l: 'B1', s: 'cefrj', ...o });
  w['zinkle'] = base({});                                       // control: an ordinary candidate
  w['zinkling'] = base({ t: 'n. 名词' }); f['zinkling'] = 'zinkle';   // headword that is an inflection of another
  w['zorbed'] = base({ t: 'a. 形容词\nzorb的过去分词' });          // inflection by gloss
  w['zumbai'] = base({ t: 'n. [地名] 某地' });                     // proper noun by gloss marker
  w['london'] = base({ t: 'n. 伦敦' });                           // proper noun by list
  w['zbv'] = base({ i: '', t: 'abbr. 缩写' });                     // abbreviation: no ipa, abbr. gloss
  w['zabrev'] = base({ i: '' });                                   // abbreviation: no ipa
  w['fuck'] = base({ t: 'vt. 动词' });                             // swear word
  w['tofu'] = base({});                                            // loan familiar to Chinese speakers
  w['zorpquick'] = base({ f: 400, b: 400, t: 'a. 形容词', l: 'A1' });
  w['zorpquickly'] = base({ f: 5200, b: 5200, t: 'adv. 副词', l: 'B2' });  // transparent derivation of a lower-band word
  w['zunranked'] = base({ f: 0, b: 0 });                           // no rank
  w['zfarrank'] = base({ f: 25000, b: 25000 });                    // beyond the last band
  w['zfunction'] = base({ t: 'prep. 介词' });                      // not a content word
  w['znoposs'] = base({ t: '[计] 术语' });                         // no POS tag at all
  w['zunattest'] = base({ g: '', s: 'est', c: 0, o: 0 });          // untagged with no lexicographic signal
  w['zxyphrase word'] = base({});                                  // phrase: never a candidate
  w['Zcapital'] = base({});                                        // not lower-case
  return { w, f };
}

const data = synthDict();
const dict = createDictionary(data);
const materials = prepareMaterials(data);
const pools = materials.pools;
const rankOfWord = (word: string): number => rankOf(data.w[word]);

/** Answers every item of a stage as a learner who knows all words up to `knownRank`, flipping `noise` of the answers. */
function simulate(session: LevelTestSession, items: TestItem[], knownRank: number, noise: number, rng: () => number): void {
  for (const it of items) {
    const knows = it.kind === 'real' && rankOfWord(it.word) <= knownRank;
    session.answer(it.id, rng() < noise ? !knows : knows);
  }
}

function runLearner(seed: number, knownRank: number, noise = 0.1): LevelTestSession {
  const s = createSession(materials, { seed });
  const rng = seededRng(`learner-${seed}-${knownRank}`);
  simulate(s, s.items(), knownRank, noise, rng);
  simulate(s, s.nextStage(), knownRank, noise, rng);
  return s;
}

/* ------------------------------------------------------------------------------------------------ */

describe('bands', () => {
  it('cover ranks 1-20,000 contiguously', () => {
    expect(BANDS.map((b) => [b.lo, b.hi])).toEqual([[1, 2000], [2001, 3000], [3001, 4000], [4001, 5000], [5001, 7000], [7001, 10000], [10001, 14000], [14001, 20000]]);
    expect(BANDS.reduce((s, b) => s + b.width, 0)).toBe(MAX_RANK);
    expect(bandOfRank(1)).toBe(0); expect(bandOfRank(2000)).toBe(0); expect(bandOfRank(2001)).toBe(1);
    expect(bandOfRank(20000)).toBe(7); expect(bandOfRank(20001)).toBe(-1); expect(bandOfRank(0)).toBe(-1);
    expect(bandOfSize(0)).toBe(0); expect(bandOfSize(4000)).toBe(2); expect(bandOfSize(99999)).toBe(7);
  });

  it('rankOf prefers frq and falls back to bnc', () => {
    expect(rankOf({ f: 10, b: 20 })).toBe(10);
    expect(rankOf({ f: 0, b: 20 })).toBe(20);
    expect(rankOf({ f: 0, b: 0 })).toBe(0);
  });
});

describe('item pools', () => {
  const all = pools.bands.flat();
  const words = new Set(all.map((p) => p.word));

  it('fill every band with items whose rank lies in the band', () => {
    for (const b of BANDS) {
      const items = pools.bands[b.index];
      expect(items.length).toBeGreaterThan(50);
      for (const p of items) {
        expect(p.band).toBe(b.index);
        expect(p.rank).toBeGreaterThanOrEqual(b.lo);
        expect(p.rank).toBeLessThanOrEqual(b.hi);
      }
    }
  });

  it('keep only single lower-case alphabetic tokens of 3-12 letters with a content POS', () => {
    for (const p of all) {
      expect(p.word).toMatch(/^[a-z]{3,12}$/);
      expect(['n', 'v', 'adj', 'adv']).toContain(p.pos);
    }
    expect(words.has('zxyphrase word')).toBe(false);
    expect(words.has('Zcapital')).toBe(false);
    expect(words.has('zfunction')).toBe(false);
    expect(words.has('znoposs')).toBe(false);
  });

  it('apply the exclusion rules', () => {
    expect(words.has('zinkle')).toBe(true);          // the control passes
    expect(words.has('zinkling')).toBe(false);       // inflection (forms map)
    expect(words.has('zorbed')).toBe(false);         // inflection (gloss)
    expect(words.has('zumbai')).toBe(false);         // proper noun (gloss marker)
    expect(words.has('london')).toBe(false);         // proper noun (list)
    expect(words.has('zbv')).toBe(false);            // abbreviation
    expect(words.has('zabrev')).toBe(false);         // no pronunciation = abbreviation
    expect(words.has('fuck')).toBe(false);           // swear word
    expect(words.has('tofu')).toBe(false);           // loan
    expect(words.has('zorpquick')).toBe(true);
    expect(words.has('zorpquickly')).toBe(false);    // transparent derivation of a lower-band word
    expect(words.has('zunranked')).toBe(false);
    expect(words.has('zfarrank')).toBe(false);
    expect(words.has('zunattest')).toBe(false);
    for (const [w, base] of Object.entries(data.f)) if (base !== w) expect(words.has(w)).toBe(false);
    expect(pools.rejected.inflection).toBeGreaterThan(0);
    expect(pools.rejected.derivation).toBeGreaterThan(0);
  });

  it('carry CEFR levels for tagged words only and honour the exclude option', () => {
    expect(all.some((p) => p.level !== null)).toBe(true);
    for (const p of all) {
      const raw = data.w[p.word];
      if (raw.s === 'est') expect(p.level).toBeNull(); else expect(p.level).toBe(raw.l);
    }
    const without = buildItemPools(data, { exclude: ['zinkle', 'ZORPQUICK'] });
    const left = new Set(without.bands.flat().map((p) => p.word));
    expect(left.has('zinkle')).toBe(false);
    expect(left.has('zorpquick')).toBe(false);
    expect(left.size).toBe(words.size - 2);
  });

  it('helpers: contentPos and derivationStems', () => {
    expect(contentPos('n. 房子\nvt. 居住')).toBe('n');
    expect(contentPos('vt.& vi. 跑')).toBe('v');
    expect(contentPos('[医] 术语\na. 快的')).toBe('adj');
    expect(contentPos('adv. 快')).toBe('adv');
    expect(contentPos('prep. 在')).toBeNull();
    expect(contentPos('abbr. 缩写')).toBeNull();
    expect(contentPos('')).toBeNull();
    expect(derivationStems('quickly')).toContain('quick');
    expect(derivationStems('happiness')).toContain('happy');
    expect(derivationStems('government')).toContain('govern');
    expect(derivationStems('running')).toContain('run');
    expect(derivationStems('quick')).not.toContain('quick');
  });
});

describe('pickItems', () => {
  it('is deterministic, stratified by POS, capped on textbook words and respects avoid', () => {
    const pool = pools.bands[2];
    const a = pickItems(pool, 14, seededRng(1));
    const b = pickItems(pool, 14, seededRng(1));
    const c = pickItems(pool, 14, seededRng(2));
    expect(a.map((p) => p.word)).toEqual(b.map((p) => p.word));
    expect(a.map((p) => p.word)).not.toEqual(c.map((p) => p.word));
    expect(a).toHaveLength(14);
    expect(new Set(a.map((p) => p.word)).size).toBe(14);
    expect(a.filter((p) => p.pos === 'n').length).toBeGreaterThanOrEqual(Math.ceil(14 * 0.4));
    expect(a.filter((p) => p.pos === 'v').length).toBeGreaterThanOrEqual(Math.ceil(14 * 0.25));
    expect(a.every((p) => p.level !== null)).toBe(true);     // tagged words preferred while they last
    const avoid = new Set(a.map((p) => p.word));
    const d = pickItems(pool, 14, seededRng(1), { avoid });
    expect(d.some((p) => avoid.has(p.word))).toBe(false);
    // textbook cap: band 0 is almost entirely Oxford/Collins in the synthetic data, so the cap must yield to availability
    const e = pickItems(pools.bands[0], 5, seededRng(3));
    expect(e).toHaveLength(5);
    expect(pickItems(pool, 0, seededRng(1))).toEqual([]);
    expect(pickItems([], 5, seededRng(1))).toEqual([]);
  });
});

describe('pseudowords', () => {
  const pseudo = materials.pseudowords;

  it('builds a pool of at least 300 unique legal non-words', () => {
    expect(pseudo.length).toBeGreaterThanOrEqual(300);
    expect(new Set(pseudo).size).toBe(pseudo.length);
    for (const p of pseudo) {
      expect(p).toMatch(/^[a-z]{5,9}$/);
      expect(p).toMatch(/[aeiouy]/);
    }
  });

  it('never collides with a dictionary word, inflection or anything the dictionary can look up', () => {
    for (const p of pseudo) {
      expect(data.w[p]).toBeUndefined();
      expect(data.f[p]).toBeUndefined();
      expect(dict.lookup(p)).toBeNull();
      expect(dict.lookup(`${p}s`)?.lemma).not.toBe(p);
    }
  });

  it('is at least two edits away from every headword and deterministic by seed', () => {
    const headwords = new Set(Object.keys(data.w));
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (const p of pseudo.slice(0, 60)) {
      for (let i = 0; i < p.length; i++) {
        expect(headwords.has(p.slice(0, i) + p.slice(i + 1))).toBe(false);
        for (const ch of letters) expect(headwords.has(p.slice(0, i) + ch + p.slice(i + 1))).toBe(false);
      }
    }
    const again = buildPseudowords(data, { seed: 'readalong-pseudowords-v1', pools, dict });
    expect(again).toEqual(pseudo);
    const other = buildPseudowords(data, { seed: 'other', pools, dict, count: 50 });
    expect(other).toHaveLength(50);
    expect(other).not.toEqual(pseudo.slice(0, 50));
  });

  it('syllabify splits onset / nucleus / coda', () => {
    expect(syllabify('district')).toEqual([{ onset: 'd', nucleus: 'i', coda: 's' }, { onset: 'tr', nucleus: 'i', coda: 'ct' }]);
    expect(syllabify('plenty')).toEqual([{ onset: 'pl', nucleus: 'e', coda: 'n' }, { onset: 't', nucleus: 'y', coda: '' }]);
    expect(syllabify('banana')).toEqual([{ onset: 'b', nucleus: 'a', coda: '' }, { onset: 'n', nucleus: 'a', coda: '' }, { onset: 'n', nucleus: 'a', coda: '' }]);
    expect(syllabify('strength')).toEqual([{ onset: 'str', nucleus: 'e', coda: 'ngth' }]);
    expect(syllabify('rhythm')).toEqual([{ onset: 'rh', nucleus: 'y', coda: 'thm' }]);   // 'y' between consonants is a vowel
    expect(syllabify('pfft')).toBeNull();
    expect(syllabify('queueing')).toBeNull();
  });
});

describe('scoring helpers', () => {
  it('correctedRate is the cfg correction clamped to [0, 1]', () => {
    expect(correctedRate(0.9, 0.1)).toBeCloseTo(0.8 / 0.9);
    expect(correctedRate(0.05, 0.1)).toBe(0);
    expect(correctedRate(1, 0)).toBe(1);
    expect(correctedRate(1, 1)).toBe(0);
  });

  it('cefrForLemmas follows Nation\'s family scale x 1.6', () => {
    expect(CEFR_LEMMA_FLOORS.B1).toBe(3200);
    expect(cefrForLemmas(0)).toBe('A1');
    expect(cefrForLemmas(1599)).toBe('A1');
    expect(cefrForLemmas(1600)).toBe('A2');
    expect(cefrForLemmas(3200)).toBe('B1');
    expect(cefrForLemmas(5599)).toBe('B1');
    expect(cefrForLemmas(5600)).toBe('B2');
    expect(cefrForLemmas(8000)).toBe('C1');
    expect(cefrForLemmas(11200)).toBe('C2');
    expect(cefrForLemmas(20000)).toBe('C2');
  });

  it('monotoneDecreasing pools violators', () => {
    const close = (xs: number[], ys: number[]) => { expect(xs).toHaveLength(ys.length); xs.forEach((x, i) => expect(x).toBeCloseTo(ys[i])); };
    close(monotoneDecreasing([1, 0.5, 0.8, 0.2], [1, 1, 1, 1]), [1, 0.65, 0.65, 0.2]);
    close(monotoneDecreasing([0.2, 0.8], [3, 1]), [0.35, 0.35]);
    close(monotoneDecreasing([0.9, 0.9, 0.1], [1, 1, 1]), [0.9, 0.9, 0.1]);
  });

  it('bandKnowledge: all-known gives ~1 everywhere, all-unknown 0, a boundary stays a boundary', () => {
    const n = (k: number[]) => k.map((v) => ({ n: 5, yes: Math.round(5 * v) }));
    const known = bandKnowledge(n([1, 1, 1, 1, 1, 1, 1, 1]), 0);
    for (const k of known) expect(k).toBeGreaterThan(0.95);
    expect(sizeFromKnowledge(known)).toBeGreaterThan(19000);
    const none = bandKnowledge(n([0, 0, 0, 0, 0, 0, 0, 0]), 0.1);
    for (const k of none) expect(k).toBeLessThan(0.02);
    const half = bandKnowledge(n([1, 1, 1, 0, 0, 0, 0, 0]), 0);
    expect(half[2]).toBeGreaterThan(0.85);
    expect(half[3]).toBeLessThan(0.2);
    expect(sizeFromKnowledge(half)).toBeGreaterThan(3400);
    expect(sizeFromKnowledge(half)).toBeLessThan(4800);
    for (let b = 1; b < half.length; b++) expect(half[b]).toBeLessThanOrEqual(half[b - 1] + 1e-9);
    // a band without observations takes the curve
    const gap = bandKnowledge([{ n: 5, yes: 5 }, { n: 0, yes: 0 }, { n: 5, yes: 5 }, { n: 5, yes: 0 }, { n: 5, yes: 0 }, { n: 5, yes: 0 }, { n: 5, yes: 0 }, { n: 5, yes: 0 }], 0);
    expect(gap[1]).toBeGreaterThan(0.8);
  });

  it('crossCheck demotes while the level\'s own tagged words are not mastered', () => {
    expect(crossCheck('B2', { B2: { n: 10, yes: 5 }, B1: { n: 10, yes: 9 } }, 0)).toBe('B1');
    expect(crossCheck('B2', { B2: { n: 10, yes: 9 } }, 0)).toBe('B2');
    expect(crossCheck('B2', { B2: { n: 3, yes: 0 } }, 0)).toBe('B2');   // too few items to judge
    expect(crossCheck('A1', {}, 0)).toBe('A1');
  });
});

describe('test session', () => {
  it('stage 1 has 5 real words per band and 10 pseudowords, shuffled, with unique ids', () => {
    const s = createSession(materials, { seed: 11 });
    const items = s.items();
    expect(s.stage).toBe(1);
    expect(items).toHaveLength(BANDS.length * STAGE1_PER_BAND + STAGE1_PSEUDO);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.word)).size).toBe(items.length);
    for (const b of BANDS) expect(items.filter((i) => i.kind === 'real' && i.band === b.index)).toHaveLength(STAGE1_PER_BAND);
    const pseudo = items.filter((i) => i.kind === 'pseudo');
    expect(pseudo).toHaveLength(STAGE1_PSEUDO);
    for (const p of pseudo) { expect(p.band).toBe(-1); expect(materials.pseudowords).toContain(p.word); }
    const kinds = items.map((i) => i.kind);
    expect(kinds.slice(0, 40).every((k) => k === 'real')).toBe(false);
    expect(s.stageComplete()).toBe(false);
    expect(() => s.answer('nope', true)).toThrow();
    expect(() => s.result()).not.toThrow();
  });

  it('is reproducible from its seed and differs between seeds', () => {
    const a = createSession(materials, { seed: 'abc' }).items().map((i) => i.word);
    const b = createSession(materials, { seed: 'abc' }).items().map((i) => i.word);
    const c = createSession(materials, { seed: 'abd' }).items().map((i) => i.word);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('stage 2 draws 40 real words from the three bands around the provisional size plus 10 new pseudowords', () => {
    const s = createSession(materials, { seed: 5 });
    simulate(s, s.items(), 4000, 0, seededRng(1));
    const centre = bandOfSize(s.provisionalSize());
    const stage2 = s.nextStage();
    expect(s.stage).toBe(2);
    expect(stage2).toHaveLength(STAGE2_REAL + STAGE2_PSEUDO);
    const real = stage2.filter((i) => i.kind === 'real');
    expect(real).toHaveLength(STAGE2_REAL);
    const bands = new Set(real.map((i) => i.band));
    expect(bands.size).toBe(3);
    const first = Math.max(0, Math.min(BANDS.length - 3, centre - 1));
    expect([...bands].sort()).toEqual([first, first + 1, first + 2]);
    const stage1Words = new Set(s.items(1).map((i) => i.word));
    for (const i of stage2) expect(stage1Words.has(i.word)).toBe(false);
    expect(stage2.filter((i) => i.kind === 'pseudo')).toHaveLength(STAGE2_PSEUDO);
    expect(() => s.nextStage()).toThrow();
    expect(s.usedWords()).toHaveLength(80);
    expect(s.usedPseudowords()).toHaveLength(20);
  });

  it('a learner who knows every word up to rank 4,000 (10% noise) scores about 4k lemmas = 2.5k families = B1', () => {
    const sizes: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = runLearner(seed, 4000).result();
      sizes.push(r.sizeLemmas);
      expect(r.reliable).toBe(true);
      expect(r.falseAlarmRate).toBeLessThanOrEqual(0.3);
      expect(r.sizeLemmas % 250).toBe(0);
      expect(r.sizeFamilies % 250).toBe(0);
      expect(Math.abs(r.sizeFamilies - r.sizeLemmas / 1.6)).toBeLessThan(250);
      expect(r.perBand).toHaveLength(BANDS.length);
      expect(r.perBand[0].k).toBeGreaterThan(0.7);
      expect(r.perBand[5].k).toBeLessThan(0.2);
      expect(r.sizeRange[0]).toBeLessThanOrEqual(r.sizeLemmas);
      expect(r.sizeRange[1]).toBeGreaterThanOrEqual(r.sizeLemmas);
      expect(levelIndex(r.cefrRange[0])).toBeLessThanOrEqual(levelIndex(r.cefr));
      expect(levelIndex(r.cefrRange[1])).toBeGreaterThanOrEqual(levelIndex(r.cefr));
      expect(r.levels.length).toBeGreaterThan(0);
    }
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    expect(mean).toBeGreaterThan(3200);
    expect(mean).toBeLessThan(5000);
    // 4,000 lemmas are 2,500 word families: B1 on Nation's scale (B2 starts at 3,500 families = 5,600 lemmas)
    expect(runLearner(1, 4000).result().cefr).toBe('B1');
  });

  it('a learner who knows every word up to rank 6,500 (about 4k families) is B2; one up to 12,000 is C1/C2', () => {
    const b2 = runLearner(2, 6500).result();
    expect(b2.sizeLemmas).toBeGreaterThan(5600);
    expect(b2.sizeLemmas).toBeLessThan(8000);
    expect(b2.cefr).toBe('B2');
    const c = runLearner(3, 12000).result();
    expect(c.sizeLemmas).toBeGreaterThan(10000);
    expect(['C1', 'C2']).toContain(c.cefr);
  });

  it('flags a learner who says yes to everything as unreliable', () => {
    const s = createSession(materials, { seed: 9 });
    for (const it of s.items()) s.answer(it.id, true);
    for (const it of s.nextStage()) s.answer(it.id, true);
    const r = s.result();
    expect(r.falseAlarmRate).toBe(1);
    expect(r.reliable).toBe(false);
    expect(r.sizeLemmas).toBe(0);
    // seven pseudowords accepted out of twenty is over the 0.3 threshold too
    const t = runLearner(4, 4000, 0);
    const pseudo = [...t.items(1), ...t.items(2)].filter((i) => i.kind === 'pseudo');
    pseudo.slice(0, 7).forEach((p) => t.answer(p.id, true));
    expect(t.result().falseAlarmRate).toBeCloseTo(0.35);
    expect(t.result().reliable).toBe(false);
  });

  it('avoids the words and pseudowords of previous runs', () => {
    const first = runLearner(1, 4000);
    const previous = { words: first.usedWords(), pseudowords: first.usedPseudowords() };
    const second = createSession(materials, { seed: 1, previous });
    simulate(second, second.items(), 4000, 0.1, seededRng(7));
    second.nextStage();
    const seen = new Set([...previous.words, ...previous.pseudowords]);
    for (const it of [...second.items(1), ...second.items(2)]) expect(seen.has(it.word)).toBe(false);
  });

  it('round-trips through toJSON / restoreSession', () => {
    const s = runLearner(6, 4000);
    const json = JSON.parse(JSON.stringify(s.toJSON()));
    const back = restoreSession(materials, json);
    expect(back.stage).toBe(2);
    expect(back.items(1)).toEqual(s.items(1));
    expect(back.items(2)).toEqual(s.items(2));
    expect(back.answers()).toEqual(s.answers());
    expect(back.result()).toEqual(s.result());
  });

  it('accepts raw dictionary data and builds the materials itself', () => {
    const s = createSession(data, { seed: 1 });
    expect(s.items()).toHaveLength(50);
    expect(s.items().map((i) => i.word)).toEqual(createSession(materials, { seed: 1 }).items().map((i) => i.word));
  });
});

describe('daily adaptation (LevelModel)', () => {
  const testResult = runLearner(1, 4000).result();

  it('initialises Beta posteriors from a test result and reproduces its shape', () => {
    const m = LevelModel.fromTest(testResult, '2026-10-19T00:00:00Z');
    for (const b of m.bands()) {
      const pb = testResult.perBand[b.band];
      expect(b.alpha).toBeCloseTo(1 + pb.k * pb.n);
      expect(b.beta).toBeCloseTo(1 + (1 - pb.k) * pb.n);
    }
    const e = m.estimate();
    expect(e.perBand).toHaveLength(BANDS.length);
    expect(e.levels).toEqual([]);
    expect(e.reliable).toBe(true);
    expect(e.falseAlarmRate).toBe(testResult.falseAlarmRate);
    expect(Math.abs(e.sizeLemmas - testResult.sizeLemmas)).toBeLessThanOrEqual(1500);
    expect(['A2', 'B1', 'B2']).toContain(e.cefr);
    expect(m.testedAt).toBe('2026-10-19T00:00:00Z');
    expect(m.estimate()).toEqual(m.estimate());        // deterministic
  });

  it('moves the estimate down after 30 "don\'t know" taps in the 2-3k band, counting each word once', () => {
    const m = LevelModel.fromTest(testResult);
    const before = m.estimate();
    const words = pools.bands[1].slice(0, 30).map((p) => p.word);
    let counted = 0;
    for (const w of words) if (m.observe(w, false, dict)) counted++;
    expect(counted).toBe(30);
    expect(m.observe(words[0], false, dict)).toBe(false);          // already counted
    expect(m.observe(`${words[0]}`.toUpperCase(), true, dict)).toBe(false);   // same lemma, any case
    expect(m.observe('zzzznotaword', true, dict)).toBe(false);     // unknown to the dictionary
    expect(m.observe('zunranked', true, dict)).toBe(false);        // no corpus rank
    expect(m.bands()[1].beta).toBeCloseTo(1 + (1 - testResult.perBand[1].k) * testResult.perBand[1].n + 15);
    const after = m.estimate();
    expect(after.perBand[1].k).toBeLessThan(before.perBand[1].k - 0.2);
    expect(after.sizeLemmas).toBeLessThanOrEqual(before.sizeLemmas - 250);
    expect(m.observations()).toBeCloseTo(80 + 15);
    // inflected forms count toward the lemma's band
    const w = pools.bands[0].find((p) => !p.word.endsWith('s') && !data.w[`${p.word}s`])!.word;
    expect(m.observe(`${w}s`, true, dict)).toBe(true);
    expect(m.observe(w, true, dict)).toBe(false);
  });

  it('decays the evidence toward Beta(1,1) by 0.98 per week', () => {
    const m = LevelModel.fromTest(testResult);
    const b0 = m.bands()[0];
    m.decay(10, '2026-12-28T00:00:00Z');
    const b1 = m.bands()[0];
    expect(b1.alpha - 1).toBeCloseTo((b0.alpha - 1) * Math.pow(0.98, 10));
    expect(b1.beta - 1).toBeCloseTo((b0.beta - 1) * Math.pow(0.98, 10));
    expect(m.updatedAt).toBe('2026-12-28T00:00:00Z');
    m.decay(0);
    expect(m.bands()[0]).toEqual(b1);
    // after decay, a few taps shift the band more than before
    const fresh = LevelModel.fromTest(testResult);
    const decayed = LevelModel.fromTest(testResult); decayed.decay(52);
    for (const p of pools.bands[2].slice(0, 10)) { fresh.observe(p.word, false, dict); decayed.observe(p.word, false, dict); }
    expect(decayed.bands()[2].mean).toBeLessThan(fresh.bands()[2].mean);
  });

  it('round-trips through JSON', () => {
    const m = LevelModel.fromTest(testResult, '2026-10-19T00:00:00Z');
    for (const p of pools.bands[1].slice(0, 5)) m.observe(p.word, false, dict, '2026-10-20T00:00:00Z');
    m.decay(2);
    const json = m.toJSON();
    const text = JSON.stringify(json);
    const back = LevelModel.fromJSON(JSON.parse(text));
    expect(back.toJSON()).toEqual(json);
    expect(back.estimate()).toEqual(m.estimate());
    expect(back.observe(pools.bands[1][0].word, true, dict)).toBe(false);    // seen set survived
    expect(LevelModel.fromJSON(text).toJSON()).toEqual(json);
    expect(() => LevelModel.fromJSON('{"version":2}')).toThrow();
    const blank = LevelModel.initial();
    expect(blank.observations()).toBe(0);
    expect(blank.estimate().sizeLemmas).toBeGreaterThanOrEqual(0);
  });

  it('significantChange only fires when the interval moves a whole level', () => {
    const r = testResult;
    expect(significantChange(r, r)).toBe(false);
    expect(significantChange(r, { ...r, cefrRange: ['B2', 'C1'], cefr: 'B2' })).toBe(true);
    expect(significantChange(r, { ...r, cefrRange: [r.cefrRange[0], 'C1'] })).toBe(false);
  });
});

describe('rng', () => {
  it('shuffle is deterministic and a permutation', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = shuffle(xs, seededRng(3));
    expect(a).toEqual(shuffle(xs, seededRng(3)));
    expect([...a].sort((x, y) => x - y)).toEqual(xs);
    expect(a).not.toEqual(xs);
    expect(xs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
