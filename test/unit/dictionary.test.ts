import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DictData, DictRaw } from '@shared/api';
import {
  createDictionary, normalizeToken, foldAccents, stripPossessive, suffixCandidates, parseGloss, firstGloss,
} from '@core/dict/dictionary';
import type { DictEntry } from '@core/dict/types';

// Real data, loaded once per test file (~7 MB of JSON).
const DATA_PATH = fileURLToPath(new URL('../../resources/dict/dict.json.gz', import.meta.url));
const data = JSON.parse(gunzipSync(readFileSync(DATA_PATH)).toString('utf8')) as DictData;
const dict = createDictionary(data);

/** Builds a tiny DictData from headwords (+ optional raw overrides) and an inflection map. */
function synth(words: Record<string, Partial<DictRaw> | null>, forms: Record<string, string> = {}): DictData {
  const w: Record<string, DictRaw> = {};
  for (const [k, o] of Object.entries(words)) {
    w[k] = { i: '', t: `n. ${k}`, g: '', f: 100, b: 100, c: 0, o: 0, l: 'A1', s: 'cefrj', ...(o ?? {}) };
  }
  return { w, f: forms };
}

describe('normalisation helpers', () => {
  it('normalizeToken trims, lower-cases, straightens apostrophes and strips surrounding punctuation', () => {
    expect(normalizeToken('  "Hello,"  ')).toBe('hello');
    expect(normalizeToken('Darcy’s')).toBe("darcy's");
    expect(normalizeToken('(well-known)')).toBe('well-known');
    expect(normalizeToken("parents'.")).toBe("parents'");   // trailing apostrophe after a letter is kept
    expect(normalizeToken("'tis")).toBe('tis');             // leading apostrophe is not
    expect(normalizeToken("hello.'")).toBe('hello');        // apostrophe not after a letter is punctuation
    expect(normalizeToken('—')).toBe('');
    expect(normalizeToken('look   forward\tto')).toBe('look forward to');
  });

  it('foldAccents removes diacritics and maps ligatures', () => {
    expect(foldAccents('façade')).toBe('facade');
    expect(foldAccents('naïve')).toBe('naive');
    expect(foldAccents('résumé')).toBe('resume');
    expect(foldAccents('straße')).toBe('strasse');
    expect(foldAccents('plain')).toBe('plain');
  });

  it('stripPossessive handles both possessive forms', () => {
    expect(stripPossessive("darcy's")).toBe('darcy');
    expect(stripPossessive("parents'")).toBe('parents');
    expect(stripPossessive('darcy')).toBeNull();
    expect(stripPossessive("'s")).toBeNull();
  });

  it('suffixCandidates proposes stems most-specific first and never strips -ness/-ment', () => {
    expect(suffixCandidates('running')).toContain('run');
    expect(suffixCandidates('making')).toContain('make');
    expect(suffixCandidates('cities')).toEqual(['citie', 'city']);
    expect(suffixCandidates('tried')).toEqual(['trie', 'try']);
    expect(suffixCandidates('lying')[0]).toBe('lie');
    expect(suffixCandidates('kindness')).toEqual([]);
    expect(suffixCandidates('movement')).toEqual([]);
    expect(suffixCandidates('kiss')).toEqual([]);           // -ss is not a plural
    expect(suffixCandidates('Running')).toEqual([]);        // expects normalised input
  });
});

