import { describe, it, expect } from 'vitest';
import { detectCommand, normalize, levenshtein, ratio, phoneticWord, phoneticKey, MAX_COMMAND_WORDS } from '@core/voice/commands';

describe('normalize', () => {
  it('lowercases, strips punctuation, collapses whitespace, keeps apostrophes', () => {
    expect(normalize("  I   Don't  KNOW!!  ")).toBe("i don't know");
    expect(normalize('bye-bye.')).toBe('bye bye');
    expect(normalize('I’m not sure…')).toBe("i'm not sure");
  });
  it('canonicalises apostrophe-less contractions and drops fillers', () => {
    expect(normalize('um, I dont know')).toBe("i don't know");
    expect(normalize('okay I know')).toBe('i know');
    expect(normalize('uh thats all')).toBe("that's all");
    expect(normalize('okay')).toBe('');
  });
});

describe('string metrics', () => {
  it('levenshtein distance', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('i know', 'i know')).toBe(0);
    expect(levenshtein('abc', '')).toBe(3);
  });
  it('ratio is 1 - distance / max length', () => {
    expect(ratio('', '')).toBe(1);
    expect(ratio('i kno', 'i know')).toBeCloseTo(5 / 6, 5);
    expect(ratio('abcd', 'wxyz')).toBe(0);
  });
  it('phonetic key folds know/no/knew/now and bye/bai/by/buy', () => {
    expect(new Set(['know', 'no', 'knew', 'now'].map(phoneticWord))).toEqual(new Set(['N']));
    expect(new Set(['bye', 'bai', 'by', 'buy'].map(phoneticWord))).toEqual(new Set(['B']));
    expect(phoneticWord('what')).toBe('WT');
    expect(phoneticWord('that')).toBe('TT');
    expect(phoneticKey("i don't know")).toBe('A TNT N');
    expect(phoneticKey('see ya')).toBe(phoneticKey('see you'));
  });
});

describe('detectCommand', () => {
  it.each([
    'I know', 'I knew', 'I no', 'I now', 'yes I know', 'got it', 'ok I know', 'Okay, I know.', 'I know it', 'yeah i know',
  ])('KNOW: %s', (text) => {
    const d = detectCommand(text);
    expect(d.intent).toBe('know');
    expect(d.score).toBeGreaterThanOrEqual(0.8);
    expect(d.matched).toBeDefined();
  });

  it.each([
    "I don't know", 'I dont know', 'I don no', 'no idea', 'not sure', "I'm not sure", 'im not sure', "don't know", 'what', 'again', 'explain again', 'dunno', "I don't understand",
  ])('DONT_KNOW: %s', (text) => {
    expect(detectCommand(text).intent).toBe('dont_know');
  });

  it.each(['bye bye', 'bye', 'goodbye', 'bai bai', 'by by', 'bye-bye', 'see you', "that's all", 'thats all'])('BYE: %s', (text) => {
    expect(detectCommand(text).intent).toBe('bye');
  });

  it('accepts accent / STT misspellings through the Levenshtein ratio', () => {
    expect(detectCommand('I knoww')).toMatchObject({ intent: 'know', matched: 'i know' });
    expect(detectCommand('i kno').score).toBeCloseTo(5 / 6, 5);
    expect(detectCommand("I don' kno")).toMatchObject({ intent: 'dont_know', matched: 'i don no' });
    expect(detectCommand('dats all')).toMatchObject({ intent: 'bye', matched: "that's all" });
  });

  it('accepts phonetic equality when the ratio is too low', () => {
    expect(ratio('ba ba', 'bye bye')).toBeLessThan(0.8);
    expect(detectCommand('ba ba')).toMatchObject({ intent: 'bye', matched: 'bye bye' });
    expect(detectCommand('buy buy').intent).toBe('bye');
    expect(detectCommand('see ya').intent).toBe('bye');
  });

  it('tests DONT_KNOW before KNOW so the substring collision resolves correctly', () => {
    expect(detectCommand("I don't know").intent).toBe('dont_know');
    expect(detectCommand('i do not know').intent).toBe('dont_know');
    expect(detectCommand('I know').intent).toBe('know');
    expect(detectCommand('I no').intent).toBe('know');
  });

  it('prefix rule: command phrase followed by a short tail', () => {
    expect(detectCommand("I don't know this word")).toMatchObject({ intent: 'dont_know', matched: "i don't know" });
    expect(detectCommand('I don no this word').intent).toBe('dont_know');
    expect(detectCommand('I know I know')).toMatchObject({ intent: 'know', matched: 'i know' });
    expect(detectCommand('bye bye now').intent).toBe('bye');
  });

  it('prefix rule rejects a tail longer than the command ("I know that word already" is a question)', () => {
    const d = detectCommand('I know that word already');
    expect(d.intent).toBe('question');
    expect(d.score).toBeLessThan(0.8);
    expect(detectCommand('what is this').intent).toBe('question');
    expect(detectCommand('what does this word mean').intent).toBe('question');
  });

  it('treats non-matching short utterances as questions', () => {
    for (const t of ['I love this book', 'tell me more', 'the cat sat', 'no', 'yes', 'now', 'I need to go now']) {
      expect(detectCommand(t).intent, t).toBe('question');
    }
  });

  it('rejects utterances longer than 6 words even when they contain a command', () => {
    expect(detectCommand('I know I know I know I know').intent).toBe('question');
    expect(detectCommand('can you explain the second sentence please')).toEqual({ intent: 'question', score: 0 });
    expect('a b c d e f'.split(' ').length).toBe(MAX_COMMAND_WORDS);
    expect(detectCommand("I don't know what this word means at all").intent).toBe('question');
  });

  it('returns none for empty or filler-only input', () => {
    expect(detectCommand('')).toEqual({ intent: 'none', score: 0 });
    expect(detectCommand('  ...  ')).toEqual({ intent: 'none', score: 0 });
    expect(detectCommand('um uh')).toEqual({ intent: 'none', score: 0 });
  });

  it('confidence gate: below 0.6 the ratio must reach 0.85 and phonetic-only matches are refused', () => {
    expect(detectCommand('i kno', { confidence: 0.9 }).intent).toBe('know'); // ratio 0.83
    expect(detectCommand('i kno', { confidence: 0.4 }).intent).toBe('question');
    expect(detectCommand('I knoww', { confidence: 0.4 }).intent).toBe('know'); // ratio 0.857
    expect(detectCommand('ba ba', { confidence: 0.5 }).intent).toBe('question');
    expect(detectCommand('bai bai', { confidence: 0.1 }).intent).toBe('bye'); // exact grammar entry still matches
  });

  it('honours a custom minRatio', () => {
    expect(detectCommand('i kno', { minRatio: 0.9 }).intent).toBe('know'); // phonetic rescue
    expect(detectCommand('I knoww', { minRatio: 0.9 }).intent).toBe('know');
    expect(detectCommand('i knob', { minRatio: 0.9 }).intent).toBe('question');
    expect(detectCommand('i knob', { minRatio: 0.7 }).intent).toBe('know');
  });
});
