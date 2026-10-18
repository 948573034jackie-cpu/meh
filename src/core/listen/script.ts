import type { ExplanationParts } from '@core/ai/prompts';
import { spokenEnglish, spokenChinese } from '@core/ai/prompts';

/** One spoken or silent step of an explanation script. */
export type ScriptStep =
  | { type: 'say'; text: string; lang: 'en' | 'zh'; role: 'word' | 'sentence' | 'explanation' | 'chinese' }
  | { type: 'pause'; ms: number }
  /** marker where the AI reply is spoken; replaced by say steps once the reply is parsed */
  | { type: 'ai' };

export interface ScriptSettings { wordRepeats: number; sentenceRepeatsAfterWord: number; sentenceRepeatsForPhrase: number; speakChinese: boolean }

/**
 * Word script (as the learner specified): word x N, explanation (definition, then meaning in this
 * sentence), Chinese meaning, word x N, the sentence x M, then reading continues with the next sentence.
 */
export function wordScript(word: string, sentence: string, s: ScriptSettings): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (let i = 0; i < s.wordRepeats; i++) { steps.push({ type: 'say', text: word, lang: 'en', role: 'word' }); steps.push({ type: 'pause', ms: 350 }); }
  steps.push({ type: 'ai' });
  steps.push({ type: 'pause', ms: 300 });
  for (let i = 0; i < s.wordRepeats; i++) { steps.push({ type: 'say', text: word, lang: 'en', role: 'word' }); steps.push({ type: 'pause', ms: 350 }); }
  for (let i = 0; i < s.sentenceRepeatsAfterWord; i++) { steps.push({ type: 'say', text: sentence, lang: 'en', role: 'sentence' }); steps.push({ type: 'pause', ms: 400 }); }
  return steps;
}

/** Phrase/sentence script: the sentence once, the breakdown, the sentence again, then continue. */
export function sentenceScript(sentence: string, s: ScriptSettings): ScriptStep[] {
  const before = Math.max(1, Math.ceil(s.sentenceRepeatsForPhrase / 2));
  const after = Math.max(0, s.sentenceRepeatsForPhrase - before);
  const steps: ScriptStep[] = [];
  for (let i = 0; i < before; i++) { steps.push({ type: 'say', text: sentence, lang: 'en', role: 'sentence' }); steps.push({ type: 'pause', ms: 400 }); }
  steps.push({ type: 'ai' });
  steps.push({ type: 'pause', ms: 300 });
  for (let i = 0; i < after; i++) { steps.push({ type: 'say', text: sentence, lang: 'en', role: 'sentence' }); steps.push({ type: 'pause', ms: 400 }); }
  return steps;
}

/** Passage ("last 30 seconds") and free question: just the explanation. */
export function plainScript(): ScriptStep[] { return [{ type: 'ai' }]; }

/** Expands the AI marker into spoken steps from the parsed reply. */
export function aiSteps(parts: ExplanationParts, s: ScriptSettings, zhAvailable: boolean): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (const t of spokenEnglish(parts)) { steps.push({ type: 'say', text: t, lang: 'en', role: 'explanation' }); steps.push({ type: 'pause', ms: 250 }); }
  if (s.speakChinese && zhAvailable) {
    for (const t of spokenChinese(parts)) { steps.push({ type: 'say', text: t, lang: 'zh', role: 'chinese' }); steps.push({ type: 'pause', ms: 250 }); }
  }
  return steps;
}
