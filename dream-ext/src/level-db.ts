/**
 * The learner's vocabulary database: known words, still-learning words, every Level Check and the current level.
 * The words themselves stay in My Vocabulary (drVocab, drEntries); this adds the dates, the sentence where a word was
 * met and the tests (drLevel). The background turns it all into one JSON document (level-db-bg.ts): on the Mac the
 * small helper writes ~/Documents/MEH English/vocabulary.json and its iCloud Drive / Google Drive copies; on the
 * iPhone the app writes it to the folder you chose (VocabFile.swift). Before every write the other devices' copy is
 * read and merged in (mergeDocs), so the Mac and the phone share one database and nothing is lost.
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
  /** words taken out (removed, or ignored) on a device since the last merge: the other device takes them out too */
  removed?: { item: string; date: string }[];
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

/** one word or phrase of a document, with its status */
interface Rec { status: 'known' | 'learning'; item: string; date: string; sentence?: string; group?: GroupId }
/** what the merge changes on this device: a status for an item, or null = take it out */
export interface DocChange { item: string; status: 'known' | 'learning' | null; date?: string; sentence?: string; group?: GroupId }
export interface MergeResult { doc: VocabularyDoc; changes: DocChange[] }

/** the same word or phrase, however it is written */
export const itemId = (s: string): string => s.trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
const testId = (t: LevelTest): string => `${t.date}|${t.source}|${JSON.stringify(t.scores ?? {})}`;

function indexDoc(d: VocabularyDoc | null | undefined): Map<string, Rec> {
  const m = new Map<string, Rec>();
  if (!d) return m;
  const put = (r: Rec) => {
    if (typeof r.item !== 'string' || !r.item.trim()) return;
    const k = itemId(r.item);
    const cur = m.get(k);
    if (!cur || r.date > cur.date) m.set(k, r);
  };
  for (const k of d.known ?? []) put({ status: 'known', item: k.item, date: String(k.date ?? '') });
  for (const l of d.stillLearning ?? []) put({ status: 'learning', item: l.item, date: String(l.date ?? ''), sentence: l.sentence ?? '', ...(l.group ? { group: l.group } : {}) });
  return m;
}

/**
 * This device's database and the other device's copy (the shared file) as one, knowing what both had at the last
 * merge (`base`, null the first time). Only what the OTHER device changed since then comes in:
 * - a word it added or gave another status: taken (both changed it: the newest date wins, a tie = this device);
 * - a word it did not touch stays as it is here, also when it was removed or ignored here (it does not come back);
 * - a word it took out (its `removed` list) is taken out here too, unless this device met it again later.
 * `skip` = the items this device ignores: never taken, and told to the other device as taken out.
 * Every test once; the level of the copy with the newest test. Returns the merged document (what goes to the file)
 * and the changes to make on this device.
 */
