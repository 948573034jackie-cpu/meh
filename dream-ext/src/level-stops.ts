/**
 * Which sentences the tutor stops at: each sentence gets a score from what is unknown in it (words by their CEFR level
 * and how rare they are, phrases, idioms and slang) and how hard its grammar is. Words the learner knows count for
 * nothing. At most half of the sentences stop, the hardest ones, and only when something in them is still unknown.
 */
import type { Book, CefrLevel, Position } from '@core/model';
import { sentenceKey } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { PhraseHit } from '@shared/api';
import type { WordStatus } from '@shared/settings';
import { annotateSentence } from '@core/vocab/analysis';
import { phraseSig, type Chance } from './level-db';

export const MAX_STOP_RATIO = 0.5;
/** below this nothing in the sentence is really likely to be unknown */
export const MIN_SCORE = 0.45;

export interface SentenceScore {
  key: string;
  index: number;
  score: number;
  /** what is hard in it, in reading order: the explanation starts with these */
  items: string[];
  /** the sentence's unknown words and phrases, as vocabulary keys */
  lemmas: string[];
  /** what each item is: a single word, or a phrase (idiom, slang, phrasal verb) */
  kinds: ItemKind[];
  /** the AI found the whole sentence hard (grammar, hidden meaning) */
  hard: boolean;
  /** what a stop here is for: a hard word, else a phrase, else the sentence itself */
  kind: StopKind;
}

export type ItemKind = 'word' | 'phrase';
export type StopKind = 'word' | 'phrase' | 'sentence';
/** The three groups of stops, each with its own switch and share: words, phrases, whole sentences. */
export type StopGroup = StopKind;
export const groupOf = (kind: StopKind): StopGroup => kind;
/** The share of the sentences that may stop, for each group (0..1; 0 = never or switched off). */
export interface StopCaps { word: number; phrase: number; sentence: number }
export const DEFAULT_CAPS: StopCaps = { word: 0.35, phrase: 0.15, sentence: 0.05 };
/**
 * What a stop here is for, with the groups that are on: a hard word, else a phrase; a sentence only when the sentence
 * itself is hard (or has nothing else). null = nothing here for the groups that are on.
 */
export function kindWith(s: Pick<SentenceScore, 'kinds' | 'hard'>, caps: StopCaps): StopKind | null {
  const ks = s.kinds.filter((k) => caps[k] > 0);
  if (ks.length) return stopKindOf(ks);
  return caps.sentence > 0 && (s.hard || !s.kinds.length) ? 'sentence' : null;
}
/** What a stop is for, from what is (still) hard in the sentence. */
export const stopKindOf = (kinds: readonly ItemKind[]): StopKind => (kinds.includes('word') ? 'word' : kinds.includes('phrase') ? 'phrase' : 'sentence');

export interface ScoreOpts {
  book: Pick<Book, 'chapters'>;
  order: readonly Position[];
  dict: Dictionary;
  names: Set<string>;
  status: (lemma: string) => WordStatus | undefined;
  /** the signature of a phrase the learner knows, or has set aside */
  phraseDone: (sig: string) => boolean;
  /** the AI's idioms, slang and phrases per sentence */
  phrases: Record<string, readonly PhraseHit[]>;
  /** sentences the AI found hard (grammar, hidden meaning) */
  hard: ReadonlySet<string>;
  chance: Chance;
  zipf: (word: string) => number | null;
}

