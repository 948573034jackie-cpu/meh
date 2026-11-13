import { describe, it, expect } from 'vitest';
import { belowLevel, shareOf, clampPct, cefrToLevel, levelToCefr } from '../src/level100';
import { keepHardest, selectStopsByLevel, type SentenceScore } from '../src/level-stops';

const sc = (index: number, items: [string, 'word' | 'phrase'][], hard = false, score = 1): SentenceScore => ({
  key: `0:0:${index}`, index, score, items: items.map((i) => i[0]), lemmas: items.map((i) => i[0]), kinds: items.map((i) => i[1]), hard, kind: items.some((i) => i[1] === 'word') ? 'word' : items.length ? 'phrase' : 'sentence',
});
const ON = { word: 1, phrase: 1, sentence: 1 };

describe('I Know 3.9: my level (A1–C2) and how much to explain (0–100 %)', () => {
  it('nothing below my level: a school level under mine never counts', () => {
    expect(belowLevel('B1', 'B2')).toBe(true);
    expect(belowLevel('A2', 'C1')).toBe(true);
    expect(belowLevel('B2', 'B2')).toBe(false);
    expect(belowLevel('C1', 'B2')).toBe(false);
    expect(belowLevel(undefined, 'B2')).toBe(false); // (no school level: the number decides)
  });
  it('each school level has its number, and the number gives the level back', () => {
    for (const l of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) expect(levelToCefr(cefrToLevel(l))).toBe(l);
  });
  it('the share: 0 = none, 100 = all, anything above 0 keeps at least one', () => {
    expect(shareOf(10, 0)).toBe(0);
    expect(shareOf(10, 100)).toBe(10);
    expect(shareOf(10, 50)).toBe(5);
    expect(shareOf(10, 5)).toBe(1);
    expect(shareOf(3, 30)).toBe(1);
    expect(shareOf(0, 80)).toBe(0);
    expect(clampPct(140)).toBe(100);
    expect(clampPct(-3)).toBe(0);
    expect(clampPct(undefined)).toBe(100);
  });
  const numbers: Record<string, number> = { easyish: 52, mid: 60, hard: 75, hardest: 92, idiom: 62, slang: 80 };
  const list = [sc(0, [['easyish', 'word']]), sc(1, [['mid', 'word'], ['idiom', 'phrase']]), sc(2, [['hard', 'word']]), sc(3, [['hardest', 'word'], ['slang', 'phrase']]), sc(4, [], true, 2), sc(5, [], true, 1)];
  const n = (l: string) => numbers[l] ?? 0;
  it('100 % explains everything at my level or above', () => {
    const all = keepHardest(list, 100, n, () => false);
    expect(selectStopsByLevel(all, ON).size).toBe(6);
  });
  it('50 % keeps the harder half of each kind: the hardest words, the hardest phrase, the hardest sentence', () => {
    const half = keepHardest(list, 50, n, () => false);
    expect(half.flatMap((s) => s.lemmas).sort()).toEqual(['hard', 'hardest', 'slang']);
    expect(half.filter((s) => s.hard).map((s) => s.index)).toEqual([4]);
    expect([...selectStopsByLevel(half, ON)].sort()).toEqual(['0:0:2', '0:0:3', '0:0:4']);
  });
  it('a low number keeps only the very hardest; 0 explains nothing', () => {
    const few = keepHardest(list, 10, n, () => false);
    expect(few.flatMap((s) => s.lemmas).sort()).toEqual(['hardest', 'slang']);
    expect(selectStopsByLevel(keepHardest(list, 0, n, () => true), ON).size).toBe(0);
  });
  it('a word I am still learning stays whatever the share (it is not counted in the share)', () => {
    const few = keepHardest(list, 10, n, (l) => l === 'easyish');
    expect(few.flatMap((s) => s.lemmas).sort()).toEqual(['easyish', 'hardest', 'slang']);
  });
  it('the same word twice in a video is in or out both times', () => {
    const twice = [sc(0, [['mid', 'word']]), sc(1, [['hard', 'word']]), sc(2, [['mid', 'word']]), sc(3, [['hardest', 'word']])];
    const half = keepHardest(twice, 50, n, () => false);
    expect(half.map((s) => s.lemmas.join())).toEqual(['', 'hard', '', 'hardest']);
  });
});

import { findAzureRegion } from '../src/bg';
describe('the Microsoft key: its region is found by itself', () => {
  it('the region that takes the key wins; the saved (wrong) one is not asked again', async () => {
    const asked: string[] = [];
    const r = await findAzureRegion(async (rg) => { asked.push(rg); return rg === 'japaneast'; }, 'eastus');
    expect(r).toBe('japaneast');
    expect(asked).not.toContain('eastus');
  });
  it('no region takes the key: null (a failed request counts as no)', async () => {
    expect(await findAzureRegion(async (rg) => { if (rg === 'westus') throw new Error('offline'); return false; })).toBeNull();
  });
});
