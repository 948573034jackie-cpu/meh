import type { DictData } from '@shared/api';
import { createDictionary } from '@core/dict/dictionary';
import type { Dictionary } from '@core/dict/types';
import type { ItemPools } from './items';
import { SWEAR_SUBSTRINGS, buildItemPools } from './items';
import type { Rng } from './rng';
import { randInt, seededRng } from './rng';

/**
 * Wuggy-style pseudowords (Keuleers & Brysbaert 2010) for the yes/no test: a real word of the 3-8k band is split
 * into syllables, each syllable into onset / nucleus / coda, and one of those sub-syllabic segments is replaced
 * by a segment other real words use in the same position (*district* -> *dastrict*, *plenty* -> *plenture*).
 * The result keeps English spelling patterns (every trigram occurs in a real word) but is not a word, not an
 * inflection, not reachable through the dictionary's suffix rules, at least two edits away from every headword
 * (so it does not read as a typo of a known word), and not offensive.
 *
 * Sources are the CEFR-tagged item-pool words of rank 3,000-8,000 (so names, abbreviations and inflections
 * never seed a pseudoword). The pool is deterministic for a seed.
 */

export interface PseudowordOptions {
  seed?: number | string;
  /** pool size to aim for (default 300); the generator stops early only when the source words are exhausted */
  count?: number;
  /** rank range of the real words the pseudowords are built from (default 3,000-8,000) */
  minRank?: number;
  maxRank?: number;
  /** item pools built from `data`, when the caller already has them */
  pools?: ItemPools;
  /** a dictionary built from `data`, when the caller already has one */
  dict?: Dictionary;
}

export const MIN_PSEUDO_LENGTH = 5;
export const MAX_PSEUDO_LENGTH = 9;

const VOWELS = new Set('aeiou');
/** Clusters that may start a syllable; anything else between vowels is split before its last consonant. */
const ONSETS = new Set([
  'bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw',
  'tr', 'tw', 'th', 'sh', 'ch', 'wh', 'ph', 'wr', 'kn', 'gn', 'qu', 'scr', 'str', 'spr', 'spl', 'thr', 'shr', 'chr',
  'sch', 'squ', 'sph',
]);

export interface Syllable { onset: string; nucleus: string; coda: string }
type Part = keyof Syllable;
type Position = 'first' | 'mid' | 'last';
const PARTS: readonly Part[] = ['onset', 'nucleus', 'coda'];

function isVowel(ch: string, i: number, w: string): boolean {
  if (VOWELS.has(ch)) return true;
  // 'y' is a vowel when it is not followed by a vowel (fly, system, happy) and not word-initial (yes)
  return ch === 'y' && i > 0 && !(i + 1 < w.length && VOWELS.has(w[i + 1]));
}

/** Splits a lower-case word into syllables; null for words without a vowel or with a vowel run longer than 3 letters. */
export function syllabify(w: string): Syllable[] | null {
  const runs: { v: boolean; s: string }[] = [];
  for (let i = 0; i < w.length; i++) {
    const v = isVowel(w[i], i, w);
    const last = runs[runs.length - 1];
    if (last && last.v === v) last.s += w[i];
    else runs.push({ v, s: w[i] });
  }
  const vowelRuns = runs.filter((r) => r.v);
  if (vowelRuns.length === 0 || vowelRuns.some((r) => r.s.length > 3)) return null;
  const syl: Syllable[] = [];
  let onset = '';
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (!r.v) {
      if (i === 0) onset = r.s;
      continue;
    }
    const next = runs[i + 1];
    let coda = '';
    if (next && !next.v) {
      if (i + 2 >= runs.length) coda = next.s;                       // final consonants
      else {
        const c = next.s;
        let split = c.length - 1;                                      // default: last consonant starts the next syllable
        for (const len of [3, 2]) if (c.length > len && ONSETS.has(c.slice(-len))) { split = c.length - len; break; }
        if (c.length === 1) split = 0;
        if (c.length === 2 && ONSETS.has(c)) split = 0;
        coda = c.slice(0, split);
        next.s = c.slice(split);
      }
    }
    syl.push({ onset, nucleus: r.s, coda });
    onset = next && !next.v && i + 2 < runs.length ? next.s : '';
  }
  return syl;
}

function position(i: number, n: number): Position {
  return n === 1 ? 'first' : i === 0 ? 'first' : i === n - 1 ? 'last' : 'mid';
}

/** a segment is exchangeable only with segments from the same position; nuclei also by whether the syllable has an onset */
function inventoryKey(s: Syllable, i: number, n: number, part: Part): string {
  return part === 'nucleus' ? `${position(i, n)}:nucleus:${s.onset ? 'on' : 'bare'}` : `${position(i, n)}:${part}`;
}

