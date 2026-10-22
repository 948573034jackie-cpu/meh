/**
 * Hard sentences: before you watch, the cheap model reads the video's sentences and picks the ones that are hard
 * for your level when you only hear them (difficult grammar, idioms, an unusual word order, a cultural meaning,
 * fast slang). The tutor stops after each of them like after a hard word: it plays the sentence, explains it
 * (RULE TWO) and plays it again. At most about one per minute of video, so the video still flows.
 */
import type { PromptBundle } from '@core/ai/prompts';

export const HARD_PER_SECONDS = 70;

export function buildHardSentencesPrompt(lines: string[], o: { level: string; title: string; max: number }): PromptBundle {
  return {
    system: 'You are an experienced teacher of English as a second language. You judge which spoken sentences a learner will not understand. Answer only with JSON.',
    user: `Video: ${o.title || 'YouTube video'}. The learner's English is about CEFR ${o.level}; their first language is Chinese.

Here are numbered sentences from the video. Which of them would this learner NOT understand when they only hear them once, even if they know most single words? Think of difficult grammar, long sentences with several parts, idioms and phrasal verbs, an unusual word order, a cultural or hidden meaning, sarcasm, fast slang. Do not choose a sentence only because it has one hard word. Choose at most ${o.max}, the most useful ones, or none.

Answer only with JSON like {"hard":[3,17]}.

${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
    maxTokens: 120,
  };
}

/** {"hard":[3,17]} -> [2,16] (0-based), valid and unique, at most `max`. */
export function parseHardSentences(raw: string, count: number, max: number): number[] {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]) as { hard?: unknown };
    const list = Array.isArray(j.hard) ? j.hard : [];
    const out: number[] = [];
    for (const x of list) {
      const n = Math.round(Number(x)) - 1;
      if (Number.isFinite(n) && n >= 0 && n < count && !out.includes(n)) out.push(n);
      if (out.length >= max) break;
    }
    return out.sort((a, b) => a - b);
  } catch { return []; }
}
