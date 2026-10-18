import { describe, it, expect } from 'vitest';
import { wordScript, sentenceScript, aiSteps } from '@core/listen/script';

const s = { wordRepeats: 3, sentenceRepeatsAfterWord: 2, sentenceRepeatsForPhrase: 2, speakChinese: true };

describe('scripts', () => {
  it('word script: word x3, AI, word x3, sentence x2', () => {
    const steps = wordScript('sanguine', 'He remained sanguine.', s).filter((x) => x.type !== 'pause');
    expect(steps.map((x) => (x.type === 'say' ? `${x.role}:${x.text}` : 'ai'))).toEqual([
      'word:sanguine', 'word:sanguine', 'word:sanguine', 'ai', 'word:sanguine', 'word:sanguine', 'word:sanguine', 'sentence:He remained sanguine.', 'sentence:He remained sanguine.',
    ]);
  });
  it('sentence script: sentence, AI, sentence', () => {
    const steps = sentenceScript('A long sentence.', s).filter((x) => x.type !== 'pause');
    expect(steps.map((x) => (x.type === 'say' ? x.role : 'ai'))).toEqual(['sentence', 'ai', 'sentence']);
  });
  it('AI steps speak English parts then Chinese with a Chinese voice', () => {
    const steps = aiSteps({ definition: 'Means hopeful.', inSentence: 'He stays positive.', chinese: '乐观的' }, s, true).filter((x) => x.type === 'say');
    expect(steps.map((x) => (x.type === 'say' ? x.lang : ''))).toEqual(['en', 'en', 'zh']);
    expect(aiSteps({ definition: 'x', chinese: '乐' }, s, false).filter((x) => x.type === 'say')).toHaveLength(1);
  });
});
