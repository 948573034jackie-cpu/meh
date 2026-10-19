import { describe, it, expect } from 'vitest';
import { DEFAULT_STYLES, resolveStyles, resolveStyle, PLACEHOLDERS } from '@shared/styles';
import { buildStyledPrompt } from '@core/ai/prompts';
import { slugify, nextStyleId, duplicateOverride, newStyleOverride, isBuiltin, sampleRequest, PLACEHOLDER_MEANINGS } from '../../src/renderer/views/StylesEditor';

describe('styles editor helpers', () => {
  it('makes learner-made ids from the style name and never reuses one', () => {
    expect(slugify('Teacher Style')).toBe('teacher-style');
    expect(slugify('  Ünïcode & symbols!! ')).toBe('n-code-symbols');
    expect(slugify('')).toBe('style');
    expect(nextStyleId('Teacher Style', DEFAULT_STYLES.map((s) => s.id))).toBe('my-teacher-style-1');
    expect(nextStyleId('Teacher Style', ['my-teacher-style-1', 'my-teacher-style-2'])).toBe('my-teacher-style-3');
    expect(nextStyleId('style', [])).toBe('my-style-1');
    expect(isBuiltin('teacher')).toBe(true);
    expect(isBuiltin('my-teacher-style-1')).toBe(false);
  });

  it('a duplicate is a full, independent copy that resolves as a learner-made style', () => {
    const teacher = resolveStyle('teacher', { teacher: { wordPrompt: 'Edited {{word}}', length: 'long' } });
    const id = nextStyleId(teacher.name, DEFAULT_STYLES.map((s) => s.id));
    const all = resolveStyles({ [id]: duplicateOverride(teacher) });
    expect(all).toHaveLength(11);
    const copy = all.find((s) => s.id === id)!;
    expect(copy.userMade).toBe(true);
    expect(copy.name).toBe('Teacher Style (copy)');
    expect(copy.wordPrompt).toBe('Edited {{word}}');
    expect(copy.sentencePrompt).toBe(teacher.sentencePrompt);
    expect(copy.length).toBe('long');
    expect(copy.shape).toEqual(teacher.shape);
    expect(copy.shape).not.toBe(teacher.shape);
    // resetting the built-in (override removed) leaves the copy alone
    const afterReset = resolveStyles({ teacher: null as never, [id]: duplicateOverride(teacher) });
    expect(afterReset.find((s) => s.id === 'teacher')!.wordPrompt).toBe(DEFAULT_STYLES[1].wordPrompt);
    expect(afterReset.find((s) => s.id === id)!.wordPrompt).toBe('Edited {{word}}');
    // deleting the copy (override set to null) removes it from the list
    expect(resolveStyles({ [id]: null as never })).toHaveLength(10);
  });

  it('a new style starts from the custom defaults', () => {
    const all = resolveStyles({ 'my-style-1': newStyleOverride() });
    const mine = all.find((s) => s.id === 'my-style-1')!;
    expect(mine.userMade).toBe(true);
    expect(mine.wordPrompt).toBe(DEFAULT_STYLES[0].wordPrompt);
    expect(mine.sentencePrompt).toBe(DEFAULT_STYLES[0].sentencePrompt);
  });

  it('the placeholder legend covers every placeholder, and the preview fills them all in', () => {
    for (const p of PLACEHOLDERS) expect(PLACEHOLDER_MEANINGS[p]).toBeTruthy();
    const style = resolveStyle('teacher', undefined);
    const word = buildStyledPrompt(sampleRequest('word'), { style, contextRules: 'Level {{level}}, {{native}}.', level: 'B2', native: 'Chinese' });
    expect(word.system).toBe('Level B2, Chinese.');
    expect(word.user).toContain('The word to teach is "sanguine"');
    expect(word.user).toContain('Dictionary hint for the word');
    expect(word.user).not.toMatch(/\{\{\w+\}\}/);
    const sentence = buildStyledPrompt(sampleRequest('sentence'), { style, contextRules: '', level: 'B2', native: 'Chinese' });
    expect(sentence.user).toContain('The sentence to teach is: Mr. Darcy remained sanguine about the weather.');
    expect(sentence.maxTokens).toBe(style.maxTokens);
  });
});
