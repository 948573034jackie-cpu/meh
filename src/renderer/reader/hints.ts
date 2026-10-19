import type { CefrLevel } from '@core/model';
import type { VocabState } from '@shared/settings';
import type { WordInfo } from '@core/vocab/analysis';
import { isAboveLevel } from '@core/vocab/analysis';
import { parseGloss } from '@core/dict/dictionary';

/**
 * Word Wise-style hints: a short Chinese meaning under the words above the learner's level. Pure helpers so
 * the rule ("which words, which text") is testable without a DOM.
 */

/** Longest hint shown under a word; longer glosses are cut at a sense boundary. */
export const HINT_MAX_CHARS = 6;

/** A word gets a hint when it is above the learner's level, not a name, not known/ignored/learning, and the dictionary has a gloss. */
export function wantsHint(info: WordInfo | null, learner: CefrLevel, vocab: VocabState['words']): boolean {
  if (!info || info.isName || !info.entry) return false;
  if (vocab[info.lemma]) return false;
  return isAboveLevel(info, learner);
}

/**
 * The hint text for a dictionary gloss: the first sense of the first line, without the part-of-speech tag,
 * cut at a separator so it stays within `max` characters ("n. 房子, 住宅; 家庭" -> "房子").
 * A later AI job may replace these with context-aware hints (the `hints` map on the book position).
 */
export function hintText(zh: string, max = HINT_MAX_CHARS): string {
  if (!zh) return '';
  const g = parseGloss(zh).find((x) => x.zh.trim().length > 0);
  if (!g) return '';
  let s = g.zh.replace(/\[[^\]]*\]|<[^>]*>|\([^)]*\)|（[^）]*）/g, '').trim();
  // first sense: cut at the first separator
  const sep = s.search(/[,，;；、/|]/);
  if (sep > 0) s = s.slice(0, sep).trim();
  if (!s) return '';
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** The hint for a word, or '' when it should not have one. */
export function hintFor(info: WordInfo | null, learner: CefrLevel, vocab: VocabState['words'], override?: string): string {
  if (!wantsHint(info, learner, vocab)) return '';
  if (override) return override.length > HINT_MAX_CHARS ? `${override.slice(0, HINT_MAX_CHARS - 1)}…` : override;
  return hintText(info!.entry!.zh);
}
