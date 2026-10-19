import { describe, it, expect } from 'vitest';
import { createDictionary } from '@core/dict/dictionary';
import type { DictData } from '@shared/api';
import { collectHardWords, batchHardWords, buildHintsPrompt, parseHints, clipSentence, HINTS_BATCH_SIZE, HINT_TOKENS_PER_WORD } from '@core/ai/hints';
import { makeBook } from './helpers';

const raw = (t: string, l: DictData['w'][string]['l'], f = 5000): DictData['w'][string] => ({ i: '', t, g: '', f, b: f, c: 3, o: 0, l, s: 'cefrj' });
const DICT: DictData = {
  w: {
    the: raw('art. 这', 'A1', 1), house: raw('n. 房子', 'A1', 300), was: raw('v. 是', 'A1', 10), quiet: raw('a. 安静的', 'A2'), and: raw('conj. 和', 'A1', 3),
    serene: raw('a. 平静的', 'C1'), ubiquitous: raw('a. 无处不在的', 'C2'), reluctant: raw('a. 不情愿的', 'C1'), spring: raw('n. 春天; 弹簧', 'A2'),
    he: raw('pron. 他', 'A1', 2), seemed: raw('v. 似乎', 'A1'), to: raw('prep. 到', 'A1', 4), leave: raw('v. 离开', 'A1'), of: raw('prep. 的', 'A1', 5),
    trap: raw('n. 陷阱', 'B1'), snapped: raw('v. 折断', 'B2'), a: raw('art. 一个', 'A1', 6),
  },
  f: { serenest: 'serene' },
};
const dict = createDictionary(DICT);

describe('collectHardWords', () => {
  const book = makeBook([
    { title: 'One', paragraphs: ['The house was quiet and serene. Darcy was reluctant to leave. The serenest house was ubiquitous.'] },
    { title: 'Two', paragraphs: ['Nothing hard here.'] },
  ]);
  it('lists each hard lemma once with the sentence of its first appearance, skipping names and known words', () => {
    const words = collectHardWords(book, 0, dict, 'B2', new Set(), new Set());
    expect(words.map((w) => w.lemma)).toEqual(['serene', 'reluctant', 'ubiquitous']);
    expect(words[0]).toEqual({ lemma: 'serene', word: 'serene', sentence: 'The house was quiet and serene.' });
    expect(words[1].sentence).toBe('Darcy was reluctant to leave.');
    const known = collectHardWords(book, 0, dict, 'B2', new Set(['darcy']), new Set(['reluctant']));
    expect(known.map((w) => w.lemma)).toEqual(['serene', 'ubiquitous']);
    expect(collectHardWords(book, 0, dict, 'C2', new Set(), new Set())).toEqual([]);
    expect(collectHardWords(book, 1, dict, 'B2', new Set(), new Set())).toEqual([]);
    expect(collectHardWords(book, 9, dict, 'B2', new Set(), new Set())).toEqual([]);
  });
  it('batches at most HINTS_BATCH_SIZE words per request', () => {
    const many = Array.from({ length: 170 }, (_, i) => ({ lemma: `w${i}`, word: `w${i}`, sentence: 's' }));
    const batches = batchHardWords(many);
    expect(batches.map((b) => b.length)).toEqual([HINTS_BATCH_SIZE, HINTS_BATCH_SIZE, 10]);
    expect(batchHardWords([])).toEqual([]);
  });
  it('clips long sentences around the word', () => {
    const long = `${'blah '.repeat(60)}reluctant ${'blah '.repeat(60)}end.`;
    const c = clipSentence(long, 'reluctant', 100);
    expect(c.length).toBeLessThanOrEqual(102);
    expect(c).toContain('reluctant');
    expect(c.startsWith('…') && c.endsWith('…')).toBe(true);
    expect(clipSentence('Short one.', 'one')).toBe('Short one.');
  });
});

describe('buildHintsPrompt', () => {
  it('shows every word with its sentence and asks for a JSON object keyed by lemma', () => {
    const batch = [
      { lemma: 'serene', word: 'serenest', sentence: 'The serenest house.' },
      { lemma: 'spring', word: 'spring', sentence: 'The spring of the trap snapped.' },
    ];
    const p = buildHintsPrompt(batch, { title: 'Pride and Prejudice', chapter: 'Chapter 3', level: 'B2' });
    expect(p.system).toMatch(/JSON object/);
    expect(p.system).toMatch(/B2/);
    expect(p.system).toMatch(/IN THAT SENTENCE/);
    expect(p.user).toContain('Pride and Prejudice — Chapter 3');
    expect(p.user).toContain('"serene" (in the text: serenest) — The serenest house.');
    expect(p.user).toContain('"spring" — The spring of the trap snapped.');
    expect(p.user).toContain('"serene", "spring"');
    expect(p.maxTokens).toBe(HINT_TOKENS_PER_WORD * 2 + 100);
  });
});

describe('parseHints', () => {
  it('reads a plain JSON object', () => {
    expect(parseHints('{"serene": ["平静的", "安详的"], "Spring": ["弹簧", "春天"], "x": ["只有一个"]}')).toEqual({ serene: ['平静的', '安详的'], spring: ['弹簧', '春天'], x: ['只有一个', ''] });
  });
  it('tolerates code fences and text around the object', () => {
    const text = 'Here you go:\n```json\n{"serene": ["平静的", ""]}\n```\nLet me know if you need more.';
    expect(parseHints(text)).toEqual({ serene: ['平静的', ''] });
  });
  it('salvages complete entries from a truncated or broken reply and ignores garbage', () => {
    expect(parseHints('{"serene": ["平静的", "安详的"], "reluctant": ["不情愿的", "勉强的"], "ubiq')).toEqual({ serene: ['平静的', '安详的'], reluctant: ['不情愿的', '勉强的'] });
    expect(parseHints('')).toEqual({});
    expect(parseHints('I cannot help with that.')).toEqual({});
    expect(parseHints('[1, 2]')).toEqual({});
    expect(parseHints('{"a": 5, "b": [], "c": ["", "x"], "d": "单个"}')).toEqual({ d: ['单个', ''] });
  });
});
