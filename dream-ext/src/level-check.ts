/**
 * The Level Check's tap test: built only from this video or text. Single words come from the dictionary's CEFR levels,
 * phrases, idioms and slang from the AI (kept only when they really are in the text). Nothing below B2, nothing
 * already in the learner's database, no sentences. Groups: B2, C1, C2 + idioms + slang.
 */
import type { Book, CefrLevel } from '@core/model';
import { sentenceText } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import { annotateSentence } from '@core/vocab/analysis';
import type { PromptBundle } from '@core/ai/prompts';
import { looksLikeFreeCombination } from '@core/dict/dictionary';
import { itemKey, phraseSig, type GroupId, type GroupScores } from './level-db';
import { looksEasy } from './level-stops';

export interface TestItem { text: string; key: string; group: GroupId; kind: 'word' | 'phrase' | 'idiom' | 'slang'; sentence: string }
export type TestGroups = Record<GroupId, TestItem[]>;
export interface AiItem { text: string; level: 'B2' | 'C1' | 'C2'; kind: 'phrase' | 'idiom' | 'slang' }

export const MIN_PER_GROUP = 12;
export const MAX_PER_GROUP = 20;
const GROUP_OF: Partial<Record<CefrLevel, GroupId>> = { B2: 'b2', C1: 'c1', C2: 'c2' };

/** at most this many words of the text go to the AI (enough to find its idioms; the cost stays small) */
const AI_WORDS = 7000;
export function buildItemsPrompt(lines: string[], title: string): PromptBundle {
  let words = 0;
  const text: string[] = [];
  for (const l of lines) { words += l.split(/\s+/).length; if (words > AI_WORDS) break; text.push(l); }
  return {
    system: 'You are an experienced teacher of English as a second language. You find the phrases in a text that a learner will not know. Answer only with JSON.',
    user: `Title: ${title || 'Untitled'}.

From the text below, list the multi-word phrases, phrasal verbs, idioms and slang that are at CEFR level B2 or above. Copy each one exactly as it is written in the text, in the same words. Slang may be one word. Do not list ordinary single words, free word combinations, names or whole sentences. List at most 30, the hardest ones.

Answer only with JSON like {"items":[{"t":"call it a day","level":"C1","kind":"idiom"}]}, where level is B2, C1 or C2 and kind is phrase, idiom or slang.

Text:
${text.join('\n')}`,
    maxTokens: 1200,
  };
}

