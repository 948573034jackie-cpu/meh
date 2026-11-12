import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { realDictionary } from './helpers';
import { textBook, orderOf } from '../src/reader-text';
import { unknownChance, SEED } from '../src/level-db';
import { scoreSentences, selectStopsByLevel } from '../src/level-stops';
import { wordNumber, phraseDifficulty, harderThan } from '../src/level100';

const dict = realDictionary();
const table = new Map<string, number>();
for (const [z, words] of Object.entries(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, '../../youtube-to-claude/dream/zipf.json.gz'))).toString('utf8')) as Record<string, string>)) for (const w of words.split(' ')) table.set(w, Number(z) / 10);
const zipf = (w: string) => table.get(w.toLowerCase()) ?? null;

const LINES = [
  'Hello everyone and welcome back to the channel.',
  'Today my friend was very meticulous about her work.',
  'She walked to the shop and bought some bread.',
  'It was an ephemeral moment of joy.',
  'The children played in the garden after school.',
  'My uncle is a gregarious man who loves big parties.',
  'We had a nice dinner with our family.',
  "I don't think we should go to the park today.",
];
const book = textBook('t', 'Lesson', LINES.join('\n\n'), 'text');
const order = orderOf(book);
const stops = (level: number, status: (l: string) => 'known' | 'learning' | 'ignored' | undefined = () => undefined, on = { word: 1, phrase: 1, sentence: 1 }, hard: string[] = []) => {
  const list = scoreSentences({
    book, order, dict, names: new Set(), status, phraseDone: () => false, phrases: {}, hard: new Set(hard), chance: unknownChance(SEED.tests), zipf,
    harder: (kind, text, lemma, cefr) => { if (kind === 'phrase') return harderThan(phraseDifficulty(cefr), level); const n = wordNumber(zipf(text), zipf(lemma), cefr); return n !== null && harderThan(n, level); },
  });
  const set = selectStopsByLevel(list, on);
  return { lines: LINES.filter((_, i) => set.has(list[i].key)), list };
};

describe('THE RULE with one level 0-100: the tutor stops only for what is harder than my level', () => {
  it('level 56 (about B2): only the sentences with a really hard word stop; easy sentences never', () => {
    const r = stops(56);
    expect(r.lines).toEqual([LINES[1], LINES[3], LINES[5]]);
    expect(r.list[1].items).toEqual(['meticulous']);
    expect(r.list[2].items).toEqual([]);
    expect(r.list[4].items).toEqual([]);
  });
  it('a higher level stops for less, a lower level for more; 100 = nothing is harder, so nothing stops', () => {
    expect(stops(100).lines).toEqual([]);
    expect(stops(79).lines).toEqual([LINES[3]]);                 // only "ephemeral" (80) is harder than 79
    expect(stops(75).lines).toEqual([LINES[1], LINES[3]]);       // "meticulous" (78) too; "gregarious" (73) not
    const low = stops(30).lines;
    for (const l of [LINES[1], LINES[3], LINES[5], LINES[4], LINES[6]]) expect(low).toContain(l);   // "garden", "dinner" (42) are harder than 30
    // moving the level down never takes a stop away
    for (const l of stops(56).lines) expect(low).toContain(l);
  });
  it('a word I know never stops, whatever its number; a word I am still learning stops, whatever its number', () => {
    expect(stops(56, (l) => (l === 'meticulous' ? 'known' : undefined)).lines).toEqual([LINES[3], LINES[5]]);
    expect(stops(56, (l) => (l === 'bread' ? 'learning' : undefined)).lines).toContain(LINES[2]);
    expect(stops(100, (l) => (l === 'bread' ? 'learning' : undefined)).lines).toEqual([LINES[2]]);
  });
  it('a contraction is never a hard word', () => {
    expect(stops(0).list[7].items).not.toContain("don't");
  });
  it('the three switches: Words off = no stop for a word; Sentences on = a hard sentence stops (and only a hard one)', () => {
    expect(stops(56, undefined, { word: 0, phrase: 1, sentence: 1 }).lines).toEqual([]);
    const key = (i: number) => stops(56).list[i].key;
    expect(stops(56, undefined, { word: 0, phrase: 0, sentence: 1 }, [key(2)]).lines).toEqual([LINES[2]]);
    expect(stops(56, undefined, { word: 1, phrase: 1, sentence: 0 }, [key(2)]).lines).toEqual([LINES[1], LINES[3], LINES[5]]);
  });
});