const MIN_SEGMENT_COUNT = 3;
const MIN_NUCLEUS_COUNT = 5;

function join(syl: readonly Syllable[]): string {
  return syl.map((s) => s.onset + s.nucleus + s.coda).join('');
}

/** All strings one edit (substitution, deletion, insertion, adjacent transposition) away from `w`. */
function* neighbours(w: string): Generator<string> {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < w.length; i++) {
    yield w.slice(0, i) + w.slice(i + 1);
    for (const ch of letters) if (ch !== w[i]) yield w.slice(0, i) + ch + w.slice(i + 1);
    if (i + 1 < w.length && w[i] !== w[i + 1]) yield w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
  }
  for (let i = 0; i <= w.length; i++) for (const ch of letters) yield w.slice(0, i) + ch + w.slice(i);
}

export function buildPseudowords(data: DictData, opts: PseudowordOptions = {}): string[] {
  const target = opts.count ?? 300;
  const minRank = opts.minRank ?? 3000;
  const maxRank = opts.maxRank ?? 8000;
  const rng: Rng = seededRng(opts.seed ?? 0);
  const headwords = new Set<string>();
  const forms = new Set<string>(Object.keys(data.f));
  const dict = opts.dict ?? createDictionary(data);
  const pools = opts.pools ?? buildItemPools(data);

  // spelling-pattern inventory from every alphabetic headword
  const trigrams = new Set<string>();
  for (const w of Object.keys(data.w)) {
    if (!/^[a-z]+$/.test(w)) continue;
    headwords.add(w);
    for (let i = 0; i + 2 < w.length; i++) trigrams.add(w.slice(i, i + 3));
  }

  // source words and the sub-syllabic segment inventory
  const sources: { word: string; syl: Syllable[] }[] = [];
  const inventory = new Map<string, Map<string, number>>();   // `${position}:${part}` -> segment -> count
  for (const band of pools.bands) {
    for (const item of band) {
      const w = item.word;
      if (item.level === null || item.rank < minRank || item.rank > maxRank) continue;
      if (w.length < MIN_PSEUDO_LENGTH || w.length > MAX_PSEUDO_LENGTH) continue;
      const syl = syllabify(w);
      if (!syl || syl.length < 2 || syl.length > 3) continue;
      sources.push({ word: w, syl });
      syl.forEach((s, i) => {
        for (const part of PARTS) {
          const key = inventoryKey(s, i, syl.length, part);
          let m = inventory.get(key);
          if (!m) { m = new Map(); inventory.set(key, m); }
          m.set(s[part], (m.get(s[part]) ?? 0) + 1);
        }
      });
    }
  }
  sources.sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  // replacement segments: seen often enough in that position to be productive patterns, not oddities
  const choices = new Map<string, string[]>();
  for (const [key, m] of inventory) {
    const min = key.includes(':nucleus') ? MIN_NUCLEUS_COUNT : MIN_SEGMENT_COUNT;
    choices.set(key, [...m.entries()].filter(([, c]) => c >= min).map(([s]) => s).sort());
  }

  const isOk = (cand: string, base: string): boolean => {
    if (cand === base || cand.length < MIN_PSEUDO_LENGTH || cand.length > MAX_PSEUDO_LENGTH) return false;
    if (/(.)\1\1/.test(cand) || /[aeiou]{3}/.test(cand) || /[^aeiouy]{4}/.test(cand)) return false;
    if (!/[aeiouy]/.test(cand)) return false;
    for (let i = 0; i + 2 < cand.length; i++) if (!trigrams.has(cand.slice(i, i + 3))) return false;
    if (headwords.has(cand) || forms.has(cand)) return false;
    if (dict.lookup(cand)) return false;
    for (const sub of SWEAR_SUBSTRINGS) if (cand.includes(sub)) return false;
    for (const nb of neighbours(cand)) if (headwords.has(nb) || forms.has(nb)) return false;
    return true;
  };

  const out: string[] = [];
  const seen = new Set<string>();
  if (sources.length === 0) return out;
  const maxAttempts = Math.max(20000, target * 300);
  for (let attempt = 0; attempt < maxAttempts && out.length < target; attempt++) {
    const src = sources[randInt(rng, sources.length)];
    const i = randInt(rng, src.syl.length);
    const part = PARTS[randInt(rng, PARTS.length)];
    const list = choices.get(inventoryKey(src.syl[i], i, src.syl.length, part));
    if (!list || list.length < 2) continue;
    const seg = list[randInt(rng, list.length)];
    if (seg === src.syl[i][part]) continue;
    const syl = src.syl.map((s) => ({ ...s }));
    syl[i][part] = seg;
    const cand = join(syl);
    if (seen.has(cand) || !isOk(cand, src.word)) continue;
    seen.add(cand);
    out.push(cand);
  }
  return out;
}