/** this common or more, a word is easy whatever level the dictionary gives it (Zipf: "found" 5.3, "themes" 4.1) */
export const COMMON_ZIPF = 4.8;
/** A word the level says is hard but really is not: a contraction ("don't"), or a very common form ("found", "known"). */
export function looksEasy(text: string, zipf: (w: string) => number | null): boolean {
  const w = text.toLowerCase();
  return /['\u2019]/.test(w) || (zipf(w) ?? 0) >= COMMON_ZIPF;
}

const LEVEL_WEIGHT: Partial<Record<CefrLevel, number>> = { B1: 0.4, B2: 1, C1: 1.6, C2: 2.2 };
const chanceOf = (c: Chance, l: CefrLevel): number => (l === 'A1' || l === 'A2' ? c.A : c[l as 'B1' | 'B2' | 'C1' | 'C2']);
/** a rare word is harder than its level says: Zipf 4 and more adds nothing, Zipf 2 adds 1 */
const rarity = (z: number | null): number => (z === null ? 0.3 : Math.max(0, Math.min(1, (4 - z) / 2)));

export function scoreSentences(o: ScoreOpts): SentenceScore[] {
  return o.order.map((pos, index) => {
    const para = o.book.chapters[pos.chapter].paragraphs[pos.paragraph];
    const s = para.sentences[pos.sentence];
    const key = sentenceKey(pos);
    const hits = o.phrases[key] ?? [];
    // (above A2: B1 words count a little; A-level words only when the learner marked them)
    const ann = annotateSentence(para, s, o.dict, o.names, 'A2', hits);
    let score = 0;
    const found: { at: number; text: string; lemma: string; kind: ItemKind }[] = [];
    const usedTokens = new Set<number>();
    const phrase = (start: number, endExcl: number, lemma: string, level: CefrLevel, ai: boolean) => {
      const text = s.tokens.slice(start, endExcl).map((t) => t.text).join(' ');
      for (let i = start; i < endExcl; i++) usedTokens.add(i);
      const st = o.status(lemma);
      if (st === 'known' || st === 'ignored' || o.phraseDone(phraseSig(o.dict, lemma)) || o.phraseDone(phraseSig(o.dict, text))) return;
      // idioms and slang are the hard part of listening, whatever their level
      score += st === 'learning' ? 2.5 : ai ? 2 : (LEVEL_WEIGHT[level] ?? 0) * chanceOf(o.chance, level) * 1.5;
      if (st === 'learning' || ai || chanceOf(o.chance, level) >= 0.3) found.push({ at: start, text, lemma, kind: 'phrase' });
    };
    for (const p of ann.phrases) if (p.above) phrase(p.start, p.end, p.result.lemma, p.level, p.confirmed);
    for (const h of ann.aiPhrases) phrase(h.start, h.end + 1, h.lemma, h.level, true);
    ann.infos.forEach((info, i) => {
      if (!info || info.isName || usedTokens.has(i)) return;
      const st = o.status(info.lemma);
      if (st === 'known' || st === 'ignored') return;
      const c = info.level ? chanceOf(o.chance, info.level) : 0;
      const weight = info.level ? (LEVEL_WEIGHT[info.level] ?? 0) * c * (1 + rarity(o.zipf(info.lemma))) : 0;
      // (a word the learner is still learning is surely unknown)
      if (st === 'learning') { score += Math.max(2.5, weight + 1); found.push({ at: i, text: s.tokens[i].text, lemma: info.lemma, kind: 'word' }); return; }
      if (!info.level || !ann.hardTokens.includes(i) || looksEasy(s.tokens[i].text, o.zipf)) return;
      score += weight;
      if (c >= 0.3 && (LEVEL_WEIGHT[info.level] ?? 0) >= 1) found.push({ at: i, text: s.tokens[i].text, lemma: info.lemma, kind: 'word' });
    });
    if (o.hard.has(key)) score += 1.5;
    const words = s.tokens.filter((t) => t.kind === 'word').length;
    if (score > 0 && words > 22) score += Math.min(0.6, (words - 22) * 0.04);
    found.sort((a, b) => a.at - b.at);
    // (a hard word twice in one sentence is one thing to ask and to count)
    const first = new Set<string>();
    for (let i = 0; i < found.length; i++) { if (first.has(found[i].lemma)) found.splice(i--, 1); else first.add(found[i].lemma); }
    const kinds = found.map((f) => f.kind);
    return { key, index, score, items: found.map((f) => f.text), lemmas: found.map((f) => f.lemma), kinds, hard: o.hard.has(key), kind: stopKindOf(kinds) };
  });
}

/** The hardest sentences, at most half of them, none without something unknown. */
export function selectStops(scores: readonly SentenceScore[], ratio = MAX_STOP_RATIO): Set<string> {
  const max = Math.floor(scores.length * ratio);
  const list = scores.filter((s) => s.score >= MIN_SCORE).sort((a, b) => b.score - a.score || a.index - b.index);
  return new Set(list.slice(0, max).map((s) => s.key));
}

/**
 * The stops by group: of all the sentences, at most `caps.word` stop for a hard word, `caps.phrase` for a phrase and
 * `caps.sentence` for the sentence itself; in each group the hardest ones (a low share = only the hardest).
 */
export function selectStopsByKind(scores: readonly SentenceScore[], caps: StopCaps = DEFAULT_CAPS): Set<string> {
  const out = new Set<string>();
  for (const group of ['word', 'phrase', 'sentence'] as const) {
    const max = Math.floor(scores.length * Math.max(0, Math.min(1, caps[group])));
    const list = scores.filter((s) => kindWith(s, caps) === group && s.score >= MIN_SCORE).sort((a, b) => b.score - a.score || a.index - b.index);
    for (const s of list.slice(0, max)) out.add(s.key);
  }
  return out;
}

/** One more stop keeps the stops so far at half of the sentences so far, or fewer. */
export function mayStop(stops: number, sentencesSoFar: number, ratio = MAX_STOP_RATIO): boolean {
  return stops + 1 <= sentencesSoFar * ratio;
}

/** The same for one group of stops; the very first stop of a group never has to wait. */
export function mayStopGroup(stops: number, sentencesSoFar: number, ratio: number): boolean {
  return ratio > 0 && stops + 1 <= Math.max(1, sentencesSoFar * ratio);
}

/** "12/30 (40%)" */
export function counterText(stops: number, sentencesSoFar: number): string {
  return `${stops}/${sentencesSoFar} (${sentencesSoFar ? Math.round((100 * stops) / sentencesSoFar) : 0}%)`;
}

/** The AI's phrases of a text -> where they are: per sentence, the tokens they cover (for the score). */
export function itemsToHits(book: Pick<Book, 'chapters'>, order: readonly Position[], items: readonly { text: string; level: 'B2' | 'C1' | 'C2' }[], dict: Pick<Dictionary, 'lemmaOf'>): Record<string, PhraseHit[]> {
  const out: Record<string, PhraseHit[]> = {};
  const word = (t: string) => t.toLowerCase().replace(/[\u2019]/g, "'");
  for (const it of items) {
    const want = it.text.split(/[^\p{L}\p{N}'\u2019-]+/u).filter(Boolean).map(word);
    if (!want.length) continue;
    for (const pos of order) {
      const s = book.chapters[pos.chapter].paragraphs[pos.paragraph].sentences[pos.sentence];
      const tokens = s.tokens.map((t, i) => ({ t, i })).filter((x) => x.t.kind === 'word' || x.t.kind === 'number');
      for (let i = 0; i + want.length <= tokens.length; i++) {
        if (!want.every((w, j) => word(tokens[i + j].t.text) === w)) continue;
        (out[sentenceKey(pos)] ??= []).push({ sentenceKey: sentenceKey(pos), start: tokens[i].i, end: tokens[i + want.length - 1].i, text: it.text, lemma: want.length > 1 ? want.join(' ') : dict.lemmaOf(want[0]), level: it.level, zh: '' });
      }
    }
  }
  return out;
}