describe('createDictionary with synthetic data (spelling rules in isolation)', () => {
  const synthData = synth(
    {
      run: null, make: null, city: null, try: null, lie: null, big: null, happy: null, quick: null, gentle: null, travel: null,
      full: null, box: null, go: null, shoe: null, kind: null, kindness: null, die: null, bus: null, writ: null,
      ly: null, basic: null, movie: null, sky: null, fill: null, kiss: null, control: null, cafe: null, tomorrow: null,
      cooperate: null, child: null, children: { l: 'B2', s: 'est', f: 0 }, boring: { l: 'A1', s: 'cefrj' },
      bore: { l: 'B1', s: 'cefrj' }, good: null, better: { l: 'A1', s: 'cefrj' }, "don't": null,
      look: null, give: null, despicable: null, 'look forward to': null, 'in spite of': null, 'give up': null, 'a bit': null,
    },
    { went: 'go', children: 'child', boring: 'bore', better: 'good', looked: 'look', gave: 'give' },
  );
  const d = createDictionary(synthData);

  it('exact headwords', () => {
    expect(d.lookup('run')).toMatchObject({ lemma: 'run', via: 'exact' });
    expect(d.lookup('Run!')).toMatchObject({ lemma: 'run', via: 'exact' });
    expect(d.lookup("don’t")).toMatchObject({ lemma: "don't", via: 'exact' });
    expect(d.lookup('')).toBeNull();
    expect(d.lookup('   ')).toBeNull();
    expect(d.lookup('__proto__')).toBeNull();
    expect(d.lookup('constructor')).toBeNull();
    expect(d.lookup('toString')).toBeNull();
  });

  it('possessives', () => {
    expect(d.lookup("city's")).toMatchObject({ lemma: 'city', via: 'possessive' });
    expect(d.lookup("Cities'")).toMatchObject({ lemma: 'city', via: 'suffix' });   // deeper step reported
  });

  it('inflection map, including headwords that are listed inflections of another headword', () => {
    expect(d.lookup('went')).toMatchObject({ lemma: 'go', via: 'form' });
    // 'children' has only an estimated level: the base entry is used
    const ch = d.lookup('children')!;
    expect(ch.lemma).toBe('child');
    expect(ch.entry.word).toBe('child');
    expect(ch.via).toBe('form');
    // 'boring' is a real CEFR-listed item: its own entry is kept but the vocabulary lemma is still 'bore'
    const bo = d.lookup('boring')!;
    expect(bo.lemma).toBe('bore');
    expect(bo.entry.word).toBe('boring');
    expect(bo.entry.level).toBe('A1');
    expect(bo.via).toBe('exact');
    expect(d.lookup('better')).toMatchObject({ lemma: 'good', via: 'exact' });
  });

  it('suffix stripping with English spelling rules', () => {
    const lemma = (t: string) => d.lookup(t)?.lemma ?? null;
    const via = (t: string) => d.lookup(t)?.via ?? null;
    expect(lemma('runs')).toBe('run');
    expect(lemma('boxes')).toBe('box');
    expect(lemma('goes')).toBe('go');
    expect(lemma('shoes')).toBe('shoe');
    expect(lemma('buses')).toBe('bus');
    expect(lemma('cities')).toBe('city');
    expect(lemma('movies')).toBe('movie');
    expect(lemma('skies')).toBe('sky');
    expect(lemma('dies')).toBe('die');
    expect(lemma('tried')).toBe('try');
    expect(lemma('died')).toBe('die');
    expect(lemma('filled')).toBe('fill');
    expect(lemma('kissed')).toBe('kiss');
    expect(lemma('controlled')).toBe('control');
    expect(lemma('running')).toBe('run');       // doubled consonant
    expect(lemma('making')).toBe('make');       // dropped e
    expect(lemma('lying')).toBe('lie');         // -ying, and not the fake headword 'ly'
    expect(lemma('bigger')).toBe('big');
    expect(lemma('biggest')).toBe('big');
    expect(lemma('happier')).toBe('happy');
    expect(lemma('happiest')).toBe('happy');
    expect(lemma('quickly')).toBe('quick');
    expect(lemma('happily')).toBe('happy');
    expect(lemma('gently')).toBe('gentle');
    expect(lemma('fully')).toBe('full');
    expect(lemma('basically')).toBe('basic');
    expect(lemma('despicably')).toBe('despicable');
    expect(lemma('travelling')).toBe('travel');
    expect(via('running')).toBe('suffix');
    // -ly only when the stem exists; -ness / -ment never
    expect(lemma('kindly')).toBe('kind');
    expect(lemma('bigly')).toBe('big');          // the stem exists, so -ly is stripped
    expect(lemma('zorply')).toBeNull();           // no such stem
    expect(lemma('kindnesses')).toBe('kindness');  // plural of a -ness word is fine, the -ness itself stays
    expect(lemma('runment')).toBeNull();
    expect(lemma('xyzzy')).toBeNull();
  });

  it('accent folding and hyphen joining report via fold', () => {
    expect(d.lookup('café')).toMatchObject({ lemma: 'cafe', via: 'fold' });
    expect(d.lookup('Cafés')).toMatchObject({ lemma: 'cafe', via: 'fold' });
    expect(d.lookup('to-morrow')).toMatchObject({ lemma: 'tomorrow', via: 'fold' });
    expect(d.lookup('co-operate')).toMatchObject({ lemma: 'cooperate', via: 'fold' });
  });

  it('lemmaOf falls back to the folded, lower-cased, possessive-stripped token', () => {
    expect(d.lemmaOf('Running')).toBe('run');
    expect(d.lemmaOf("Darcy’s")).toBe('darcy');
    expect(d.lemmaOf('Façades!')).toBe('facades');
    expect(d.lemmaOf('')).toBe('');
  });

  it('lookupPhrase: exact, lemmatised and rejected', () => {
    expect(d.lookupPhrase(['look', 'forward', 'to'])).toMatchObject({ lemma: 'look forward to', via: 'exact' });
    expect(d.lookupPhrase(['Looked', 'forward', 'to'])).toMatchObject({ lemma: 'look forward to', via: 'form' });
    expect(d.lookupPhrase(['gave', 'up'])).toMatchObject({ lemma: 'give up', via: 'form' });
    expect(d.lookupPhrase(['In', 'spite', 'of'])).toMatchObject({ lemma: 'in spite of', via: 'exact' });
    expect(d.lookupPhrase(['a', 'bit'])).not.toBeNull();
    expect(d.lookupPhrase(['run', 'city'])).toBeNull();
    expect(d.lookupPhrase(['run'])).toBeNull();
    expect(d.lookupPhrase(['a', 'b', 'c', 'd', 'e', 'f'])).toBeNull();
    expect(d.lookupPhrase(['look', '', 'to'])).toBeNull();
  });

  it('size counts headwords including phrases', () => {
    expect(d.size).toBe(Object.keys(synthData.w).length);
    expect(d.size).toBeGreaterThan(40);
  });
});

