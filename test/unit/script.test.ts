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

import { proseSteps, splitByScript, twoMeanings } from '@core/listen/script';
describe('Chinese in explanations', () => {
  it('splits Chinese runs out of English text', () => {
    expect(splitByScript('It means 尖刻的 here, okay.')).toEqual([{ text: 'It means', zh: false }, { text: '尖刻的', zh: true }, { text: 'here, okay.', zh: false }]);
  });
  it('keeps two clean meanings', () => {
    expect(twoMeanings('a. 尖刻的, 讥讽的, 激烈的')).toBe('尖刻的，讥讽的');
    expect(twoMeanings(['刻薄的', ''])).toBe('刻薄的');
    expect(twoMeanings('n. (pl.) 血红色; 红粉笔 sth')).toBe('血红色，红粉笔');
  });
  it('speaks Chinese with the Chinese voice, at the end, and drops it when off', () => {
    const on = proseSteps('Sharp words. In Chinese 尖刻的.', { zh: 'a. 尖刻的, 讥讽的, 激烈的', speakChinese: true, zhAvailable: true });
    const says = on.filter((s) => s.type === 'say') as { text: string; lang: string }[];
    expect(says.map((s) => [s.lang, s.text])).toEqual([['en', 'Sharp words. In Chinese'], ['zh', '尖刻的'], ['zh', '尖刻的，讥讽的']]);
    const off = proseSteps('Sharp words. In Chinese 尖刻的.', { zh: '尖刻的', speakChinese: false, zhAvailable: true });
    expect((off.filter((s) => s.type === 'say') as { lang: string }[]).every((s) => s.lang === 'en')).toBe(true);
  });
});
