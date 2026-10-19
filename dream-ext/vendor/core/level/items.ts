import type { CefrLevel } from '@core/model';
import type { DictData, DictRaw } from '@shared/api';
import { parseGloss, suffixCandidates } from '@core/dict/dictionary';
import type { Rng } from './rng';
import { shuffle } from './rng';

/**
 * Item pools for the vocabulary level test (docs/research/research-level-test.md, sections 3-4).
 *
 * Every headword of the dictionary is assigned to one of eight frequency bands by its COCA rank (`frq`,
 * falling back to the BNC rank), and the ones that make good yes/no items are kept: single lower-case
 * alphabetic tokens of 3-12 letters, base forms, content words, not names, abbreviations, swear words,
 * transparent derivations of a more frequent word or loans a Chinese speaker knows anyway. CEFR-tagged
 * words are preferred at selection time so the CEFR cross-check has data in every band.
 */

export interface Band {
  /** 0-based position in BANDS */
  index: number;
  /** inclusive rank range */
  lo: number;
  hi: number;
  /** number of lemmas the band stands for (hi - lo + 1) */
  width: number;
  /** "1-2k", "5-7k" ... */
  label: string;
}

const BAND_EDGES: readonly [number, number][] = [
  [1, 2000], [2001, 3000], [3001, 4000], [4001, 5000], [5001, 7000], [7001, 10000], [10001, 14000], [14001, 20000],
];

export const BANDS: readonly Band[] = BAND_EDGES.map(([lo, hi], index) => ({
  index, lo, hi, width: hi - lo + 1, label: `${lo <= 1 ? 1 : Math.round((lo - 1) / 1000)}-${hi / 1000}k`,
}));

/** Lemmas covered by all bands together (the largest size the test can report). */
export const MAX_RANK = BAND_EDGES[BAND_EDGES.length - 1][1];

/** The corpus rank used for banding: COCA `frq`, else BNC `bnc`, else 0 (unranked). */
export function rankOf(raw: Pick<DictRaw, 'f' | 'b'>): number {
  if (raw.f > 0) return raw.f;
  if (raw.b > 0) return raw.b;
  return 0;
}

/** Band index for a rank, or -1 when the rank is 0 or beyond the last band. */
export function bandOfRank(rank: number): number {
  if (!(rank > 0) || rank > MAX_RANK) return -1;
  for (const b of BANDS) if (rank <= b.hi) return b.index;
  return -1;
}

/** The band in which a vocabulary size (lemmas) falls: 0 for sizes up to 2,000, 7 for anything over 14,000. */
export function bandOfSize(lemmas: number): number {
  const v = Math.max(1, Math.min(MAX_RANK, Math.round(lemmas)));
  return bandOfRank(v);
}

export type ItemPos = 'n' | 'v' | 'adj' | 'adv';

export interface PoolItem {
  word: string;
  rank: number;
  band: number;
  pos: ItemPos;
  /** CEFR-J / Octanove level; null when the dictionary only estimated one */
  level: CefrLevel | null;
  /** Oxford 3000 or Collins 3+ stars: a "textbook" word */
  textbook: boolean;
}

export interface ItemPools {
  /** one array per band, in BANDS order, sorted by word (shuffle at selection time) */
  bands: PoolItem[][];
  /** candidates rejected per rule, for diagnostics */
  rejected: Record<string, number>;
}

export interface PoolOptions {
  /** lemmas to leave out, e.g. words the learner met in the last 30 days of reading */
  exclude?: Iterable<string>;
}

/* ------------------------------------------------------------------------------------------------
 * Word lists
 * ---------------------------------------------------------------------------------------------- */

/** Whole-word swear/taboo list: never shown as a test item. */
export const SWEAR_WORDS: ReadonlySet<string> = new Set([
  'fuck', 'fucker', 'fucking', 'shit', 'shitty', 'bullshit', 'cunt', 'bitch', 'bastard', 'asshole', 'arsehole',
  'arse', 'ass', 'dick', 'cock', 'prick', 'pussy', 'whore', 'slut', 'fag', 'faggot', 'nigger', 'negro', 'piss',
  'crap', 'damn', 'bugger', 'wank', 'wanker', 'twat', 'bollocks', 'tits', 'boobs', 'penis', 'vagina', 'retard',
  'retarded', 'spastic', 'dyke', 'chink', 'spic', 'kike', 'gook', 'paki', 'nazi', 'jizz', 'cum', 'semen', 'anal',
  'rape', 'rapist', 'molest', 'orgasm', 'erection', 'masturbate', 'porn', 'porno', 'pornography', 'hooker', 'pimp',
]);

