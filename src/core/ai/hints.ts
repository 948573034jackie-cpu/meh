import type { Book, CefrLevel } from '@core/model';
import { sentenceText } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import { annotateSentence } from '@core/vocab/analysis';
import type { PromptBundle } from './prompts';

/**
 * Word Wise in Chinese: for every word above the learner's level in a chapter, the AI picks the Chinese
 * meaning the word has *in that sentence* (and one other common meaning), so the reader can show it under
 * the word instead of the dictionary's first gloss. Pure helpers; the queue and cache live in src/main/hints.ts.
 *
 * Cost: a batch of 80 words is roughly 80 × ~15 tokens in (word + clipped sentence) and 80 × ~12 tokens out
 * (two short Chinese meanings in JSON) ≈ 2k tokens, about $0.0005 per chapter with Claude Haiku 5.5.
 */

/** [meaning as used in the chapter, another common meaning or ''] */
export type HintPair = [string, string];
/** lemma -> hint pair */
export type HintMap = Record<string, HintPair>;

export interface HardWord {
  /** vocabulary key (dictionary lemma) */
  lemma: string;
  /** the word as it first appears in the chapter */
  word: string;
  /** the sentence of that first appearance, clipped around the word */
  sentence: string;
}

/** Words per request: enough to amortise the system prompt, few enough that the JSON stays reliable. */
export const HINTS_BATCH_SIZE = 80;
/** Output budget per word: `"lemma": ["意思", "另一个意思"],` is about 20-30 tokens; 40 leaves room for longer lemmas. */
export const HINT_TOKENS_PER_WORD = 40;
/** Longest clipped sentence sent per word (characters). */
const SENTENCE_MAX_CHARS = 200;

/** Cuts a long sentence to a window around the word so each word costs a bounded number of tokens. */
export function clipSentence(sentence: string, word: string, max = SENTENCE_MAX_CHARS): string {
  const s = sentence.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const at = word ? s.indexOf(word) : -1;
  const centre = at >= 0 ? at + word.length / 2 : max / 2;
  let start = Math.max(0, Math.round(centre - max / 2));
  let end = Math.min(s.length, start + max);
  if (end - start < max) start = Math.max(0, end - max);
  // cut at word boundaries where possible
  if (start > 0) { const sp = s.indexOf(' ', start); if (sp >= 0 && sp < start + 30) start = sp + 1; }
  if (end < s.length) { const sp = s.lastIndexOf(' ', end); if (sp > end - 30) end = sp; }
  return `${start > 0 ? '…' : ''}${s.slice(start, end).trim()}${end < s.length ? '…' : ''}`;
}

/**
 * Unique hard words of one chapter (above the learner's level, not names, not known/learning/ignored),
 * each with the sentence of its first appearance, in reading order.
 */
export function collectHardWords(
  book: Pick<Book, 'chapters'>,
  chapterIndex: number,
  dict: Dictionary,
  level: CefrLevel,
  names: ReadonlySet<string>,
  knownLemmas: ReadonlySet<string>,
): HardWord[] {
  const chapter = book.chapters[chapterIndex];
  if (!chapter) return [];
  const acc: HardWordsAcc = { out: [], seen: new Set() };
  for (const para of chapter.paragraphs) hardWordsOfParagraph(para, dict, level, names, knownLemmas, acc);
  return acc.out;
}

/**
 * collectHardWords that gives the thread back after every paragraph (`yieldNow`, e.g. setImmediate): the Mac app's main
 * process also carries the voice's audio and the AI's text, and a long chapter takes 15-60 ms in one block otherwise.
 */
export async function collectHardWordsAsync(
  book: Pick<Book, 'chapters'>,
  chapterIndex: number,
  dict: Dictionary,
  level: CefrLevel,
  names: ReadonlySet<string>,
  knownLemmas: ReadonlySet<string>,
  yieldNow: () => Promise<void>,
): Promise<HardWord[]> {
  const chapter = book.chapters[chapterIndex];
  if (!chapter) return [];
  const acc: HardWordsAcc = { out: [], seen: new Set() };
  for (const para of chapter.paragraphs) {
    hardWordsOfParagraph(para, dict, level, names, knownLemmas, acc);
    await yieldNow();
  }
  return acc.out;
}

