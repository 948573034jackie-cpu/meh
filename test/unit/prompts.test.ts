import { describe, it, expect } from 'vitest';
import { buildPrompt, parseExplanation, spokenEnglish, spokenChinese } from '@core/ai/prompts';

describe('prompts', () => {
  it('builds a word prompt with context and labels', () => {
    const p = buildPrompt({ kind: 'word', target: 'sanguine', sentence: 'He remained sanguine.', before: 'It rained.', after: 'It stopped.', book: { title: 'B', chapter: 'One' }, dict: { ipa: '/x/', zh: '乐观的', level: 'C1' }, history: [] }, { level: 'B2', instructions: 'Be kind.', length: 'normal' });
    expect(p.system).toContain('B2');
    expect(p.system).toContain('Be kind.');
    expect(p.user).toContain('Sentence: He remained sanguine.');
    expect(p.user).toContain('DEFINITION:');
    expect(p.user).toContain('CHINESE:');
    expect(p.user).toContain('乐观的');
    expect(p.maxTokens).toBeGreaterThan(100);
  });
  it('short length omits the example', () => {
    const p = buildPrompt({ kind: 'word', target: 'x', sentence: 'x', before: '', after: '', book: { title: 'B', chapter: '' }, history: [] }, { level: 'A2', instructions: '', length: 'short' });
    expect(p.user).not.toContain('EXAMPLE:');
  });
  it('parses labelled replies, including markdown bold and Chinese colon', () => {
    const parts = parseExplanation('**DEFINITION:** Sanguine means hopeful.\nIN THIS SENTENCE： He stays positive even though it rains.\nEXAMPLE: She was sanguine about the exam.\nCHINESE: 乐观的', 'word');
    expect(parts.definition).toBe('Sanguine means hopeful.');
    expect(parts.inSentence).toContain('positive');
    expect(parts.example).toContain('exam');
    expect(parts.chinese).toBe('乐观的');
    expect(spokenEnglish(parts)).toHaveLength(3);
    expect(spokenChinese(parts)).toEqual(['乐观的']);
  });
  it('parses hard words lists', () => {
    const parts = parseExplanation('MEANING: He was angry.\nHARD WORDS: acrimonious, full of anger, 尖刻的; grudge, a lasting bad feeling, 怨恨', 'sentence');
    expect(parts.hardWords).toHaveLength(2);
    expect(parts.hardWords![0]).toEqual({ word: 'acrimonious', meaning: 'full of anger', zh: '尖刻的' });
    expect(spokenChinese(parts)).toEqual(['acrimonious, 尖刻的', 'grudge, 怨恨']);
    expect(parseExplanation('MEANING: Easy.\nHARD WORDS: none', 'sentence').hardWords).toEqual([]);
  });
  it('falls back to free text when no labels are present', () => {
    const parts = parseExplanation('Just a plain answer.', 'question');
    expect(parts.free).toBe('Just a plain answer.');
    expect(spokenEnglish(parts)).toEqual(['Just a plain answer.']);
  });
});