/** Substrings that disqualify a generated pseudoword. */
export const SWEAR_SUBSTRINGS: readonly string[] = [
  'fuck', 'shit', 'cunt', 'nigg', 'fag', 'dick', 'piss', 'slut', 'whore', 'wank', 'twat', 'jizz', 'cock', 'tits',
  'arse', 'bitch', 'spic', 'kike', 'chink', 'gook', 'paki', 'retard', 'nazi', 'rape', 'porn', 'penis', 'anus',
];

/** Loans and culture words a Chinese speaker recognises without knowing English: no evidence of vocabulary size. */
export const CHINESE_LOANS: ReadonlySet<string> = new Set([
  'kungfu', 'kung', 'gongfu', 'tofu', 'typhoon', 'ketchup', 'wok', 'kowtow', 'lychee', 'litchi', 'ginseng', 'mahjong',
  'taichi', 'yin', 'yang', 'tao', 'taoism', 'taoist', 'zen', 'qigong', 'oolong', 'longan', 'ginkgo', 'cheongsam',
  'wonton', 'wuxia', 'yuan', 'renminbi', 'kaolin', 'kowloon', 'shanghai', 'beijing', 'peking', 'canton', 'cantonese',
  'mandarin', 'confucius', 'confucian', 'pinyin', 'dim', 'sum', 'chow', 'mein', 'bok', 'choy', 'feng', 'shui', 'tai',
  'chi', 'ramen', 'sushi', 'karaoke', 'kimono', 'ninja', 'samurai', 'tsunami', 'panda', 'bonsai', 'tycoon', 'manga',
  'anime', 'emoji', 'tatami', 'sake', 'kimchi', 'soju', 'taekwondo', 'judo', 'karate', 'sudoku', 'origami', 'haiku',
  'china', 'chinese', 'japan', 'japanese', 'korea', 'korean', 'asia', 'asian', 'taiwan', 'taiwanese', 'hongkong',
  'tibet', 'tibetan', 'mongol', 'mongolian', 'vietnam', 'vietnamese', 'thai', 'thailand', 'singapore',
]);

/* ------------------------------------------------------------------------------------------------
 * Classification helpers (exported for tests)
 * ---------------------------------------------------------------------------------------------- */

