/**
 * THE RULE of level100.ts for one word of a page (the reader, the browser): a word is marked only when its number is
 * HIGHER than the learner's level and it is not known; a word still being learned is marked whatever its number; a
 * known (or ignored) word is never marked. No AI: the built-in dictionary and the frequency table only.
 */
import type { Dictionary } from '@core/dict/types';
import type { WordStatus } from '@shared/settings';
import { wordNumber, harderThan } from './level100';

export type WordMark = 'hard' | 'learning' | null;
export interface LevelCtx {
  dict: Pick<Dictionary, 'lookup' | 'lemmaOf'>;
  zipf: (word: string) => number | null;
  /** the vocabulary: lemma -> status */
  words: Record<string, WordStatus | undefined>;
  /** 0 … 100 */
  myLevel: number;
  /** names of this text (lower case): never marked */
  names?: ReadonlySet<string>;
}

/** a token that can be a word to learn: letters (with ' or - inside), at least two of them */
export const isWordToken = (token: string): boolean => /^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]*[A-Za-zÀ-ɏ]$/.test(token);

/** 0 (easiest) … 100 (hardest); null = nothing is known about it (a name, a typing mistake, another language) */
export function difficultyOf(token: string, ctx: Pick<LevelCtx, 'dict' | 'zipf'>): number | null {
  if (!isWordToken(token)) return null;
  const look = ctx.dict.lookup(token);
  const lemma = look?.lemma ?? token.toLowerCase();
  const zForm = ctx.zipf(token.toLowerCase()), zLemma = ctx.zipf(lemma);
  if (!look && zForm === null && zLemma === null) return null;
  // (a word with a capital that the frequency table does not have: a name)
  if (/^\p{Lu}/u.test(token) && zForm === null && zLemma === null) return null;
  // (the SAME number as in a video: level100.ts wordNumber, so a word is hard everywhere or nowhere)
  return wordNumber(zForm, zLemma, look?.entry.level ?? null);
}

export function markOf(token: string, ctx: LevelCtx): WordMark {
  if (!isWordToken(token)) return null;
  const lemma = ctx.dict.lemmaOf(token);
  const st = ctx.words[lemma];
  if (st === 'known' || st === 'ignored') return null;
  if (st === 'learning') return 'learning';
  if (ctx.names?.has(token.toLowerCase())) return null;
  const d = difficultyOf(token, ctx);
  return d !== null && harderThan(d, ctx.myLevel) ? 'hard' : null;
}

/** the dictionary card of a word: its pronunciation and its first Chinese meanings ('' when the dictionary has none) */
export function cardOf(token: string, dict: Pick<Dictionary, 'lookup' | 'lemmaOf'>): { lemma: string; ipa: string; zh: string } {
  const look = dict.lookup(token);
  const zh = (look?.entry.zh ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2).join('；');
  const ipa = look?.entry.ipa ? `/${look.entry.ipa.replace(/^\/+|\/+$/g, '')}/` : '';
  return { lemma: dict.lemmaOf(token), ipa, zh: zh.length > 60 ? `${zh.slice(0, 58)}…` : zh };
}
