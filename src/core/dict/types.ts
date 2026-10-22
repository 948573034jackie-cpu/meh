import type { CefrLevel } from '@core/model';

export interface DictEntry {
  word: string;
  ipa: string;
  zh: string;
  tags: string[];
  frq: number;
  bnc: number;
  collins: number;
  oxford: boolean;
  level: CefrLevel;
  levelSource: 'cefrj' | 'oct' | 'est';
}

export interface LookupResult {
  entry: DictEntry;
  /** the dictionary headword that matched */
  lemma: string;
  /** how the match was found */
  via: 'exact' | 'possessive' | 'form' | 'suffix' | 'fold';
}

/**
 * Offline dictionary (ECDICT + ipa-dict + CEFR-J/Octanove), loaded from resources/dict/dict.json.gz.
 * Implemented in src/core/dict/dictionary.ts; see test/unit/dictionary.test.ts.
 */
export interface Dictionary {
  size: number;
  /** Looks up a single token as it appears in text (any case, curly or straight apostrophes). */
  lookup(token: string): LookupResult | null;
  /** Looks up a multi-word phrase (2-5 words, as they appear in the text). */
  lookupPhrase(words: string[]): LookupResult | null;
  /** The lemma used as the key for vocabulary status (lookup lemma, else the folded lower-cased token). */
  lemmaOf(token: string): string;
}
