import { describe, it, expect } from 'vitest';
import type { WordInfo } from '../../src/core/vocab/analysis';
import type { DictEntry } from '../../src/core/dict/types';
import { hintText, hintFor, wantsHint, HINT_MAX_CHARS } from '../../src/renderer/reader/hints';
import { firstSentences } from '../../src/renderer/reader/WordCard';

const entry = (zh: string, level: DictEntry['level'] = 'C1'): DictEntry => ({ word: 'x', ipa: '', zh, tags: [], frq: 100, bnc: 100, collins: 0, oxford: false, level, levelSource: 'cefrj' });
const info = (zh: string, level: DictEntry['level'] = 'C1', extra: Partial<WordInfo> = {}): WordInfo => ({ lemma: 'x', level, levelSource: 'cefrj', isName: false, inDict: true, entry: entry(zh, level), ...extra });

describe('hint text', () => {
  it('takes the first sense of the first gloss line, without the part of speech', () => {
    expect(hintText('n. 房子, 住宅\nvt. 给...房子住')).toBe('房子');
    expect(hintText('a. 乐观的；自信的')).toBe('乐观的');
    expect(hintText('vt.& vi. 持续、继续')).toBe('持续');
  });
  it('drops bracketed notes and cuts long hints', () => {
    expect(hintText('n. [医]传染病')).toBe('传染病');
    expect(hintText('n. 一个非常非常长的解释文本')).toBe('一个非常非…');
    expect(hintText('n. 一个非常非常长的解释文本').length).toBe(HINT_MAX_CHARS);
    expect(hintText('')).toBe('');
    expect(hintText('n. ')).toBe('');
  });
});

describe('which words get a hint', () => {
  it('above the learner level, not a name, not already known/learning/ignored, in the dictionary', () => {
    expect(wantsHint(info('n. 房子'), 'B2', {})).toBe(true);
    expect(wantsHint(info('n. 房子', 'B1'), 'B2', {})).toBe(false);
    expect(wantsHint(info('n. 房子'), 'B2', { x: 'known' })).toBe(false);
    expect(wantsHint(info('n. 房子'), 'B2', { x: 'learning' })).toBe(false);
    expect(wantsHint(info('n. 房子'), 'B2', { x: 'ignored' })).toBe(false);
    expect(wantsHint(info('n. 房子', 'C1', { isName: true }), 'B2', {})).toBe(false);
    expect(wantsHint(info('n. 房子', 'C1', { entry: null, inDict: false }), 'B2', {})).toBe(false);
    expect(wantsHint(null, 'B2', {})).toBe(false);
  });
  it('an override (a later AI hint) replaces the dictionary text', () => {
    expect(hintFor(info('n. 房子, 住宅'), 'B2', {})).toBe('房子');
    expect(hintFor(info('n. 房子, 住宅'), 'B2', {}, '住所')).toBe('住所');
    expect(hintFor(info('n. 房子, 住宅'), 'B2', {}, '一个非常非常长的解释')).toBe('一个非常非…');
    expect(hintFor(info('n. 房子, 住宅'), 'C2', {}, '住所')).toBe('');
  });
});

describe('card explanation preview', () => {
  it('keeps short text and cuts long text at a sentence end', () => {
    expect(firstSentences('Short.', 50)).toBe('Short.');
    expect(firstSentences('A sanguine person is hopeful. They expect good things. And more text that goes on and on and on.', 60)).toBe('A sanguine person is hopeful. They expect good things.');
    expect(firstSentences('x'.repeat(100), 20)).toBe('x'.repeat(20) + '…');
  });
});
