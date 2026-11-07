import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import type { CefrLevel } from '@core/model';
import type { Dictionary, DictEntry } from '@core/dict/types';
import { realDictionary } from './helpers';
import { videoLevel, suggestLevelFor, cefrOf } from '../src/video-level';
import { buildVideoBook } from '../src/video-book';

function realZipf(): (w: string) => number | null {
  const gz = fs.readFileSync(path.resolve(__dirname, '../../youtube-to-claude/dream/zipf.json.gz'));
  const table = new Map<string, number>();
  for (const [z, words] of Object.entries(JSON.parse(zlib.gunzipSync(gz).toString('utf8')) as Record<string, string>)) for (const w of words.split(' ')) table.set(w, Number(z) / 10);
  return (w) => table.get(w.toLowerCase()) ?? null;
}

/** a tiny dictionary: word -> level */
function fakeDict(levels: Record<string, CefrLevel>): Dictionary {
  const entry = (word: string, level: CefrLevel): DictEntry => ({ word, ipa: '', zh: '词', tags: [], frq: 1000, bnc: 1000, collins: 3, oxford: true, level, levelSource: 'cefrj' });
  return {
    size: Object.keys(levels).length,
    lookup(token) { const w = token.toLowerCase(); return levels[w] ? { entry: entry(w, levels[w]), lemma: w, via: 'exact' } : null; },
    lookupPhrase: () => null,
    lemmaOf: (t) => t.toLowerCase(),
  };
}

describe('videoLevel (fake dictionary)', () => {
  const dict = fakeDict({ the: 'A1', cat: 'A1', sat: 'A1', on: 'A1', mat: 'A2', a: 'A1', was: 'A1', it: 'A1', very: 'A1', ubiquitous: 'C2', meticulous: 'C1', happy: 'A1' });
  const easy = Array.from({ length: 10 }, () => 'The cat sat on the mat.'); // 60 words, all A1/A2
  it('the level where about 95% of the words are covered', () => {
    const r = videoLevel(easy, dict)!;
    expect(r.words).toBe(60);
    expect(r.coverage.A1).toBeCloseTo(50 / 60, 2);
    expect(r.coverage.A2).toBe(1);
    expect(r.level).toBe('A2');
  });
  it('a few hard words lift it; many lift it more', () => {
    const some = [...easy, 'It was ubiquitous.', 'It was meticulous.'];
    const r = videoLevel(some, dict)!;
    // 66 words: 2 above A2 = 97% covered at A2
    expect(r.level).toBe('A2');
    const many = [...easy, ...Array.from({ length: 5 }, () => 'It was very ubiquitous.')];
    const r2 = videoLevel(many, dict)!;
    expect(r2.level).toBe('C2');
    expect(r2.coverage.C1).toBeLessThan(0.95);
  });
  it('names, numbers and punctuation do not count; too little text = null', () => {
    const r = videoLevel([...easy, 'The cat sat on 25 mats with Zorblax.'], dict)!;
    expect(r.words).toBe(60 + 6); // the, cat, sat, on, mats (no level: common), with (no level: common); not 25, not Zorblax
    expect(videoLevel(['The cat sat.'], dict)).toBeNull();
  });
  it('a word with no level is common, unless the word table says it is rare (unknown to it = skipped)', () => {
    const z = (w: string) => ({ the: 7, cat: 5, sat: 5, on: 7, mat: 4, a: 7, was: 7, it: 7, florp: 1.5 } as Record<string, number>)[w.toLowerCase()] ?? null;
    const text = [...easy, ...Array.from({ length: 6 }, () => 'It was a florp.')];
    expect(videoLevel(text, dict)!.level).toBe('A2'); // florp = common
    expect(videoLevel(text, dict, new Set(), { zipf: z })!.level).toBe('C1'); // florp = rare
    expect(videoLevel([...easy, 'It was a qwzx.'], dict, new Set(), { zipf: z })!.words).toBe(63); // qwzx: not counted
  });
  it('hard for you: words above the learner level that are not known', () => {
    const text = [...easy, ...Array.from({ length: 4 }, () => 'It was meticulous.')]; // 72 words, 4 x C1
    expect(videoLevel(text, dict, new Set(), { learner: 'B2' })!.hardForYou).toBeCloseTo(4 / 72, 3);
    expect(videoLevel(text, dict, new Set(), { learner: 'B2', known: new Set(['meticulous']) })!.hardForYou).toBe(0);
    expect(videoLevel(text, dict, new Set(), { learner: 'about lower B2 for reading', known: (l) => l === 'meticulous' })!.hardForYou).toBe(0);
    expect(videoLevel(text, dict)!.hardForYou).toBeUndefined();
  });
});

