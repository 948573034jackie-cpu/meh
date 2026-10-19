import { describe, it, expect } from 'vitest';
import { DEFAULT_STYLES, resolveStyles, resolveStyle, fillTemplate, splitAtPause, DEFAULT_CONTEXT_RULES, PLACEHOLDERS } from '@shared/styles';
import { contextAround } from '@core/nav';
import { makeBook } from './helpers';

describe('explanation styles', () => {
  it('has seven styles with word and sentence prompts', () => {
    expect(DEFAULT_STYLES.map((s) => s.id)).toEqual(['custom', 'teacher', 'picture', 'chunks', 'wordparts', 'story', 'quiz']);
    for (const s of DEFAULT_STYLES) {
      expect(s.wordPrompt).toContain('{{word}}');
      expect(s.wordPrompt).toContain('{{sentence}}');
      expect(s.sentencePrompt).toContain('{{sentence}}');
      expect(s.shape.wordBefore).toBeGreaterThan(0);
    }
  });
  it('custom style keeps the learner\'s shape: word x3, word x1, sentence x1; sentence x1 then x2', () => {
    const c = resolveStyle('custom', undefined);
    expect(c.shape).toEqual({ wordBefore: 3, wordAfter: 1, sentenceAfterWord: 1, sentenceBefore: 1, sentenceAfter: 2 });
  });
  it('merges overrides over defaults and ignores unknown ids', () => {
    const all = resolveStyles({ teacher: { model: 'claude-haiku-5-5', shape: { wordAfter: 7 } as never }, nope: { name: 'x' } } as never);
    const t = all.find((s) => s.id === 'teacher')!;
    expect(t.model).toBe('claude-haiku-5-5');
    expect(t.shape.wordAfter).toBe(7);
    expect(t.shape.wordBefore).toBe(3);
    expect(t.wordPrompt).toBe(DEFAULT_STYLES[1].wordPrompt);
    expect(all).toHaveLength(7);
  });
  it('fills placeholders and leaves unknown ones', () => {
    const out = fillTemplate('Word {{word}} in {{title}} {{nope}} {{dict}}', { word: 'flinch', title: 'Emma' });
    expect(out).toBe('Word flinch in Emma {{nope}}');
    for (const p of PLACEHOLDERS) expect(DEFAULT_CONTEXT_RULES + DEFAULT_STYLES.map((s) => s.wordPrompt).join()).toContain(p === 'before' || p === 'after' || p === 'title' || p === 'chapter' ? '' : `{{${p}}}`);
  });
  it('splits a quiz reply at [PAUSE]', () => {
    expect(splitAtPause('Ask this?\n[PAUSE]\nThe answer.')).toEqual(['Ask this?', 'The answer.']);
    expect(splitAtPause('No pause here.')).toEqual(['No pause here.', null]);
  });
});

describe('contextAround', () => {
  const book = makeBook([
    { title: 'One', paragraphs: ['Alpha one. Alpha two. Alpha three.', 'Beta one. Beta two.', 'Gamma one. Gamma two. Gamma three.'] },
    { title: 'Two', paragraphs: ['Delta one.'] },
  ]);
  it('collects whole sentences before and after within the chapter, keeping paragraph breaks', () => {
    const ctx = contextAround(book, { chapter: 0, paragraph: 1, sentence: 1 }, 3, 3);
    expect(ctx.before).toBe('Alpha three.\n\nBeta one.');
    expect(ctx.after).toBe('Gamma one. Gamma two.');
  });
  it('stops at the chapter boundary', () => {
    const ctx = contextAround(book, { chapter: 0, paragraph: 2, sentence: 2 }, 100, 100);
    expect(ctx.after).toBe('');
    expect(ctx.before.startsWith('Alpha one.')).toBe(true);
    expect(ctx.before.endsWith('Gamma two.')).toBe(true);
  });
});

import { buildStyledPrompt, cleanSpokenProse } from '@core/ai/prompts';
describe('buildStyledPrompt', () => {
  const req = { kind: 'word' as const, target: 'flinched', sentence: 'She flinched at the sound.', before: 'The door banged.', after: 'Then silence.', book: { title: 'Emma', chapter: 'Chapter 3' }, dict: { ipa: 'flɪntʃt', zh: '退缩', level: 'C1' }, position: { chapter: 2, paragraph: 4, sentence: 1 }, history: [] };
  it('fills the style template and the shared rules with level, native language and context', () => {
    const style = resolveStyle('teacher', undefined);
    const p = buildStyledPrompt(req, { style, contextRules: DEFAULT_CONTEXT_RULES, level: 'B2', native: 'Chinese' });
    expect(p.system).toContain('CEFR level B2');
    expect(p.system).toContain('first language is Chinese');
    expect(p.system).not.toContain('{{');
    expect(p.user).toContain('Book: Emma');
    expect(p.user).toContain('Chapter: Chapter 3');
    expect(p.user).toContain('chapter 3, paragraph 5, sentence 2');
    expect(p.user).toContain('Text before the sentence:\nThe door banged.');
    expect(p.user).toContain('The sentence being read now:\nShe flinched at the sound.');
    expect(p.user).toContain('The word to teach is "flinched"');
    expect(p.user).toContain('Chinese meaning 退缩');
    expect(p.user).not.toContain('{{');
    expect(p.maxTokens).toBe(style.maxTokens);
  });
  it('uses the sentence template for sentence requests', () => {
    const p = buildStyledPrompt({ ...req, kind: 'sentence', target: req.sentence }, { style: resolveStyle('story', undefined), contextRules: DEFAULT_CONTEXT_RULES, level: 'B1', native: 'Chinese' });
    expect(p.user).toContain('The sentence to teach is: She flinched at the sound.');
    expect(p.user).toContain('Retell this moment');
  });
  it('cleans markdown and stray labels out of spoken prose', () => {
    expect(cleanSpokenProse('**Definition:** hi\n\n- one\n1. two\nIN THIS SENTENCE: here')).toBe('hi\n\none\ntwo\nhere');
  });
});

describe('explain again', () => {
  it('adds the deeper second-explanation instruction and a bigger budget', () => {
    const style = resolveStyle('custom', undefined);
    const base = { kind: 'word' as const, target: 'flinched', sentence: 'She flinched.', before: '', after: '', book: { title: 'T', chapter: '' }, history: [] };
    const a = buildStyledPrompt(base, { style, contextRules: DEFAULT_CONTEXT_RULES, level: 'B2', native: 'Chinese' });
    const b = buildStyledPrompt({ ...base, again: true }, { style, contextRules: DEFAULT_CONTEXT_RULES, level: 'B2', native: 'Chinese' });
    expect(a.user).not.toContain('still do not understand');
    expect(b.user).toContain('still do not understand');
    expect(b.maxTokens).toBeGreaterThan(a.maxTokens);
  });
});
