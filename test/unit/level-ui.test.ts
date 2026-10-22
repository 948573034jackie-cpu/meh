import { describe, it, expect } from 'vitest';
import { BANDS } from '@core/level/items';
import { buildResult } from '@core/level/score';
import type { LevelResult } from '@core/level/score';
import {
  INTRO_LINES, LEVEL_NAMES, LEVEL_TEST_VIEW_ID, READING_NOTES, UNRELIABLE_TEXT, UNRELIABLE_TITLE, answerForKey, changeText,
  levelHeadline, levelMessage, progressText, rangeText, readingNote, sizeSentence, sizeText, stageText,
} from '../../src/renderer/views/levelText';

/** A result as the session would build it: knowledge k in every band, 10 items per band, false-alarm rate f. */
function result(k: number[], f = 0.1, interval?: [number, number]): LevelResult {
  const counts = BANDS.map(() => ({ n: 10, yes: 0 }));
  const v = k.reduce((s, x, b) => s + x * BANDS[b].width, 0);
  return buildResult({ k, counts, f, interval: interval ?? [v * 0.85, v * 1.15] });
}

const B2 = result([1, 1, 0.95, 0.8, 0.5, 0.2, 0.05, 0]);
const A1 = result([0.3, 0.1, 0, 0, 0, 0, 0, 0]);
const C2 = result([1, 1, 1, 1, 1, 0.95, 0.9, 0.8], 0.05, [19000, 20000]);

describe('level test texts', () => {
  it('exports the view id the app routes on', () => {
    expect(LEVEL_TEST_VIEW_ID).toBe('leveltest');
  });

  it('intro is simple English and mentions the fake words and the time', () => {
    const text = INTRO_LINES.join(' ');
    expect(text).toMatch(/Do you know this word\?/);
    expect(text).toMatch(/not real/);
    expect(text).toMatch(/honest/);
    expect(text).toMatch(/5 minutes/);
    for (const line of INTRO_LINES) expect(line.split(' ').length).toBeLessThan(30);
  });

  it('progress and stage texts', () => {
    expect(progressText(0, 50)).toBe('1 of 50');
    expect(progressText(11, 50)).toBe('12 of 50');
    expect(progressText(49, 50)).toBe('50 of 50');
    expect(progressText(50, 50)).toBe('50 of 50');
    expect(stageText(1)).toBe('Stage 1 of 2');
    expect(stageText(2)).toBe('Stage 2 of 2');
  });

  it('headline, range and size texts', () => {
    expect(B2.cefr).toBe('B2');
    expect(levelHeadline(B2)).toBe('Your level: B2');
    expect(rangeText(B2)).toMatch(/^probably [ABC][12] to [ABC][12]$/);
    expect(rangeText(C2)).toBe('quite sure it is C2');
    expect(sizeText(B2)).toMatch(/^about \d{1,2},\d{3} words$/);
    expect(sizeText(B2)).toBe(`about ${B2.sizeLemmas.toLocaleString('en-US')} words`);
    expect(sizeSentence(B2)).toMatch(/^You know about [\d,]+ words of the 20,000 most common English words\.$/);
    expect(readingNote(B2)).toBe(READING_NOTES.B2);
  });

  it('levelMessage for a reliable result puts the level, the name, the range, the size and a reading note together', () => {
    const m = levelMessage(B2);
    expect(m.reliable).toBe(true);
    expect(m.title).toBe('Your level: B2');
    expect(m.subtitle).toBe(`${LEVEL_NAMES.B2} · ${rangeText(B2)}`);
    expect(m.body).toContain(sizeSentence(B2));
    expect(m.body).toContain(READING_NOTES.B2);
    expect(levelMessage(A1).title).toBe('Your level: A1');
    expect(levelMessage(C2).title).toBe('Your level: C2');
    // every level has a name and a reading note
    for (const l of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const) { expect(LEVEL_NAMES[l]).toBeTruthy(); expect(READING_NOTES[l]).toMatch(/\.$/); }
  });

  it('levelMessage for an unreliable result asks to try again and shows no level', () => {
    const bad = result([1, 1, 1, 1, 1, 1, 1, 1], 0.6);
    expect(bad.reliable).toBe(false);
    const m = levelMessage(bad);
    expect(m.reliable).toBe(false);
    expect(m.title).toBe(UNRELIABLE_TITLE);
    expect(m.body).toBe(UNRELIABLE_TEXT);
    expect(m.body).toMatch(/try again/);
    expect(m.body).toMatch(/not real/);
    expect(m.title + m.subtitle + m.body).not.toMatch(/\b[ABC][12]\b/);
    expect(changeText(bad, 'B1')).toBeNull();
  });

  it('changeText compares with the level the learner had', () => {
    expect(changeText(B2, null)).toBeNull();
    expect(changeText(B2, 'B2')).toBe('The same as your level before (B2).');
    expect(changeText(B2, 'B1')).toBe('One level up from your level before (B1).');
    expect(changeText(B2, 'C2')).toBe('Two levels down from your level before (C2).');
    expect(changeText(A1, 'C1')).toBe('4 levels down from your level before (C1).');
  });

  it('keyboard: Y/J/→ mean Yes, N/K/← mean No, Space and letters do nothing', () => {
    expect(answerForKey('KeyY')).toBe(true);
    expect(answerForKey('KeyJ')).toBe(true);
    expect(answerForKey('ArrowRight')).toBe(true);
    expect(answerForKey('KeyN')).toBe(false);
    expect(answerForKey('KeyK')).toBe(false);
    expect(answerForKey('ArrowLeft')).toBe(false);
    expect(answerForKey('Space')).toBeNull();
    expect(answerForKey('Enter')).toBeNull();
    expect(answerForKey('KeyA')).toBeNull();
  });
});
