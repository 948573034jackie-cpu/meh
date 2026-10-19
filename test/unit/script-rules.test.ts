import { describe, it, expect } from 'vitest';
import { cleanSpokenProse } from '@core/ai/prompts';
import { DEFAULT_CONTEXT_RULES, LEGACY_CONTEXT_RULES, DEFAULT_STYLES } from '@shared/styles';
import { DEFAULT_SETTINGS, migrateSettings } from '@shared/settings';
import { toChapterPhraseMap } from '../../src/renderer/reader/phrases';

describe('the 19 Oct listening rules', () => {
  it('the shared rules forbid filler and say spoken transcripts may be badly recognised', () => {
    expect(DEFAULT_CONTEXT_RULES).toContain('"great question"');
    expect(DEFAULT_CONTEXT_RULES).toContain('Never ask them to repeat');
    expect(DEFAULT_CONTEXT_RULES.startsWith(LEGACY_CONTEXT_RULES[0])).toBe(true);
  });

  it('stored rules equal to the old default get the new one; edited rules stay', () => {
    type Stored = { ai: { contextRules: string }; listen: { pauseAfterExplainMs: number } };
    const mig = (o: object): Stored => migrateSettings(o as { appearance?: { theme?: string } }) as unknown as Stored;
    expect(mig({ ai: { contextRules: LEGACY_CONTEXT_RULES[0] } }).ai.contextRules).toBe(DEFAULT_CONTEXT_RULES);
    expect(mig({ ai: { contextRules: 'my own rules' } }).ai.contextRules).toBe('my own rules');
    expect(mig({ listen: { pauseAfterExplainMs: 7000 } }).listen.pauseAfterExplainMs).toBe(5000);
    expect(DEFAULT_SETTINGS.listen).toMatchObject({ commandWindowMs: 5000, pauseAfterExplainMs: 5000, wordRepeats: 3 });
  });

  it('built-in styles: the word 3 times, nothing said after the explanation (the sentence is re-read instead)', () => {
    for (const s of DEFAULT_STYLES) expect(s.shape).toMatchObject({ wordBefore: 3, wordAfter: 0, sentenceAfterWord: 0 });
  });

  it('opening filler is stripped from spoken replies', () => {
    expect(cleanSpokenProse('Great question! Let me explain. Sanguine means hopeful.')).toBe('Sanguine means hopeful.');
    expect(cleanSpokenProse('As I said, it is a feeling.')).toBe('It is a feeling.');
    expect(cleanSpokenProse('Now, the man is hopeful.')).toBe('The man is hopeful.');
    expect(cleanSpokenProse('Now means at this moment.')).toBe('Now means at this moment.');
  });

  it('the chapter phrase adapter takes the bridge map tolerantly', () => {
    const hit = { sentenceKey: '2.1.0', start: 1, end: 2, text: 'kicked off', lemma: 'kick off', level: 'C1', zh: '开始' };
    expect(toChapterPhraseMap({ '2.1.0': [hit, { bad: true }] }, 2)).toEqual({ '2.1.0': [{ start: 1, end: 2, text: 'kicked off', lemma: 'kick off', level: 'C1', zh: '开始' }] });
    expect(toChapterPhraseMap([hit], 2)['2.1.0']).toHaveLength(1);
    expect(toChapterPhraseMap({ 2: { '1.0': [hit] } }, 2)['2.1.0']).toHaveLength(1);
    expect(toChapterPhraseMap(null, 2)).toEqual({});
  });
});