const WORD_RE = /^[a-z]{3,12}$/;
/** ECDICT marks inflections in the gloss ("give的过去分词", "child的复数") */
const INFLECTION_GLOSS_RE = /的?(过去式|过去分词|复数|现在分词|比较级|最高级|第三人称|单数)/;
/** Abbreviations: "abbr." tag, or a gloss that says so, or an "=expansion" gloss. */
const ABBREV_GLOSS_RE = /缩写|缩略|略语|简称|^=|\(=|（=/;
/** Proper nouns ECDICT lower-cased: explicit markers in the first gloss line. */
const PROPER_GLOSS_RE = /人名|地名|姓氏|\[姓\]|（姓）|\(姓\)|国名|州名|城市名|河名|山名|湖名|海名|首都|的首府|希腊字母|字母表的第/;
/** Common names, nationalities, languages, religions and calendar words ECDICT lists as plain lower-case headwords. */
export const PROPER_WORDS: ReadonlySet<string> = new Set([
  'english', 'england', 'britain', 'british', 'briton', 'london', 'scotland', 'scottish', 'scot', 'wales', 'welsh',
  'ireland', 'irish', 'america', 'american', 'usa', 'canada', 'canadian', 'australia', 'australian', 'mexico', 'mexican',
  'france', 'french', 'paris', 'germany', 'german', 'europe', 'european', 'spain', 'spanish', 'italy', 'italian',
  'russia', 'russian', 'india', 'indian', 'africa', 'african', 'greece', 'greek', 'rome', 'roman', 'latin', 'arab',
  'arabic', 'arabian', 'jew', 'jewish', 'christian', 'christ', 'jesus', 'muslim', 'islam', 'islamic', 'catholic',
  'protestant', 'buddhist', 'buddha', 'buddhism', 'hindu', 'bible', 'biblical', 'easter', 'christmas', 'halloween',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
  'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'atlantic', 'pacific', 'texas',
  'california', 'york', 'washington', 'boston', 'chicago', 'florida', 'virginia', 'georgia', 'victoria', 'elizabeth',
  'mary', 'john', 'james', 'george', 'david', 'michael', 'peter', 'paul', 'jack', 'henry', 'tom', 'bill', 'bob',
  'mark', 'sam', 'joe', 'jim', 'harry', 'alice', 'anna', 'anne', 'ann', 'jane', 'jean', 'joan', 'sarah', 'emma',
  'alexander', 'charles', 'william', 'richard', 'robert', 'thomas', 'edward', 'martin', 'smith', 'jones', 'brown',
  'johnson', 'williams', 'taylor', 'nato', 'nasa', 'olympic', 'olympics', 'oscar', 'nobel', 'hollywood', 'disney',
  'google', 'facebook', 'microsoft', 'ford', 'toyota',
]);

/** The primary part of speech of a gloss, or null when the entry is not a content word (or has no POS tag). */
export function contentPos(gloss: string): ItemPos | null {
  const lines = parseGloss(gloss);
  for (const line of lines) {
    const p = line.pos.toLowerCase();
    if (!p || p.startsWith('[') || p.startsWith('<')) continue;
    if (/^(n|pl)\./.test(p)) return 'n';
    if (/^(v|vt|vi|vbl)\./.test(p)) return 'v';
    if (/^(a|adj)\./.test(p)) return 'adj';
    if (/^adv\./.test(p)) return 'adv';
    // the first tagged sense is a function word, abbreviation, interjection ...
    return null;
  }
  return null;
}

/** Derivational suffixes beyond the inflectional ones `suffixCandidates` already proposes. */
const DERIV_SUFFIXES: readonly [string, string[]][] = [
  ['ness', ['', 'e', 'y']], ['ment', ['', 'e']], ['ful', ['', 'e']], ['less', ['', 'e']], ['ish', ['', 'e']],
  ['able', ['', 'e']], ['ible', ['', 'e']], ['ity', ['', 'e']], ['ist', ['', 'e', 'y']], ['ism', ['', 'e']],
  ['ous', ['', 'e']], ['ive', ['', 'e']], ['ly', ['', 'e']],
];

/** Stems that would make `word` a transparent derivation (quickly -> quick, happiness -> happy). */
export function derivationStems(word: string): string[] {
  const out = new Set<string>(suffixCandidates(word));
  for (const [suf, restores] of DERIV_SUFFIXES) {
    if (!word.endsWith(suf) || word.length - suf.length < 3) continue;
    const stem = word.slice(0, -suf.length);
    for (const r of restores) out.add(stem + r);
    if (stem.endsWith('i')) out.add(stem.slice(0, -1) + 'y');       // happi-ness -> happy
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) out.add(stem.slice(0, -1));
  }
  out.delete(word);
  return [...out];
}

/* ------------------------------------------------------------------------------------------------
 * Pool construction
 * ---------------------------------------------------------------------------------------------- */