interface HardWordsAcc { out: HardWord[]; seen: Set<string> }

function hardWordsOfParagraph(para: Book['chapters'][number]['paragraphs'][number], dict: Dictionary, level: CefrLevel, names: ReadonlySet<string>, knownLemmas: ReadonlySet<string>, acc: HardWordsAcc): void {
  for (const s of para.sentences) {
    const { infos, hardTokens } = annotateSentence(para, s, dict, names as Set<string>, level);
    if (hardTokens.length === 0) continue;
    let text: string | null = null;
    for (const i of hardTokens) {
      const info = infos[i];
      if (!info || acc.seen.has(info.lemma) || knownLemmas.has(info.lemma)) continue;
      acc.seen.add(info.lemma);
      const word = s.tokens[i].text;
      text ??= sentenceText(para, s);
      acc.out.push({ lemma: info.lemma, word, sentence: clipSentence(text, word) });
    }
  }
}

/** Splits the words of a chapter into requests of at most `size` words. */
export function batchHardWords(words: HardWord[], size = HINTS_BATCH_SIZE): HardWord[][] {
  const out: HardWord[][] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size));
  return out;
}

/**
 * System + user text for one batch. The reply must be a JSON object only; `parseHints` reads it back.
 * The sentence travels with each word so the first meaning is the one used in the book, not the headword's
 * most common sense ("spring" in "the spring of the trap" -> 弹簧, not 春天).
 */
export function buildHintsPrompt(batch: HardWord[], opts: { title: string; chapter: string; level: CefrLevel }): PromptBundle {
  const system = [
    `You write Word Wise hints for a native Chinese speaker reading an English book at CEFR level ${opts.level}.`,
    `For each English word you are given its dictionary form (the key), the form in the text and the sentence it appears in.`,
    `Give two short Chinese meanings per word: first the meaning the word has IN THAT SENTENCE, then one other common meaning of the word (or an empty string if it has no other common meaning).`,
    `Each meaning is 2 to 6 Chinese characters, like a dictionary gloss (房子, 不情愿的, 突然出现). No pinyin, no English, no part-of-speech labels, no explanations.`,
    `Reply with ONE JSON object and nothing else: no code fences, no comments, no text before or after. The keys are exactly the dictionary forms given; every word must be present.`,
    `Format: {"<dictionary form>": ["<meaning here>", "<other meaning or empty>"], ...}`,
  ].join('\n');
  const where = `${opts.title}${opts.chapter ? ` — ${opts.chapter}` : ''}`;
  const lines = batch.map((w, i) => `${i + 1}. ${JSON.stringify(w.lemma)}${w.word.toLowerCase() !== w.lemma ? ` (in the text: ${w.word})` : ''} — ${w.sentence}`);
  const user = [
    `Book: ${where}`,
    `Words (${batch.length}):`,
    ...lines,
    '',
    `Return the JSON object with these ${batch.length} keys: ${batch.map((w) => JSON.stringify(w.lemma)).join(', ')}.`,
  ].join('\n');
  return { system, user, maxTokens: HINT_TOKENS_PER_WORD * batch.length + 100 };
}

const MEANING_MAX_CHARS = 20;

function cleanMeaning(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, MEANING_MAX_CHARS);
}

function toPair(v: unknown): HintPair | null {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v as object) : null;
  if (!arr) return null;
  const first = cleanMeaning(arr[0]);
  if (!first) return null;
  return [first, cleanMeaning(arr[1])];
}

function fromObject(obj: unknown): HintMap {
  const out: HintMap = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = k.trim().toLowerCase();
    const pair = toPair(v);
    if (key && pair) out[key] = pair;
  }
  return out;
}

