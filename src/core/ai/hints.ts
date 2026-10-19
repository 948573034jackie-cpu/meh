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
  const out: HardWord[] = [];
  const seen = new Set<string>();
  for (const para of chapter.paragraphs) {
    for (const s of para.sentences) {
      const { infos, hardTokens } = annotateSentence(para, s, dict, names as Set<string>, level);
      if (hardTokens.length === 0) continue;
      let text: string | null = null;
      for (const i of hardTokens) {
        const info = infos[i];
        if (!info || seen.has(info.lemma) || knownLemmas.has(info.lemma)) continue;
        seen.add(info.lemma);
        const word = s.tokens[i].text;
        text ??= sentenceText(para, s);
        out.push({ lemma: info.lemma, word, sentence: clipSentence(text, word) });
      }
    }
  }
  return out;
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
