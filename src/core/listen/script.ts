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

// ---------------------------------------------------------------------------------------------
// Style-shaped scripts (Dream Read): the shape comes from the explanation style, the AI reply is prose.

import type { ScriptShape } from '@shared/styles';
import { splitAtPause } from '@shared/styles';
import { cleanSpokenProse } from '@core/ai/prompts';

/** A silent wait for the learner (quiz question); the controller ends it on an answer or after its timeout. */
export type WaitStep = { type: 'wait' };
export type AnyStep = ScriptStep | WaitStep;

const WORD_GAP = 350, SENTENCE_GAP = 400;

export function styledWordScript(word: string, sentence: string, shape: ScriptShape): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (let i = 0; i < shape.wordBefore; i++) steps.push({ type: 'say', text: word, lang: 'en', role: 'word' }, { type: 'pause', ms: WORD_GAP });
  steps.push({ type: 'ai' }, { type: 'pause', ms: 300 });
  for (let i = 0; i < shape.wordAfter; i++) steps.push({ type: 'say', text: word, lang: 'en', role: 'word' }, { type: 'pause', ms: WORD_GAP });
  for (let i = 0; i < shape.sentenceAfterWord; i++) steps.push({ type: 'say', text: sentence, lang: 'en', role: 'sentence' }, { type: 'pause', ms: SENTENCE_GAP });
  return steps;
}

export function styledSentenceScript(sentence: string, shape: ScriptShape): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (let i = 0; i < shape.sentenceBefore; i++) steps.push({ type: 'say', text: sentence, lang: 'en', role: 'sentence' }, { type: 'pause', ms: SENTENCE_GAP });
  steps.push({ type: 'ai' }, { type: 'pause', ms: 300 });
  for (let i = 0; i < shape.sentenceAfter; i++) steps.push({ type: 'say', text: sentence, lang: 'en', role: 'sentence' }, { type: 'pause', ms: SENTENCE_GAP });
  return steps;
}

/**
 * Turns a prose reply into spoken steps, one per paragraph, with a wait step where the style put [PAUSE].
 * An optional Chinese meaning (dictionary) is spoken with the Chinese voice at the end.
 */
export function proseSteps(text: string, opts: { zh?: string | null; speakChinese: boolean; zhAvailable: boolean }): AnyStep[] {
  const steps: AnyStep[] = [];
  const chinese = opts.speakChinese && opts.zhAvailable;
  const [first, rest] = splitAtPause(text);
  const add = (t: string) => {
    for (const para of cleanSpokenProse(t).split(/\n\s*\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      // Chinese inside the English reply goes to the Chinese voice (an English voice reads it as "Chinese letter");
      // with Chinese switched off it is left out of the speech
      for (const run of splitByScript(para)) {
        if (run.zh) { if (chinese) steps.push({ type: 'say', text: run.text, lang: 'zh', role: 'chinese' }); }
        else if (/[\p{L}\p{N}]/u.test(run.text)) steps.push({ type: 'say', text: run.text, lang: 'en', role: 'explanation' });
      }
      steps.push({ type: 'pause', ms: 250 });
    }
  };
  add(first);
  if (rest !== null) { steps.push({ type: 'wait' }); add(rest); }
  const zh = opts.zh ? twoMeanings(opts.zh) : '';
  if (chinese && zh) steps.push({ type: 'pause', ms: 300 }, { type: 'say', text: zh, lang: 'zh', role: 'chinese' }, { type: 'pause', ms: 250 });
  return steps;
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** Splits text into runs of Chinese and non-Chinese; Chinese punctuation stays with the Chinese run. */
export function splitByScript(text: string): { text: string; zh: boolean }[] {
  const out: { text: string; zh: boolean }[] = [];
  const re = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF][\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF\s]*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), zh: false });
    out.push({ text: m[0].trim(), zh: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), zh: false });
  return out.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
}

/**
 * The two Chinese meanings to say at the end: from a dictionary line like "a. 尖刻的, 讥讽的, 激烈的" or an AI
 * pair ["尖刻的", "刻薄的"]. Part-of-speech marks, brackets and Latin letters are removed; at most two, no repeats.
 */
export function twoMeanings(raw: string | string[]): string {
  const parts = (Array.isArray(raw) ? raw : raw.split(/[,，;；、/\n]/))
    .map((x) => x.replace(/\b[a-z]{1,5}\.\s*/gi, '').replace(/[(（[【][^)）\]】]*[)）\]】]/g, '').replace(/[A-Za-z]/g, '').trim())
    .filter((x) => CJK.test(x));
  return [...new Set(parts)].slice(0, 2).join('，');
}