describe('videoLevel (real dictionary)', () => {
  const dict = realDictionary(), zipf = realZipf();
  const sents = (t: string) => t.split(/(?<=[.?!])\s+/);
  const KIDS = `hello everyone. today we are going to the park. i like the park. it is big and green. my dog likes the park too. he runs and plays. we eat apples and drink water. the sun is hot. we sit under a tree. my mom reads a book. my sister plays with a ball. it is a good day. we go home at five. i am happy. do you like the park? see you next time.`;
  const VLOG = `so guys today i wanna show you my morning routine. okay so first thing i do when i wake up is i drink a big glass of water, because honestly it really helps me feel awake. then i usually make some coffee and just kind of sit by the window for a few minutes. i know it sounds boring but it actually makes a huge difference to my mood. after that i go to the gym, which is like ten minutes from my apartment. i've been trying to be more consistent with it this year. anyway, then i come back, take a shower, and start working. let me know in the comments what your morning looks like.`;
  const TALK = `what i want to talk about today is the relationship between creativity and constraint. we often assume that freedom is the precondition for innovation, but the evidence suggests something rather different. when musicians are given a limited palette, a restricted set of notes or a strict rhythmic framework, they frequently produce work that is more original, not less. the constraint forces them to abandon their habitual patterns and to explore unfamiliar territory. so the question becomes: how do we deliberately design constraints that provoke rather than stifle our imagination?`;
  const ACADEMIC = `the epistemological ramifications of this paradigm are manifold. insofar as the hermeneutic tradition privileges interpretation over explanation, it presupposes an ontology in which meaning is irreducibly contingent upon the interlocutors' situatedness. consequently, any purportedly objective methodology is vulnerable to the critique that it surreptitiously reifies the very categories it purports to interrogate. this tension is exacerbated by the proliferation of quantitative heuristics, whose ostensible neutrality obfuscates their normative underpinnings.`;
  it('orders texts from easy to hard', () => {
    const lv = (t: string) => videoLevel(sents(t), dict, new Set(), { zipf })!.level;
    expect(lv(KIDS)).toBe('A1');
    expect(['A2', 'B1']).toContain(lv(VLOG));
    expect(['B2', 'C1']).toContain(lv(TALK));
    expect(lv(ACADEMIC)).toBe('C2');
  });
  it('works on a video book built from subtitle sentences', () => {
    const vb = buildVideoBook({ id: 'abcdefghijk', title: 't' }, sents(VLOG).map((text, i) => ({ start: i * 4, end: i * 4 + 3.5, text })));
    const a = videoLevel(vb, dict, new Set(), { zipf })!;
    const b = videoLevel(sents(VLOG), dict, new Set(), { zipf })!;
    expect(a.level).toBe(b.level);
    expect(a.words).toBe(b.words);
  });
});

describe('suggestLevelFor', () => {
  it('the learner level, or one up for a little challenge', () => {
    expect(suggestLevelFor('B2')).toBe('B2');
    expect(suggestLevelFor('about lower B2 for reading')).toBe('B2');
    expect(suggestLevelFor('upper B2', true)).toBe('C1');
    expect(suggestLevelFor('C2', true)).toBe('C2');
    expect(suggestLevelFor('')).toBe('B1');
    expect(cefrOf('a1')).toBe('A1');
  });
});