const folded = (s: string): string => s.toLowerCase().replace(/[\u2019]/g, "'").replace(/[^\p{L}\p{N}'-]+/gu, ' ').trim();

/** The AI's answer: only what is really in the text (the test never brings words from elsewhere). */
export function parseItems(raw: string, lines: readonly string[]): AiItem[] {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return [];
  let list: unknown[] = [];
  try { const j = JSON.parse(m[0]) as { items?: unknown }; if (Array.isArray(j.items)) list = j.items; } catch { return []; }
  const hay = ` ${folded(lines.join(' '))} `;
  const out: AiItem[] = [];
  for (const x of list) {
    const o = x as { t?: unknown; level?: unknown; kind?: unknown };
    const text = String(o.t ?? '').trim();
    const f = folded(text);
    if (!f || f.split(' ').length > 8 || !hay.includes(` ${f} `)) continue;
    const kind = o.kind === 'idiom' || o.kind === 'slang' ? o.kind : 'phrase';
    if (kind !== 'slang' && !f.includes(' ')) continue;
    const level = o.level === 'C2' ? 'C2' : o.level === 'C1' ? 'C1' : o.level === 'B2' ? 'B2' : null;
    if (level) out.push({ text, level, kind });
  }
  return out;
}

export interface CollectOpts {
  book: Pick<Book, 'chapters'>;
  dict: Dictionary;
  names: Set<string>;
  /** the key (or the phrase's form) is already in the learner's database */
  inDatabase: (key: string, sig: string) => boolean;
  ai?: readonly AiItem[];
  /** how common a word is (a very common word is never in the test, whatever level the dictionary gives it) */
  zipf?: (word: string) => number | null;
}

/** Every item of the text for the test, in reading order. */
export function collectItems(o: CollectOpts): TestGroups {
  const groups: TestGroups = { b2: [], c1: [], c2: [] };
  const seen = new Set<string>();
  const add = (text: string, group: GroupId, kind: TestItem['kind'], sentence: string, key = itemKey(o.dict, text)) => {
    const sig = phraseSig(o.dict, text);
    if (seen.has(key) || seen.has(sig) || o.inDatabase(key, sig)) return;
    seen.add(key); seen.add(sig);
    groups[group].push({ text, key, group, kind, sentence });
  };
  const zipf = o.zipf ?? (() => null);
  const sentences: string[] = [];
  for (const ch of o.book.chapters) for (const para of ch.paragraphs) for (const s of para.sentences) {
    const text = sentenceText(para, s);
    sentences.push(text);
    // (above B1 = B2 and up: nothing easier ever comes into the test)
    const ann = annotateSentence(para, s, o.dict, o.names, 'B1');
    for (const ph of ann.phrases) {
      const g = ph.above ? GROUP_OF[ph.level] : undefined;
      // (a free combination, "turned to", is no phrase to test)
      if (g && !looksLikeFreeCombination(o.dict, ph.result.lemma.split(' '), ph.result.entry.zh)) add(s.tokens.slice(ph.start, ph.end).map((t) => t.text).join(' '), g, 'phrase', text, ph.result.lemma);
    }
    const firstWord = s.tokens.findIndex((t) => t.kind === 'word');
    for (const i of ann.hardTokens) {
      const info = ann.infos[i];
      const g = info?.level ? GROUP_OF[info.level] : undefined;
      if (!g || !info || looksEasy(s.tokens[i].text, zipf)) continue;
      // (a capital inside a sentence is a name the dictionary also has as a word: "Mel")
      if (i !== firstWord && /^\p{Lu}/u.test(s.tokens[i].text)) continue;
      add(s.tokens[i].text.toLowerCase(), g, 'word', text, info.lemma);
    }
  }
  for (const it of o.ai ?? []) {
    // idioms and slang are one group, whatever their level
    const g: GroupId = it.kind === 'phrase' ? (it.level === 'C2' ? 'c2' : it.level === 'C1' ? 'c1' : 'b2') : 'c2';
    const f = folded(it.text);
    add(it.text.toLowerCase(), g, it.kind, sentences.find((s) => ` ${folded(s)} `.includes(` ${f} `)) ?? '');
  }
  return groups;
}

export interface Screen { width: number; height: number }
const CHIP_H = 31, CHIP_GAP = 5, CHAR_W = 6.9, CHIP_PAD = 20, HEAD_H = 24;
/** how tall the chips of a group are, with the chips wrapped like the page does it */
export function chipsHeight(items: readonly { text: string }[], width: number): number {
  let rows = items.length ? 1 : 0, x = 0;
  for (const it of items) {
    const w = Math.min(width, it.text.length * CHAR_W + CHIP_PAD);
    if (x > 0 && x + w > width) { rows++; x = 0; }
    x += w + CHIP_GAP;
  }
  return rows * (CHIP_H + CHIP_GAP);
}

/** Evenly through the text, not only its start. */
function spread<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)]);
  return out;
}

/**
 * The test for this screen: 12 per group (fewer when the text has fewer), then more, one group at a time, up to 20
 * while everything still fits. `room` is what the title, the "Done" button and the margins leave.
 */
export function pickForScreen(all: TestGroups, screen: Screen, chrome = 112): TestGroups {
  const ids: GroupId[] = ['b2', 'c1', 'c2'];
  const width = Math.max(240, Math.min(screen.width, 520) - 28);
  const room = screen.height - chrome;
  const count: Record<GroupId, number> = { b2: Math.min(MIN_PER_GROUP, all.b2.length), c1: Math.min(MIN_PER_GROUP, all.c1.length), c2: Math.min(MIN_PER_GROUP, all.c2.length) };
  const shown = (): TestGroups => ({ b2: spread(all.b2, count.b2), c1: spread(all.c1, count.c1), c2: spread(all.c2, count.c2) });
  const height = (g: TestGroups) => ids.reduce((h, id) => h + (g[id].length ? HEAD_H + chipsHeight(g[id], width) : 0), 0);
  for (let grew = true; grew;) {
    grew = false;
    for (const id of ids) {
      if (count[id] >= Math.min(MAX_PER_GROUP, all[id].length)) continue;
      count[id]++;
      if (height(shown()) <= room) grew = true; else count[id]--;
    }
  }
  return shown();
}

/** The percentage known per group (null = the group had no items). */
export function scoreTest(shown: TestGroups, knownKeys: ReadonlySet<string>): GroupScores {
  const pct = (list: readonly TestItem[]) => (list.length ? Math.round((100 * list.filter((i) => knownKeys.has(i.key)).length) / list.length) : null);
  return { b2: pct(shown.b2), c1: pct(shown.c1), c2: pct(shown.c2) };
}
