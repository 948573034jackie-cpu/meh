import { describe, it, expect } from 'vitest';
import { buildPrompt, parseExplanation, spokenEnglish, spokenChinese, cleanSpokenProse, stripOpeningFiller } from '@core/ai/prompts';
import { KNOBS } from '@shared/styles';

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

describe('parseExplanation tolerance', () => {
  it('finds labels that the model put on one line', () => {
    const parts = parseExplanation('DEFINITION: Sanguine means hopeful. IN THIS SENTENCE: He stays positive. CHINESE: 乐观的', 'word');
    expect(parts.definition).toBe('Sanguine means hopeful.');
    expect(parts.inSentence).toBe('He stays positive.');
    expect(parts.chinese).toBe('乐观的');
  });
  it('accepts bullets, numbering, bold labels and dashes instead of colons', () => {
    const parts = parseExplanation('- **Definition** — Sanguine means hopeful.\n2. In this sentence - He stays positive.\n* Chinese: 乐观的', 'word');
    expect(parts.definition).toBe('Sanguine means hopeful.');
    expect(parts.inSentence).toBe('He stays positive.');
    expect(parts.chinese).toBe('乐观的');
  });
  it('keeps only the Chinese characters of the CHINESE line (no pinyin for the Chinese voice)', () => {
    expect(parseExplanation('DEFINITION: x\nCHINESE: 乐观的 (lèguān de)', 'word').chinese).toBe('乐观的');
    expect(parseExplanation('DEFINITION: x\nCHINESE: 乐观的、充满希望的。', 'word').chinese).toBe('乐观的、充满希望的');
  });
  it('treats "there are none" style hard-word lines as empty and skips items without a meaning', () => {
    expect(parseExplanation('MEANING: Easy.\nHARD WORDS: There are none.', 'sentence').hardWords).toEqual([]);
    expect(parseExplanation('MEANING: Easy.\nHARD WORDS: None in this sentence.', 'sentence').hardWords).toEqual([]);
    const parts = parseExplanation('MEANING: Easy.\nHARD WORDS: grudge, a lasting bad feeling, 怨恨; sulk', 'sentence');
    expect(parts.hardWords).toEqual([{ word: 'grudge', meaning: 'a lasting bad feeling', zh: '怨恨' }]);
    expect(spokenEnglish(parts)).toEqual(['Easy.', 'grudge: a lasting bad feeling']);
  });
});

describe('spoken prose: opening filler (docs/RULES.md 2, "No filler")', () => {
  it('cleanSpokenProse removes opening filler, except with { opening: false } (a later sentence of a streamed reply)', () => {
    expect(cleanSpokenProse('Great question! **Sanguine** means hopeful.')).toBe('Sanguine means hopeful.');
    expect(cleanSpokenProse('Now, look at him.', { opening: false })).toBe('Now, look at him.');
    expect(cleanSpokenProse('Great question!')).toBe('Great question!'); // the whole text is never dropped here
  });
  it('stripOpeningFiller may leave nothing: a first sentence that is only filler is not spoken', () => {
    expect(stripOpeningFiller('Great question!')).toBe('');
    expect(stripOpeningFiller('Let me explain. Now, sanguine means hopeful.')).toBe('Sanguine means hopeful.');
    expect(stripOpeningFiller('Sanguine means hopeful.')).toBe('Sanguine means hopeful.');
  });
  it('the warm personality starts with the meaning at once and asks for no praise', () => {
    expect(KNOBS.personality.warm.text).not.toMatch(/praise/i);
    expect(KNOBS.personality.warm.text).toContain('start with the meaning at once');
  });
});
