/**
 * What the reader and the browser save, the same way the videos do: a word that was explained is "learning" and goes
 * into My Vocabulary with its sentence and explanation (the count of explanations goes up); explained
 * `knownAfter` times it counts as known; a tap on its card = known.
 */
import type { VocabEntryInput } from '@shared/api';
import * as store from './store';

/** the word was tapped (before the explanation comes): still learning, unless it is known already */
export async function markLearning(lemma: string, word: string, sentence: string): Promise<void> {
  const v = await store.getVocab();
  if (v.words[lemma] === 'known') return;
  await store.setWordStatus(lemma, 'learning', { word, sentence });
}

export async function markKnown(lemma: string, word: string): Promise<void> {
  await store.setWordStatus(lemma, 'known', { word });
}

/** the explanation is done: into My Vocabulary; true = it was explained `knownAfter` times and is known from now on */
export async function saveExplained(input: VocabEntryInput, knownAfter: number): Promise<{ times: number; nowKnown: boolean }> {
  const entry = await store.upsertEntry(input);
  const v = await store.getVocab();
  const st = v.words[input.lemma];
  if (knownAfter > 0 && entry.timesExplained >= knownAfter && st !== 'known' && st !== 'ignored') {
    await store.setWordStatus(input.lemma, 'known', { word: input.word });
    return { times: entry.timesExplained, nowKnown: true };
  }
  return { times: entry.timesExplained, nowKnown: false };
}