/**
 * Reads the model's reply back into a hint map. Tolerates code fences, prose around the object and a
 * truncated tail: when the object does not parse, each complete `"key": ["a", "b"]` entry is salvaged.
 */
export function parseHints(text: string): HintMap {
  if (!text) return {};
  let s = text.replace(/```[a-z]*\s*/gi, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  else if (start >= 0) s = s.slice(start);
  try {
    return fromObject(JSON.parse(s));
  } catch { /* fall through to the per-entry salvage */ }
  const out: HintMap = {};
  const re = /"((?:[^"\\]|\\.)*)"\s*:\s*\[\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"((?:[^"\\]|\\.)*)"\s*)?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    try {
      const key = (JSON.parse(`"${m[1]}"`) as string).trim().toLowerCase();
      const pair = toPair([JSON.parse(`"${m[2]}"`), m[3] !== undefined ? JSON.parse(`"${m[3]}"`) : '']);
      if (key && pair) out[key] = pair;
    } catch { /* skip a broken entry */ }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Phrases: multi-word expressions of the chapter, each with a CEFR level decided by the model before
 * anything is shown (docs/RULES.md "Phrases").
 *
 * Cost: a chunk of at most PHRASE_CHUNK_CHARS (~4.5k tokens of text + ~350 of instructions) and at most
 * 40 phrases out (~35 tokens each, ≈ 1.4k tokens) ≈ $0.0012 with Claude Haiku 5.5. Most chapters are one chunk.
 * ---------------------------------------------------------------------------------------------- */

/** A multi-word expression the model found in a chapter (validated: it literally appears there). */
export interface PhraseItem {
  /** exact text as it appears in the book ("took it for granted") */
  text: string;
  /** base form, lower case ("take for granted") */
  lemma: string;
  /** the model's CEFR level of the expression itself */
  level: CefrLevel;
  /** short Chinese meaning as used in the chapter ('' when the model gave none) */
  zh: string;
}

/**
 * One occurrence of a chapter phrase in a sentence. `start`/`end` are token indices of `sentence.tokens`,
 * both INCLUSIVE (unlike PhraseSpan in analysis.ts): the phrase covers tokens[start]..tokens[end].
 */
export interface PhraseHit {
  /** sentenceKey(): "chapter.paragraph.sentence" */
  sentenceKey: string;
  start: number;
  end: number;
  /** the covered text of this sentence (para.text from tokens[start].start to tokens[end].end) */
  text: string;
  lemma: string;
  level: CefrLevel;
  zh: string;
}

/** sentenceKey -> phrase hits of that sentence, ordered by start; sentences without hits are absent. */
export type PhraseMap = Record<string, PhraseHit[]>;

/** Characters of chapter text per phrase request (~4.5k tokens; the request stays under ~6k with the instructions). */
export const PHRASE_CHUNK_CHARS = 18_000;
/** Phrases asked for per chapter (split across chunks in proportion to their length). */
export const PHRASES_PER_CHAPTER = 40;
/** Output budget per phrase: `{"text":"…","lemma":"…","level":"B2","zh":"…"},` ≈ 30-40 tokens. */
export const PHRASE_TOKENS_PER_ITEM = 45;
/** Longest text accepted: a 5-word expression plus one inserted object ("kept him at arm's length"). */
export const MAX_PHRASE_TEXT_WORDS = 6;

const WORD_RE = /[\p{L}\p{N}]+(?:['’\-‐‑][\p{L}\p{N}]+)*/gu;

/** Folds case, curly quotes, dashes and whitespace so the model's copy compares equal to the book's text. */
export function normalizePhraseText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ`´′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words of a phrase, normalised, punctuation dropped ("Took it for granted," -> ["took","it","for","granted"]). */
export function phraseWords(s: string): string[] {
  return normalizePhraseText(s).match(WORD_RE) ?? [];
}

/** The plain text of a chapter, one paragraph per line. */
export function chapterText(book: Pick<Book, 'chapters'>, chapterIndex: number): string {
  const ch = book.chapters[chapterIndex];
  return ch ? ch.paragraphs.map((p) => p.text).join('\n') : '';
}

/**
 * Splits a chapter into request-sized chunks at sentence boundaries (paragraphs keep their line breaks).
 * A single sentence longer than `max` becomes its own chunk.
 */
export function chunkChapter(book: Pick<Book, 'chapters'>, chapterIndex: number, max = PHRASE_CHUNK_CHARS): string[] {
  const ch = book.chapters[chapterIndex];
  if (!ch) return [];
  const out: string[] = [];
  let cur = '';
  for (const para of ch.paragraphs) {
    let first = true;
    for (const s of para.sentences) {
      const t = sentenceText(para, s).trim();
      if (!t) continue;
      const sep = cur ? (first ? '\n' : ' ') : '';
      if (cur && cur.length + sep.length + t.length > max) { out.push(cur); cur = t; }
      else cur += sep + t;
      first = false;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** How many phrases to ask for in each chunk: PHRASES_PER_CHAPTER shared by length, at least 10 each. */
export function phraseQuota(chunks: string[]): number[] {
  const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
  return chunks.map((c) => Math.max(10, Math.ceil((PHRASES_PER_CHAPTER * c.length) / total)));
}

/** System + user text asking for the multi-word expressions of one chunk; `parsePhrases` reads the reply. */
export function buildPhrasesPrompt(
  chunk: string,
  opts: { title: string; chapter: string; level: CefrLevel; max?: number; part?: [number, number] },
): PromptBundle {
  const max = opts.max ?? PHRASES_PER_CHAPTER;
  const system = [
    `You find multi-word expressions in an English book for a native Chinese speaker reading at CEFR level ${opts.level}.`,
    `List the expressions of 2 to 5 words — idioms, phrasal verbs, fixed expressions, collocations whose meaning is not obvious, slang — that a learner at level ${opts.level} would not understand from the single words.`,
    `Rules:`,
    `- Only expressions that literally appear in the text. "text" is copied exactly as it appears in the text (same words, same forms, same order), nothing added or left out.`,
    `- "lemma" is the dictionary form in lower case (take for granted, look forward to, give up).`,
    `- "level" is the CEFR level of the expression itself: A2, B1, B2, C1 or C2.`,
    `- "zh" is its Chinese meaning as used here, 2 to 6 characters, like a dictionary gloss. No pinyin, no English.`,
    `- No single words, no names, no free combinations whose meaning is just the sum of the words (old man, big house, went home, a cup of tea).`,
    `- At most ${max} expressions, each once, the hardest and most useful first.`,
    `Reply with ONE JSON object and nothing else: no code fences, no comments, no text before or after.`,
    `Format: {"phrases":[{"text":"<as in the text>","lemma":"<base form>","level":"<A2|B1|B2|C1|C2>","zh":"<中文>"}]}`,
    `If there are none: {"phrases":[]}`,
  ].join('\n');
  const where = `${opts.title}${opts.chapter ? ` — ${opts.chapter}` : ''}`;
  const part = opts.part && opts.part[1] > 1 ? ` (part ${opts.part[0]} of ${opts.part[1]})` : '';
  const user = [
    `Phrases. Book: ${where}${part}`,
    `Text:`,
    '<<<',
    chunk,
    '>>>',
    '',
    `Return the JSON object with at most ${max} expressions.`,
  ].join('\n');
  return { system, user, maxTokens: PHRASE_TOKENS_PER_ITEM * max + 100 };
}

/** A phrase as the model wrote it, before validation. */
export interface RawPhrase { text: string; lemma: string; level: string; zh: string }

function str(v: unknown): string { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; }

function toRawPhrase(v: unknown): RawPhrase | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const text = str(o.text ?? o.phrase ?? o.expression);
  if (!text) return null;
  return { text, lemma: str(o.lemma ?? o.base), level: str(o.level ?? o.cefr), zh: str(o.zh ?? o.chinese ?? o.meaning) };
}

/**
 * Reads the model's reply back into raw phrases. Accepts {"phrases":[…]}, a bare array, code fences and prose
 * around the JSON; when the whole does not parse (a truncated tail), each complete `{…}` item is salvaged.
 */
export function parsePhrases(text: string): RawPhrase[] {
  if (!text) return [];
  const s = text.replace(/```[a-z]*\s*/gi, '').trim();
  const objAt = s.indexOf('{');
  const arrAt = s.indexOf('[');
  const candidates: string[] = [];
  if (objAt >= 0) { const e = s.lastIndexOf('}'); if (e > objAt) candidates.push(s.slice(objAt, e + 1)); }
  if (arrAt >= 0) { const e = s.lastIndexOf(']'); if (e > arrAt) candidates.push(s.slice(arrAt, e + 1)); }
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      const list = Array.isArray(v) ? v : v && typeof v === 'object' ? (v as Record<string, unknown>).phrases : null;
      if (Array.isArray(list)) return list.map(toRawPhrase).filter((x): x is RawPhrase => x !== null);
    } catch { /* try the next shape, then salvage */ }
  }
  const out: RawPhrase[] = [];
  for (const m of s.matchAll(/\{[^{}]*\}/g)) {
    try {
      const p = toRawPhrase(JSON.parse(m[0]));
      if (p) out.push(p);
    } catch { /* skip a broken item */ }
  }
  return out;
}

const CEFR_RE = /^(A1|A2|B1|B2|C1|C2)$/;
const PLACEHOLDERS = new Set(['sb', 'sth', 'somebody', 'someone', 'something', "one's", "someone's", "somebody's", 'oneself', 'do', 'doing']);

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Keeps the phrases worth showing: a valid CEFR level, 2 to MAX_PHRASE_TEXT_WORDS words, the text literally in the
 * chapter (case, quotes, dashes and spaces folded; whole words only), not a free combination (when `isFree` is
 * given, e.g. looksLikeFreeCombination over the dictionary), each text once, at most `max`.
 */
export function validatePhrases(
  items: RawPhrase[],
  chapter: string,
  opts: { max?: number; isFree?: (words: string[], zh: string) => boolean } = {},
): PhraseItem[] {
  const hay = normalizePhraseText(chapter);
  const out: PhraseItem[] = [];
  const seen = new Set<string>();
  const max = opts.max ?? Infinity;
  for (const it of items) {
    if (out.length >= max) break;
    const level = it.level.toUpperCase().trim();
    if (!CEFR_RE.test(level)) continue;
    const words = phraseWords(it.text);
    if (words.length < 2 || words.length > MAX_PHRASE_TEXT_WORDS) continue;
    const norm = normalizePhraseText(it.text).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!norm || seen.has(norm)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(norm)}(?![\\p{L}\\p{N}])`, 'u');
    if (!re.test(hay)) continue;
    const zh = cleanMeaning(it.zh);
    if (opts.isFree?.(words, zh)) continue;
    seen.add(norm);
    const lemma = normalizePhraseText(it.lemma) || words.join(' ');
    out.push({ text: it.text, lemma, level: level as CefrLevel, zh });
  }
  return out;
}

/** True for words that may stand between the first word and the rest of a phrasal verb ("took it for granted"). */
const GAP_WORDS = new Set(['it', 'him', 'her', 'them', 'me', 'us', 'you', 'this', 'that', 'one', 'something', 'someone', 'everything', 'nothing']);

interface Pattern { words: string[]; item: PhraseItem; /** lemma pattern: allow one object pronoun after the first word */ gap: boolean }

/**
 * Finds every occurrence of the chapter's phrases in its sentences. A match starts and ends on word tokens and
 * runs over consecutive word tokens (only space tokens between them). Each phrase is matched by its text and by
 * its lemma; the first and last word may be inflected (compared through `lemmaOf`, e.g. the dictionary's), and
 * a lemma match may carry one object pronoun after its first word ("took it for granted" for "take for
 * granted"). Longer matches win; matches never overlap.
 */
export function mapPhraseHits(
  book: Pick<Book, 'chapters'>,
  chapterIndex: number,
  items: PhraseItem[],
  lemmaOf?: (word: string) => string,
): PhraseMap {
  const ch = book.chapters[chapterIndex];
  const out: PhraseMap = {};
  if (!ch || items.length === 0) return out;
  const lemmaCache = new Map<string, string>();
  const lem = (w: string): string => {
    if (!lemmaOf) return w;
    let l = lemmaCache.get(w);
    if (l === undefined) { l = normalizePhraseText(lemmaOf(w)); lemmaCache.set(w, l); }
    return l;
  };
  const patterns: Pattern[] = [];
  const seenPat = new Set<string>();
  for (const item of items) {
    const tw = phraseWords(item.text);
    const lw = phraseWords(item.lemma);
    for (const [words, gap] of [[tw, false], [lw, true]] as const) {
      if (words.length < 2 || words.length > MAX_PHRASE_TEXT_WORDS || words.some((w) => PLACEHOLDERS.has(w))) continue;
      const k = `${words.join(' ')}|${gap}`;
      if (seenPat.has(k)) continue;
      seenPat.add(k);
      patterns.push({ words: [...words], item, gap });
    }
  }
  const same = (tok: string, pw: string, edge: boolean): boolean => tok === pw || (edge && lemmaOf !== undefined && lem(tok) === lem(pw));

  for (const para of ch.paragraphs) {
    for (const s of para.sentences) {
      const toks = s.tokens;
      const wi: number[] = [];
      for (let i = 0; i < toks.length; i++) if (toks[i].kind === 'word') wi.push(i);
      if (wi.length < 2) continue;
      const norm = wi.map((i) => phraseWords(toks[i].text).join('-'));
      // joined[k]: word k and word k+1 are separated by spaces only
      const joined = wi.map((i, k) => {
        if (k + 1 >= wi.length) return false;
        for (let j = i + 1; j < wi[k + 1]; j++) if (toks[j].kind !== 'space') return false;
        return true;
      });
      const found: { k0: number; k1: number; item: PhraseItem; n: number }[] = [];
      for (const p of patterns) {
        const n = p.words.length;
        for (let k = 0; k + n <= wi.length; k++) {
          if (!same(norm[k], p.words[0], true)) continue;
          for (const g of p.gap && n >= 2 ? [0, 1] : [0]) {
            const kEnd = k + n - 1 + g;
            if (kEnd >= wi.length) continue;
            if (g === 1 && !GAP_WORDS.has(norm[k + 1])) continue;
            let ok = true;
            for (let q = k; q < kEnd; q++) if (!joined[q]) { ok = false; break; }
            for (let j = 1; ok && j < n; j++) {
              if (!same(norm[k + j + g], p.words[j], j === n - 1)) ok = false;
            }
            if (ok) { found.push({ k0: k, k1: kEnd, item: p.item, n: kEnd - k + 1 }); break; }
          }
        }
      }
      if (found.length === 0) continue;
      found.sort((a, b) => b.n - a.n || a.k0 - b.k0);
      const taken = new Array<boolean>(wi.length).fill(false);
      const hits: PhraseHit[] = [];
      const key = `${chapterIndex}.${para.index}.${s.index}`;
      for (const f of found) {
        let free = true;
        for (let k = f.k0; k <= f.k1; k++) if (taken[k]) { free = false; break; }
        if (!free) continue;
        for (let k = f.k0; k <= f.k1; k++) taken[k] = true;
        const start = wi[f.k0], end = wi[f.k1];
        hits.push({ sentenceKey: key, start, end, text: para.text.slice(toks[start].start, toks[end].end), lemma: f.item.lemma, level: f.item.level, zh: f.item.zh });
      }
      hits.sort((a, b) => a.start - b.start);
      out[key] = hits;
    }
  }
  return out;
}
