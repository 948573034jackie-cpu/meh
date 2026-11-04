/**
 * The learner's vocabulary database: known words, still-learning words, every Level Check and the current level.
 * The words themselves stay in My Vocabulary (drVocab, drEntries); this adds the dates, the sentence where a word was
 * met and the tests (drLevel). The background turns it all into one JSON document, written to
 * ~/Documents/MEH English/vocabulary.json and the Google Drive copy by the small helper on the Mac (level-db-bg.ts).
 */
import type { Dictionary } from '@core/dict/types';
import type { VocabEntry } from '@shared/api';
import type { WordStatus } from '@shared/settings';

export type GroupId = 'b2' | 'c1' | 'c2';
export const GROUP_LABEL: Record<GroupId, string> = { b2: 'B2', c1: 'C1', c2: 'C2 + idioms + slang' };
export type GroupScores = Record<GroupId, number | null>;

export interface LevelTest { date: string; source: string; scores: GroupScores; level: string }
export interface WordLog { word: string; date: string; sentence?: string; group?: GroupId }
export interface LevelMeta {
  tests: LevelTest[];
  /** in words, e.g. "about lower B2 for reading" */
  currentLevel: string;
  /** lemma -> when it got its status, the word as met, the sentence */
  log: Record<string, WordLog>;
  seeded: number;
  /** "Copy my level for Claude": "new known words" = since this moment */
  lastCopyAt?: string;
}
export const EMPTY_META: LevelMeta = { tests: [], currentLevel: '', log: {}, seeded: 0 };

export const SEED_VERSION = 1;
const SEED_DATE = '2026-11-04';
/** the learner's starting data (their two tests of 4 Nov 2026) */
export const SEED = {
  currentLevel: 'about lower B2 for reading',
  tests: [
    { date: SEED_DATE, source: 'Eveline', scores: { b2: 45, c1: 5, c2: 13 }, level: 'lower B2' },
    { date: SEED_DATE, source: 'After Twenty Years', scores: { b2: 42, c1: 0, c2: 0 }, level: 'lower B2' },
  ] as LevelTest[],
  known: ['familiar', 'shelter', 'threaten', 'violence', 'explore', 'quarrel', 'glimpse', 'respect', 'duty', 'weary', 'look lively', 'fallen on his feet', 'impressive', 'appointment', 'destiny', 'fortune', 'release'],
  learning: {
    b2: ['invade', 'odour', 'consent', 'distress', 'wages', 'impulse', 'terror', 'passive', 'recognition', 'barrier', 'mist', 'habitual', 'spectator', 'intricate', 'reassure', 'scar', 'drizzle', 'arrest'],
    c1: ['squabble', 'squander', 'provisions', 'elated', 'courting', 'latterly', 'palpitations', 'mournful', 'nausea', 'fervent', 'anguish', 'frenzy', 'clutch', 'seize', 'melancholy', 'pitiful', 'commonplace', 'lodging', 'sacrifice', 'gust', 'vicinity', 'stalwart', 'swagger', 'thoroughfare', 'correspond', 'plodder', 'egotism', 'submerged', 'glare', 'simultaneously', 'dismally'],
    c2: ['invariable', 'keep nix', 'had an edge on her', 'laid up', 'strutting', 'mused', 'the very quick of her being', 'quay', 'illumined', 'cretonne', 'harmonium', 'bonnet', 'porthole', 'maze of distress', 'on the beat', 'well nigh', 'kept early hours', 'best chum', 'you bet', 'get my pile', 'in a groove', 'a razor-edge', 'call time on him', 'so long', 'sure as fate', 'bully (great)', 'plain clothes man', 'wires us'],
  } as Record<GroupId, string[]>,
};

/** the vocabulary key of a word or phrase: the dictionary's lemma, a phrase in lower case ("bully (great)" -> "bully") */
export function itemKey(dict: Pick<Dictionary, 'lemmaOf'>, text: string): string {
  const t = text.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return /\s/.test(t) ? t.toLowerCase().replace(/[\u2019]/g, "'") : dict.lemmaOf(t);
}