export function mergeDocs(mine: VocabularyDoc, others: VocabularyDoc[], base: VocabularyDoc | null = null, skip: ReadonlySet<string> = new Set(), now: Date = new Date()): MergeResult {
  const today = dayOf(now.toISOString());
  const B = indexDoc(base), M0 = indexDoc(mine);
  const cur = new Map(M0);
  // taken out here since the last merge (or before, and still out)
  const gone = new Map<string, { item: string; date: string }>();
  const oldGone = new Map<string, string>();
  for (const r of base?.removed ?? []) { if (r && typeof r.item === 'string') { oldGone.set(itemId(r.item), String(r.date ?? '')); if (!M0.has(itemId(r.item))) gone.set(itemId(r.item), { item: r.item, date: String(r.date ?? '') }); } }
  for (const [k, b] of B) if (!M0.has(k) && !gone.has(k)) gone.set(k, { item: b.item, date: today });
  for (const T of others) {
    for (const [k, t] of indexDoc(T)) {
      const b = B.get(k), m = cur.get(k);
      if (skip.has(k)) { if (!gone.has(k)) gone.set(k, { item: t.item, date: today }); continue; }
      if (b && b.status === t.status) continue; // the other device did not change it: this device's word (or its removal) stands
      if (!m) {
        const out = gone.get(k);
        if (out && t.date <= out.date) continue; // taken out here after that
        cur.set(k, t); gone.delete(k);
        continue;
      }
      if (m.status === t.status) continue;
      const mineChanged = !b || b.status !== m.status;
      if (!mineChanged || t.date > m.date) cur.set(k, t);
    }
    // what the other device took out since the last merge
    for (const r of T.removed ?? []) {
      if (!r || typeof r.item !== 'string') continue;
      const k = itemId(r.item), date = String(r.date ?? '');
      if (oldGone.get(k) === date) continue; // old news: handled at an earlier merge
      const m = cur.get(k);
      if (m && m.date > date) continue; // met again here after it was taken out there
      if (m) cur.delete(k);
      if (!gone.has(k)) gone.set(k, { item: r.item, date });
    }
  }
  const known: VocabularyDoc['known'] = [], stillLearning: VocabularyDoc['stillLearning'] = [];
  for (const r of cur.values()) {
    if (r.status === 'known') known.push({ item: r.item, date: r.date });
    else stillLearning.push({ item: r.item, date: r.date, sentence: r.sentence ?? '', ...(r.group ? { group: r.group } : {}) });
  }
  const changes: DocChange[] = [];
  for (const [k, r] of cur) { const m = M0.get(k); if (!m || m.status !== r.status) changes.push({ item: r.item, status: r.status, date: r.date, ...(r.sentence ? { sentence: r.sentence } : {}), ...(r.group ? { group: r.group } : {}) }); }
  for (const [k, m] of M0) if (!cur.has(k)) changes.push({ item: m.item, status: null });
  const docs = [mine, ...others];
  const tests = new Map<string, LevelTest>();
  for (const d of docs) for (const t of d.tests ?? []) { const k = testId(t); if (!tests.has(k)) tests.set(k, t); }
  const testList = [...tests.values()].sort((a, b) => a.date.localeCompare(b.date));
  const newestTest = (d: VocabularyDoc) => (d.tests ?? []).reduce((m, t) => (t.date > m ? t.date : m), '');
  const level = docs.filter((d) => d.currentLevel).sort((a, b) => newestTest(b).localeCompare(newestTest(a)))[0]?.currentLevel ?? mine.currentLevel;
  const order = (a: { item: string }, b: { item: string }) => a.item.localeCompare(b.item);
  // (the taken-out list stays short: the newest 300)
  const removed = [...gone.entries()].filter(([k]) => !cur.has(k)).map(([, r]) => r).sort((a, b) => b.date.localeCompare(a.date) || a.item.localeCompare(b.item)).slice(0, 300);
  const doc: VocabularyDoc = { version: 1, updatedAt: now.toISOString(), currentLevel: level, tests: testList, known: known.sort(order), stillLearning: stillLearning.sort(order), ...(removed.length ? { removed } : {}) };
  return { doc, changes };
}

/** the same words with the same statuses, the same tests and level? (dates and sentences apart) */
export function sameDoc(a: VocabularyDoc, b: VocabularyDoc): boolean {
  const sig = (d: VocabularyDoc) => JSON.stringify([
    d.known.map((k) => k.item.toLowerCase()).sort(), d.stillLearning.map((l) => l.item.toLowerCase()).sort(),
    d.tests.map(testId).sort(), d.currentLevel,
  ]);
  return sig(a) === sig(b);
}

/** something read from a file: is it one of these documents? */
export function isDoc(x: unknown): x is VocabularyDoc {
  const d = x as Partial<VocabularyDoc> | null;
  return !!d && typeof d === 'object' && Array.isArray(d.known) && Array.isArray(d.stillLearning) && Array.isArray(d.tests);
}
