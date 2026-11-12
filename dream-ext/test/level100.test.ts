import { describe, it, expect } from 'vitest';
import { wordDifficulty, zipfDifficulty, phraseDifficulty, sentenceDifficulty, cefrToLevel, levelToCefr, harderThan, myLevelOf, clampLevel, fitScore, DEFAULT_LEVEL, PHRASE_FLOOR } from '../src/level100';

describe('one level, 0 (easiest) to 100 (hardest)', () => {
  it('a common word is near 0, a rare word near 100', () => {
    expect(zipfDifficulty(7.5)).toBe(0);
    expect(zipfDifficulty(1)).toBe(100);
    expect(wordDifficulty(6.5, 'A1')).toBeLessThan(15);
    expect(wordDifficulty(2.2, 'C2')).toBeGreaterThan(80);
    // easier words always have a smaller number than harder ones
    expect(wordDifficulty(5.5, 'A2')).toBeLessThan(wordDifficulty(4.2, 'B1'));
    expect(wordDifficulty(4.2, 'B1')).toBeLessThan(wordDifficulty(3.1, 'C1'));
  });
  it('the school level pulls a word back when frequency gets it wrong; one of the two is enough', () => {
    expect(wordDifficulty(3.0, 'A1')).toBeLessThan(wordDifficulty(3.0, null));
    expect(wordDifficulty(null, 'B2')).toBe(56);
    expect(wordDifficulty(null, null)).toBe(80);
    expect(wordDifficulty(4, '')).toBe(Math.round(zipfDifficulty(4)));
  });
  it('phrases have a floor (their single words are easy); sentences have a number too', () => {
    expect(phraseDifficulty('A2')).toBe(PHRASE_FLOOR);
    expect(phraseDifficulty('C1')).toBe(73);
    expect(phraseDifficulty()).toBeGreaterThanOrEqual(PHRASE_FLOOR);
    expect(sentenceDifficulty('C2')).toBe(90);
    expect(sentenceDifficulty()).toBe(68);
  });
  it('THE RULE: only what is harder than my level', () => {
    expect(harderThan(61, 60)).toBe(true);
    expect(harderThan(60, 60)).toBe(false);
    expect(harderThan(20, 60)).toBe(false);
    // level 100: nothing is harder; level 0: everything above 0 is
    expect(harderThan(100, 100)).toBe(false);
    expect(harderThan(1, 0)).toBe(true);
  });
  it('the old A1–C2 level becomes a number once; a number has a nearest school level', () => {
    expect(cefrToLevel('B2')).toBe(56);
    expect(cefrToLevel('nonsense')).toBe(DEFAULT_LEVEL);
    expect(levelToCefr(56)).toBe('B2');
    expect(levelToCefr(0)).toBe('A1');
    expect(levelToCefr(100)).toBe('C2');
    expect(myLevelOf({ myLevel: 42 }, 'C1')).toBe(42);
    expect(myLevelOf({}, 'C1')).toBe(73);
    expect(clampLevel(140)).toBe(100);
    expect(clampLevel('x')).toBe(DEFAULT_LEVEL);
  });
  it('a video a little above my level fits best', () => {
    expect(fitScore(60, 55)).toBe(100);
    expect(fitScore(90, 55)).toBeLessThan(fitScore(70, 55));
    expect(fitScore(20, 55)).toBeLessThan(fitScore(50, 55));
  });
});