const LOOSE = new Set(['a', 'an', 'the', 'his', 'her', 'hers', 'him', 'my', 'me', 'your', 'our', 'us', 'their', 'them', 'its', "one's", 'one', 'someone', "someone's", 'somebody', "somebody's", 'something', 'sth', 'sb']);
/** the same phrase in another form ("fallen on his feet", "fall on one's feet") gets the same signature */
export function phraseSig(dict: Pick<Dictionary, 'lemmaOf'>, text: string): string {
  const out: string[] = [];
  for (const w of text.toLowerCase().replace(/[\u2019]/g, "'").split(/[^\p{L}'-]+/u)) if (w && !LOOSE.has(w)) out.push(dict.lemmaOf(w));
  return out.join(' ');
}

/** every word and phrase of the starting data, as vocabulary keys */
export function seedWords(dict: Pick<Dictionary, 'lemmaOf'>): { words: Record<string, 'known' | 'learning'>; log: Record<string, WordLog> } {
  const words: Record<string, 'known' | 'learning'> = {};
  const log: Record<string, WordLog> = {};
  for (const [g, list] of Object.entries(SEED.learning) as [GroupId, string[]][]) for (const word of list) {
    const k = itemKey(dict, word);
    words[k] = 'learning';
    log[k] = { word, date: SEED_DATE, group: g };
  }
  for (const word of SEED.known) { const k = itemKey(dict, word); words[k] = 'known'; log[k] = { word, date: SEED_DATE }; }
  return { words, log };
}

/** What the learner's percentages say. */
export function estimateLevel(s: GroupScores): { label: string; cefr: 'B1' | 'B2' | 'C1' | 'C2' } {
  const b2 = s.b2 ?? 0, c1 = s.c1 ?? 0, c2 = s.c2 ?? 0;
  if (c1 >= 80 && c2 >= 50) return { label: 'C2', cefr: 'C2' };
  if (b2 >= 80 && c1 >= 50) return { label: 'C1', cefr: 'C1' };
  if (b2 >= 70) return { label: 'upper B2', cefr: 'B2' };
  if (b2 >= 55) return { label: 'B2', cefr: 'B2' };
  if (b2 >= 35) return { label: 'lower B2', cefr: 'B2' };
  return { label: 'B1', cefr: 'B1' };
}

export type Chance = Record<'A' | 'B1' | 'B2' | 'C1' | 'C2', number>;
/** How likely a word of each level is unknown to the learner: from the newest test (the groups it had), else a guess. */
export function unknownChance(tests: readonly LevelTest[]): Chance {
  const out: Chance = { A: 0, B1: 0.1, B2: 0.5, C1: 0.9, C2: 0.95 };
  for (const t of tests) {
    if (t.scores.b2 !== null) out.B2 = 1 - t.scores.b2 / 100;
    if (t.scores.c1 !== null) out.C1 = 1 - t.scores.c1 / 100;
    if (t.scores.c2 !== null) out.C2 = 1 - t.scores.c2 / 100;
  }
  return out;
}

export interface VocabularyDoc {
  version: 1;
  updatedAt: string;
  currentLevel: string;
  tests: LevelTest[];
  known: { item: string; date: string }[];
  stillLearning: { item: string; date: string; sentence: string; group?: GroupId }[];
}

const dayOf = (iso: string | undefined): string => (iso ?? '').slice(0, 10);
/** the one JSON document (the file on the Mac, the internet copy) */
export function buildDoc(meta: LevelMeta, words: Record<string, WordStatus>, entries: Record<string, VocabEntry>, now: Date = new Date()): VocabularyDoc {
  const known: VocabularyDoc['known'] = [], stillLearning: VocabularyDoc['stillLearning'] = [];
  for (const [lemma, st] of Object.entries(words)) {
    if (lemma.startsWith('sentence: ')) continue; // whole sentences explained: not words
    const l = meta.log[lemma], e = entries[lemma];
    const item = l?.word || e?.word || lemma;
    const date = l?.date || dayOf(e?.lastSeenAt) || dayOf(now.toISOString());
    if (st === 'known') known.push({ item, date });
    else if (st === 'learning') stillLearning.push({ item, date, sentence: l?.sentence || e?.sentence || '', ...(l?.group ? { group: l.group } : {}) });
  }
  const order = (a: { item: string }, b: { item: string }) => a.item.localeCompare(b.item);
  return { version: 1, updatedAt: now.toISOString(), currentLevel: meta.currentLevel, tests: meta.tests, known: known.sort(order), stillLearning: stillLearning.sort(order) };
}

/** "Copy my level for Claude": level, tests, the known words that are new since the last copy, all still-learning words. */
export function levelSummary(doc: VocabularyDoc, lastCopyAt?: string): string {
  const since = dayOf(lastCopyAt);
  const fresh = doc.known.filter((k) => !since || k.date >= since).map((k) => k.item);
  const last = doc.tests[doc.tests.length - 1];
  const pct = (n: number | null) => (n === null ? 'none tested' : `${n}%`);
  return [
    `My English level: ${doc.currentLevel || 'not tested yet'}.`,
    last ? `Last Level Check (${last.date}, "${last.source}"): B2 ${pct(last.scores.b2)}, C1 ${pct(last.scores.c1)}, C2/idioms ${pct(last.scores.c2)}.` : '',
    `Known words and phrases: ${doc.known.length} in all.${fresh.length ? ` New${since ? ` since ${since}` : ''}: ${fresh.join(', ')}.` : ''}`,
    `Still learning (${doc.stillLearning.length}): ${doc.stillLearning.map((w) => w.item).join(', ') || 'none'}.`,
  ].filter(Boolean).join('\n');
}