describe('createDictionary with real data', () => {
  it('loads the full dictionary', () => {
    expect(dict.size).toBeGreaterThan(49_000);
    expect(dict.size).toBe(Object.keys(data.w).length);
  });

  it('lemmatises common inflections', () => {
    expect(dict.lookup('running')!.lemma).toBe('run');
    expect(dict.lookup('children')!.lemma).toBe('child');
    expect(dict.lookup('children')!.entry.level).toBe('A1');   // not the estimated B2 of the 'children' entry
    expect(dict.lookup('went')).toMatchObject({ lemma: 'go', via: 'form' });
    // 'better' is its own A1 headword (kept as the entry) and a listed form of 'good' (the vocabulary lemma)
    const better = dict.lookup('better')!;
    expect(better.lemma).toBe('good');
    expect(better.entry.word).toBe('better');
    expect(dict.lookup('stopped')!.lemma).toBe('stop');
    expect(dict.lookup('stopped')!.entry.level).toBe('A1');    // the 'stopped' entry itself is an estimated C2
    expect(dict.lookup('Parents’')!.lemma).toBe('parent');
    expect(dict.lookup('makes')!.lemma).toBe('make');
    expect(dict.lookup('lying')!.lemma).toBe('lie');
  });

  it('uses suffix rules for inflections the data does not list', () => {
    // these surface forms are in neither the headword nor the inflection map (verified against the data)
    for (const t of ['acrimoniously', 'counterattacking', 'finessing', 'finessed', 'atlases', 'cheesier', 'cheesiest', 'blurrily', 'despicably']) {
      expect(data.w[t]).toBeUndefined();
      expect(data.f[t]).toBeUndefined();
    }
    expect(dict.lookup('acrimoniously')).toMatchObject({ lemma: 'acrimonious', via: 'suffix' });
    expect(dict.lookup('counterattacking')).toMatchObject({ lemma: 'counterattack', via: 'suffix' });
    expect(dict.lookup('finessing')).toMatchObject({ lemma: 'finesse', via: 'suffix' });
    expect(dict.lookup('finessed')).toMatchObject({ lemma: 'finesse', via: 'suffix' });
    expect(dict.lookup('atlases')).toMatchObject({ lemma: 'atlas', via: 'suffix' });
    expect(dict.lookup('cheesier')).toMatchObject({ lemma: 'cheesy', via: 'suffix' });
    expect(dict.lookup('cheesiest')).toMatchObject({ lemma: 'cheesy', via: 'suffix' });
    expect(dict.lookup('blurrily')).toMatchObject({ lemma: 'blurry', via: 'suffix' });
    expect(dict.lookup('despicably')).toMatchObject({ lemma: 'despicable', via: 'suffix' });
  });

  it('handles names, accents and odd input without crashing', () => {
    // 'darcy' is not in this data set at all (ECDICT proper would gloss it as a permeability unit)
    expect(dict.lookup("Darcy's")).toBeNull();
    expect(dict.lemmaOf("Darcy's")).toBe('darcy');
    expect(dict.lookup('façade')).toMatchObject({ lemma: 'facade', via: 'fold' });
    expect(dict.lookup('naïve')).toMatchObject({ lemma: 'naive', via: 'fold' });
    expect(dict.lookup('fiancée')).toMatchObject({ lemma: 'fiancee', via: 'fold' });
    expect(dict.lookup('to-morrow')).toMatchObject({ lemma: 'tomorrow', via: 'fold' });
    expect(dict.lookup('well-known')).toMatchObject({ lemma: 'well-known', via: 'exact' });
    expect(dict.lookup('—')).toBeNull();
    expect(dict.lookup('12')).toBeNull();
    expect(dict.lookup("don’t")).toMatchObject({ lemma: "don't", via: 'exact' });
  });

  it('exposes CEFR levels and entry fields', () => {
    const ub = dict.lookup('ubiquitous')!;
    expect(['B2', 'C1', 'C2']).toContain(ub.entry.level);
    expect(ub.entry.level).toBe(data.w.ubiquitous.l);
    const house = dict.lookup('house')!;
    expect(['A1', 'A2']).toContain(house.entry.level);
    expect(house.entry).toMatchObject({ word: 'house', oxford: true, collins: 5, levelSource: 'cefrj' });
    expect(house.entry.tags).toEqual(['zk', 'gk', 'toefl', 'ielts']);
    expect(house.entry.ipa).toBe('/haus/');
    expect(dict.lookup('the')!.entry.ipa).toBe('/ðə/');   // unbalanced slash in the data is repaired
    expect(dict.lookup('the')!.entry.frq).toBe(1);
    expect(dict.lookup('mr')!.entry.zh).toBe('');
  });

  it('returns the same entry object for repeated lookups', () => {
    expect(dict.lookup('house')!.entry).toBe(dict.lookup('House')!.entry);
  });

  it('finds multi-word phrases present in the data', () => {
    const phraseKeys = Object.keys(data.w).filter((k) => k.includes(' '));
    expect(phraseKeys.length).toBeGreaterThan(500);
    expect(data.w['give up']).toBeUndefined();          // not in this data set; use phrases that are
    expect(data.w['look forward to']).toBeDefined();
    expect(data.w['in spite of']).toBeDefined();
    expect(dict.lookupPhrase(['look', 'forward', 'to'])).toMatchObject({ lemma: 'look forward to', via: 'exact' });
    expect(dict.lookupPhrase(['Looking', 'forward', 'to'])).toMatchObject({ lemma: 'look forward to', via: 'form' });
    expect(dict.lookupPhrase(['In', 'spite', 'of'])).toMatchObject({ lemma: 'in spite of', via: 'exact' });
    expect(dict.lookupPhrase(['according', 'to'])).toMatchObject({ lemma: 'according to' });
    expect(dict.lookupPhrase(['the', 'house'])).toBeNull();
    expect(dict.lookupPhrase(['green', 'house', 'door'])).toBeNull();
    // every phrase key in the data is found by its own words
    for (const k of phraseKeys.slice(0, 200)) expect(dict.lookupPhrase(k.split(' '))?.lemma).toBe(k);
  });

  it('is fast enough for whole-book analysis', () => {
    const tokens = ['The', 'acrimoniously', 'children', 'went', "Darcy's", 'façade', 'running', 'xyzzyfoo', 'unbelievably', 'houses'];
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (dict.lookup(tokens[i % tokens.length])) hits++;
    const ms = performance.now() - t0;
    expect(hits).toBe(20_000 / tokens.length * 8);
    expect(ms).toBeLessThan(2_000);   // ~0.01 ms per lookup on a laptop; generous bound to avoid flakiness
  });
});

