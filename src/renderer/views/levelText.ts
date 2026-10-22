import type { CefrLevel } from '@core/model';
import { levelIndex } from '@core/model';
import type { LevelResult } from '@core/level/score';

/**
 * Texts of the level test screen (LevelTest.tsx), kept pure so they can be unit-tested. Simple English
 * throughout: the reader is a learner who may be at A2.
 */

export const LEVEL_TEST_VIEW_ID = 'leveltest';

/** Items of a full test: 50 + 50 (STAGE1_PER_BAND x 8 + STAGE1_PSEUDO, STAGE2_REAL + STAGE2_PSEUDO). */
export const TOTAL_STAGES = 2;

export const INTRO_TITLE = 'How many English words do you know?';
export const INTRO_LINES = [
  'You will see one word at a time.',
  'Do you know this word? Tap Yes if you know what it means. Tap No if you are not sure.',
  'Some words are not real words. So please be honest: a "Yes" on a fake word lowers your score.',
  'It takes about 5 minutes. There is no pass or fail.',
];

export const LEVEL_NAMES: Record<CefrLevel, string> = {
  A1: 'Beginner', A2: 'Elementary', B1: 'Intermediate', B2: 'Upper intermediate', C1: 'Advanced', C2: 'Near native',
};

/** What the level means for reading in this app, in one friendly sentence. */
export const READING_NOTES: Record<CefrLevel, string> = {
  A1: 'Start with very short, simple stories. The app will explain many words, so take it slowly and enjoy it.',
  A2: 'Short stories and graded readers are a good fit. The app will stop often to explain words; that is normal.',
  B1: 'You can read simple novels and most news. The app will explain the harder words as you go.',
  B2: 'You can read most novels with some help. The app will explain the less common words.',
  C1: 'You can read almost any book. The app will only stop at rare or special words.',
  C2: 'You read like a native speaker. The app will stay quiet most of the time.',
};

export function formatWords(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** "12 of 50" */
export function progressText(index: number, total: number): string {
  return `${Math.min(index + 1, total)} of ${total}`;
}

/** "Stage 1 of 2" */
export function stageText(stage: number): string {
  return `Stage ${stage} of ${TOTAL_STAGES}`;
}

/** "Your level: B2" */
export function levelHeadline(result: LevelResult): string {
  return `Your level: ${result.cefr}`;
}

/** "probably B1 to C1", or "quite sure" when the interval stays inside one level */
export function rangeText(result: LevelResult): string {
  const [lo, hi] = result.cefrRange;
  if (lo === hi) return `quite sure it is ${lo}`;
  return `probably ${lo} to ${hi}`;
}

/** "about 5,500 words" (the lemma estimate; families are not shown, the number would only confuse) */
export function sizeText(result: LevelResult): string {
  return `about ${formatWords(result.sizeLemmas)} words`;
}

/** "You know about 5,500 of the 20,000 most common English words." */
export function sizeSentence(result: LevelResult): string {
  return `You know ${sizeText(result)} of the 20,000 most common English words.`;
}

/** One friendly sentence on what the level means for reading. */
export function readingNote(result: LevelResult): string {
  return READING_NOTES[result.cefr];
}

export const UNRELIABLE_TITLE = 'We could not measure your level this time';
export const UNRELIABLE_TEXT = 'You said "Yes" to many words that are not real. That makes the result unreliable. Please try again and tap "No" when you are not sure.';

/** The whole result message in one object, for the result screen and for tests. */
export interface LevelMessage {
  reliable: boolean;
  title: string;
  /** small text under the title */
  subtitle: string;
  /** one or two sentences of body text */
  body: string;
}

export function levelMessage(result: LevelResult): LevelMessage {
  if (!result.reliable) return { reliable: false, title: UNRELIABLE_TITLE, subtitle: 'Please try again', body: UNRELIABLE_TEXT };
  return {
    reliable: true,
    title: levelHeadline(result),
    subtitle: `${LEVEL_NAMES[result.cefr]} · ${rangeText(result)}`,
    body: `${sizeSentence(result)} ${readingNote(result)}`,
  };
}

/** Compared with the level the learner had before: "same as before", "one level up from B1", "two levels down from C1". */
export function changeText(result: LevelResult, previous: CefrLevel | null): string | null {
  if (!previous || !result.reliable) return null;
  const d = levelIndex(result.cefr) - levelIndex(previous);
  if (d === 0) return `The same as your level before (${previous}).`;
  const n = Math.abs(d) === 1 ? 'One level' : Math.abs(d) === 2 ? 'Two levels' : `${Math.abs(d)} levels`;
  return `${n} ${d > 0 ? 'up' : 'down'} from your level before (${previous}).`;
}

/** Keyboard: Y, J, ArrowRight = Yes; N, K, ArrowLeft = No; anything else = null. Space is not used on purpose. */
export function answerForKey(code: string): boolean | null {
  switch (code) {
    case 'KeyY': case 'KeyJ': case 'ArrowRight': return true;
    case 'KeyN': case 'KeyK': case 'ArrowLeft': return false;
    default: return null;
  }
}