export function buildItemPools(data: DictData, opts: PoolOptions = {}): ItemPools {
  const words = new Map<string, DictRaw>(Object.entries(data.w));
  const forms = new Map<string, string>(Object.entries(data.f));
  const exclude = new Set<string>(opts.exclude ? Array.from(opts.exclude, (w) => w.toLowerCase()) : []);
  const rejected: Record<string, number> = {};
  const reject = (why: string): null => { rejected[why] = (rejected[why] ?? 0) + 1; return null; };

  const bandOfWord = (w: string): number => {
    const raw = words.get(w);
    return raw ? bandOfRank(rankOf(raw)) : -1;
  };

  const classify = (word: string, raw: DictRaw): PoolItem | null => {
    if (!WORD_RE.test(word)) return null;                                   // not counted: phrases, hyphens, case
    const rank = rankOf(raw);
    const band = bandOfRank(rank);
    if (band < 0) return reject('rank');
    if (exclude.has(word)) return reject('excluded');
    const base = forms.get(word);
    if (base !== undefined && base !== word) return reject('inflection');
    const gloss = raw.t ?? '';
    if (INFLECTION_GLOSS_RE.test(gloss)) return reject('inflection');
    if (!raw.i || ABBREV_GLOSS_RE.test(gloss) || /^abbr\./i.test(gloss)) return reject('abbreviation');
    const pos = contentPos(gloss);
    if (!pos) return reject('pos');
    const tagged = raw.s === 'cefrj' || raw.s === 'oct';
    // untagged entries with no exam tag, Collins stars or Oxford flag are mostly lower-cased names ("fred", "aberdeen")
    if (!tagged && !(raw.g && raw.g.trim()) && !((raw.c | 0) > 0) && raw.o !== 1) return reject('unattested');
    if (PROPER_WORDS.has(word) || PROPER_GLOSS_RE.test(gloss.split('\n')[0])) return reject('proper');
    if (SWEAR_WORDS.has(word)) return reject('swear');
    if (CHINESE_LOANS.has(word)) return reject('loan');
    for (const stem of derivationStems(word)) {
      const sb = bandOfWord(stem);
      if (sb >= 0 && sb < band) return reject('derivation');
    }
    return {
      word, rank, band, pos,
      level: tagged ? (raw.l as CefrLevel) : null,
      textbook: raw.o === 1 || (raw.c | 0) >= 3,
    };
  };

  const bands: PoolItem[][] = BANDS.map(() => []);
  const keys = [...words.keys()].sort();
  for (const word of keys) {
    const item = classify(word, words.get(word)!);
    if (item) bands[item.band].push(item);
  }
  return { bands, rejected };
}

/* ------------------------------------------------------------------------------------------------
 * Selection
 * ---------------------------------------------------------------------------------------------- */

export interface PickOptions {
  /** words not to pick (already used in this or an earlier run); ignored when the pool would otherwise run dry */
  avoid?: ReadonlySet<string>;
  /** minimum share of nouns / verbs in the picked set (defaults 0.4 / 0.25, spec section 4.3) */
  minNounShare?: number;
  minVerbShare?: number;
  /** maximum share of textbook (Oxford/Collins) words when enough others exist (default 0.6) */
  maxTextbookShare?: number;
}

/**
 * Picks `n` items from one band's pool: CEFR-tagged words first, stratified by POS (>= 40% nouns, >= 25% verbs
 * when the pool allows) and capped on textbook words so the sample is not all Oxford-3000 entries. Deterministic
 * for a given rng.
 */
export function pickItems(pool: readonly PoolItem[], n: number, rng: Rng, opts: PickOptions = {}): PoolItem[] {
  if (n <= 0 || pool.length === 0) return [];
  const minNoun = Math.ceil(n * (opts.minNounShare ?? 0.4));
  const minVerb = Math.ceil(n * (opts.minVerbShare ?? 0.25));
  const maxTextbook = Math.max(1, Math.floor(n * (opts.maxTextbookShare ?? 0.6)));

  let candidates = pool;
  if (opts.avoid && opts.avoid.size) {
    const fresh = pool.filter((p) => !opts.avoid!.has(p.word));
    if (fresh.length >= n) candidates = fresh;
  }
  // tagged words first, each group shuffled
  const tagged = shuffle(candidates.filter((p) => p.level !== null), rng);
  const untagged = shuffle(candidates.filter((p) => p.level === null), rng);
  const ordered = tagged.concat(untagged);

  const picked: PoolItem[] = [];
  const used = new Set<string>();
  let textbook = 0;
  const take = (pred: (p: PoolItem) => boolean, count: number, strict: boolean): void => {
    for (const p of ordered) {
      if (picked.length >= n || count <= 0) return;
      if (used.has(p.word) || !pred(p)) continue;
      if (strict && p.textbook && textbook >= maxTextbook) continue;
      used.add(p.word); picked.push(p); count--;
      if (p.textbook) textbook++;
    }
  };
  // quotas with the textbook cap, then quotas without it, then fill
  take((p) => p.pos === 'n', minNoun, true);
  take((p) => p.pos === 'v', minVerb, true);
  take((p) => p.pos === 'n', minNoun - picked.filter((p) => p.pos === 'n').length, false);
  take((p) => p.pos === 'v', minVerb - picked.filter((p) => p.pos === 'v').length, false);
  take(() => true, n - picked.length, true);
  take(() => true, n - picked.length, false);
  return shuffle(picked, rng);
}