describe('gloss helpers', () => {
  it('parseGloss splits lines and leading POS tags', () => {
    expect(parseGloss('n. 房子, 住宅\nvt. 给...房子住\nvi. 住, 躲藏')).toEqual([
      { pos: 'n.', zh: '房子, 住宅' }, { pos: 'vt.', zh: '给...房子住' }, { pos: 'vi.', zh: '住, 躲藏' },
    ]);
    expect(parseGloss('a. 温和的\n[医] 温和的\n[网络] 文雅')).toEqual([
      { pos: 'a.', zh: '温和的' }, { pos: '[医]', zh: '温和的' }, { pos: '[网络]', zh: '文雅' },
    ]);
    expect(parseGloss('vt.& vi. 跑\nad. 快地\nprep. 在\nconj. 和')).toEqual([
      { pos: 'vt.&vi.', zh: '跑' }, { pos: 'ad.', zh: '快地' }, { pos: 'prep.', zh: '在' }, { pos: 'conj.', zh: '和' },
    ]);
    expect(parseGloss(' 期望, 盼望; 瞩望')).toEqual([{ pos: '', zh: '期望, 盼望; 瞩望' }]);
    expect(parseGloss('abide的过去式和过去分词')).toEqual([{ pos: '', zh: 'abide的过去式和过去分词' }]);
    expect(parseGloss('第一个字母 A; 一个\r')).toEqual([{ pos: '', zh: '第一个字母 A; 一个' }]);
    expect(parseGloss('')).toEqual([]);
    expect(parseGloss('\n\n')).toEqual([]);
    expect(parseGloss(dict.lookup('run')!.entry.zh)[0]).toEqual({ pos: 'n.', zh: '跑, 赛跑, 奔跑, 奔跑的路程, 趋向, 流出, 运转时间, 连续' });
  });

  it('firstGloss returns the first sense line, truncated at a sense boundary', () => {
    const house = dict.lookup('house')!.entry;
    expect(firstGloss(house, 200)).toBe('n. 房子, 住宅, 机构, 议院, 家族, 家庭');
    const short = firstGloss(house, 12);
    expect(short.length).toBeLessThanOrEqual(12);
    expect(short).toBe('n. 房子, 住宅…');
    expect(firstGloss(house)).toBe('n. 房子, 住宅, 机构, 议院, 家族, 家庭');
    expect(firstGloss({ zh: '' })).toBe('');
    expect(firstGloss(null)).toBe('');
    expect(firstGloss({ zh: '\n[医] 儿童' })).toBe('[医] 儿童');
    const e: DictEntry = dict.lookup('mr')!.entry;
    expect(firstGloss(e)).toBe('');
    // hard cut when there is no separator early enough
    expect(firstGloss({ zh: 'n. 无所不在的到处存在的普遍存在的' }, 8)).toBe('n. 无所不在…');
  });
});
