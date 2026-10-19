/**
 * Voice-command detection for the listening loop (see docs/research/research-voice.md,
 * "Voice-command detection"). Runs on every STT partial/final and must never wait for the LLM.
 *
 * Pipeline: normalize → word-count gate (> 6 words is conversation) → per-intent phrase grammar with
 * Mandarin-L1 accent variants, tested DONT_KNOW → KNOW → BYE (substring collision) → fuzzy accept on the
 * whole utterance (Levenshtein ratio ≥ minRatio OR phonetic-key equality) → prefix rule ("I don't know this
 * word") → otherwise QUESTION for the AI.
 *
 * Pure TypeScript: Levenshtein and a Metaphone-style phonetic key are implemented here, no dependencies.
 */

export type CommandIntent = 'know' | 'dont_know' | 'bye';
export type Intent = CommandIntent | 'question' | 'none';

export interface DetectOptions {
  /** STT confidence for the utterance (0..1). Below 0.6 the fuzzy threshold is raised to ≥ 0.85. */
  confidence?: number;
  /** Levenshtein ratio needed on the whole utterance (default 0.80). */
  minRatio?: number;
}

export interface Detection {
  intent: Intent;
  /** Best Levenshtein ratio seen against the matched phrase (1 = exact); 0 for 'none'. */
  score: number;
  /** The grammar phrase that matched, when intent is a command. */
  matched?: string;
}

/** Utterances longer than this many words are conversation for the AI, never a command. */
export const MAX_COMMAND_WORDS = 6;
/** Prefix rule: a command phrase at the start of the utterance may be followed by at most this many words. */
export const MAX_TAIL_WORDS = 3;
/** Report rule: utterance.length ≤ phrase.length + this many characters for a whole-utterance match. */
const MAX_EXTRA_CHARS = 6;
const DEFAULT_MIN_RATIO = 0.8;
const LOW_CONFIDENCE = 0.6;
const LOW_CONFIDENCE_MIN_RATIO = 0.85;

/** Phrase grammar per intent, including Mandarin-L1 accent variants (final-consonant drop, th→d/s, v→w). */
export const PHRASES: Record<CommandIntent, readonly string[]> = {
  dont_know: [
    "i don't know", 'i dont know', 'i don no', 'i do not know', 'i dono', 'i dunno', 'dunno', "don't know", 'dont know', 'don no',
    'no idea', 'not sure', "i'm not sure", 'i am not sure', 'i not sure',
    'what', 'again', 'explain again', 'say again', 'say it again', 'one more time', "i don't understand", 'i dont understand', 'i don understand',
  ],
  know: ['i know', 'i knew', 'i no', 'i now', 'i know it', 'yes i know', 'yeah i know', 'ya i know', 'got it', 'i got it', 'i understand', 'understood'],
  bye: ['bye bye', 'bye', 'goodbye', 'good bye', 'bai bai', 'by by', 'bai', 'see you', 'see ya', "that's all", 'thats all', 'that is all', 'the end'],
};

/** Order matters: DONT_KNOW first because "i know" is a substring of "i don't know". */
const ORDER: readonly CommandIntent[] = ['dont_know', 'know', 'bye'];

/** Standalone filler tokens dropped during normalisation. */
const FILLERS = new Set(['um', 'uh', 'uhm', 'umm', 'hmm', 'hm', 'mm', 'mhm', 'er', 'erm', 'ah', 'eh', 'oh', 'okay', 'ok', 'well']);

/** Apostrophe-less spellings STT engines often emit → canonical contraction. */
const CONTRACTIONS: Record<string, string> = {
  dont: "don't", im: "i'm", thats: "that's", whats: "what's", cant: "can't", didnt: "didn't", isnt: "isn't", wont: "won't", youre: "you're", ive: "i've",
};

/**
 * Lowercase, straighten quotes, strip punctuation (apostrophes kept), collapse whitespace, canonicalise
 * contractions ("dont" → "don't"), drop filler tokens ("um", "okay"). Returns '' for nothing usable.
 */
export function normalize(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .split(' ')
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 0)
    .map((w) => CONTRACTIONS[w] ?? w)
    .filter((w) => !FILLERS.has(w));
  return words.join(' ');
}

/** Classic Levenshtein edit distance (two-row DP). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Similarity ratio in 0..1: 1 - distance / max(len). Two empty strings are identical (1). */
export function ratio(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  return n === 0 ? 1 : 1 - levenshtein(a, b) / n;
}

const VOWELS = 'aeiou';
const isVowel = (c: string): boolean => c.length === 1 && VOWELS.includes(c);

/**
 * Metaphone-1 style key for one word, with one accent fold: "th" → T (Mandarin-L1 speakers say d/t), and
 * "ye" at word end treated as a vowel so "bye" / "bai" / "by" / "buy" all key to "B". Vowels survive only
 * at the start of a word (as "A").
 */
export function phoneticWord(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  if (/^(kn|gn|pn|wr|ae)/.test(w)) w = w.slice(1);
  else if (w.startsWith('x')) w = 's' + w.slice(1);
  else if (w.startsWith('wh')) w = 'w' + w.slice(1);
  const out: string[] = [];
  const last = w.length - 1;
  for (let i = 0; i < w.length; i++) {
    const c = w[i], prev = i > 0 ? w[i - 1] : '', next = i < last ? w[i + 1] : '', next2 = i + 1 < last ? w[i + 2] : '';
    if (c === prev && c !== 'c') continue;
    switch (c) {
      case 'a': case 'e': case 'i': case 'o': case 'u':
        if (i === 0) out.push('A');
        break;
      case 'b':
        if (!(prev === 'm' && i === last)) out.push('B');
        break;
      case 'c':
        if (next === 'i' && next2 === 'a') out.push('X');
        else if (next === 'h') { out.push('X'); i++; }
        else if (next === 'i' || next === 'e' || next === 'y') { if (prev !== 's') out.push('S'); }
        else out.push('K');
        break;
      case 'd':
        if (next === 'g' && (next2 === 'e' || next2 === 'i' || next2 === 'y')) { out.push('J'); i += 2; }
        else out.push('T');
        break;
      case 'g':
        if (next === 'h') {
          if (i === 0) { out.push('K'); i++; }
          else i++; // silent gh ("night", "though")
        } else if (next === 'n' && (i + 1 === last || (next2 === 'e' && i + 2 === last))) {
          // silent g in "sign", "signed"
        } else if (next === 'e' || next === 'i' || next === 'y') out.push('J');
        else out.push('K');
        break;
      case 'h':
        if (isVowel(next) && !'csptg'.includes(prev)) out.push('H');
        break;
      case 'k':
        if (prev !== 'c') out.push('K');
        break;
      case 'p':
        if (next === 'h') { out.push('F'); i++; } else out.push('P');
        break;
      case 'q':
        out.push('K');
        break;
      case 's':
        if (next === 'h') { out.push('X'); i++; }
        else if (next === 'i' && (next2 === 'o' || next2 === 'a')) out.push('X');
        else out.push('S');
        break;
      case 't':
        if (next === 'h') { out.push('T'); i++; } // accent fold: th → T
        else if (next === 'i' && (next2 === 'o' || next2 === 'a')) out.push('X');
        else if (!(next === 'c' && next2 === 'h')) out.push('T');
        break;
      case 'v':
        out.push('F');
        break;
      case 'w':
        if (isVowel(next)) out.push('W');
        break;
      case 'x':
        out.push('K', 'S');
        break;
      case 'y':
        if (isVowel(next) && !(next === 'e' && i + 1 === last)) out.push('Y');
        break;
      case 'z':
        out.push('S');
        break;
      default:
        out.push(c.toUpperCase()); // f j l m n r
    }
  }
  return out.join('');
}

/** Phonetic key of a normalised utterance: per-word keys joined by spaces (word count must match to be equal). */
export function phoneticKey(text: string): string {
  return text.split(' ').map(phoneticWord).filter((k) => k.length > 0).join(' ');
}

interface Candidate { intent: CommandIntent; score: number; matched: string }

/**
 * Classify an utterance as a voice command, a question for the AI, or nothing.
 *
 * - '' after normalisation → 'none'
 * - more than MAX_COMMAND_WORDS words → 'question'
 * - whole-utterance match: utterance ≤ phrase + 6 chars AND (ratio ≥ minRatio OR phonetic keys equal)
 * - prefix match: the first N words match a phrase of N words the same way, and the tail is ≤ 3 words and
 *   no longer than the phrase itself ("i don't know this word" → dont_know; "i know that word already" → question)
 * - confidence < 0.6 → the ratio threshold is raised to 0.85 (phonetic equality still accepted)
 * - otherwise 'question'
 */
export function detectCommand(text: string, opts: DetectOptions = {}): Detection {
  const norm = normalize(text);
  if (!norm) return { intent: 'none', score: 0 };
  const words = norm.split(' ');
  if (words.length > MAX_COMMAND_WORDS) return { intent: 'question', score: 0 };

  let minRatio = opts.minRatio ?? DEFAULT_MIN_RATIO;
  if (opts.confidence !== undefined && opts.confidence < LOW_CONFIDENCE) minRatio = Math.max(minRatio, LOW_CONFIDENCE_MIN_RATIO);

  const wholeKey = phoneticKey(norm);
  const headKeys = new Map<number, string>();
  const headText = new Map<number, string>();
  const headOf = (n: number): [string, string] => {
    let t = headText.get(n), k = headKeys.get(n);
    if (t === undefined || k === undefined) { t = words.slice(0, n).join(' '); k = phoneticKey(t); headText.set(n, t); headKeys.set(n, k); }
    return [t, k];
  };

  let bestOverall = 0;
  for (const intent of ORDER) {
    let best: Candidate | null = null;
    for (const phrase of PHRASES[intent]) {
      // Whole-utterance match.
      const r = ratio(norm, phrase);
      bestOverall = Math.max(bestOverall, r);
      if (norm.length <= phrase.length + MAX_EXTRA_CHARS) {
        const phon = wholeKey === phoneticKey(phrase);
        if (r >= minRatio || phon) {
          const score = phon ? Math.max(r, minRatio) : r;
          if (!best || score > best.score) best = { intent, score, matched: phrase };
          continue;
        }
      }
      // Prefix rule: command phrase at the start, short tail.
      const n = phrase.split(' ').length;
      const tail = words.length - n;
      if (tail <= 0 || tail > MAX_TAIL_WORDS || tail > n) continue;
      const [head, headKey] = headOf(n);
      const hr = ratio(head, phrase);
      const hphon = headKey === phoneticKey(phrase);
      if (hr >= minRatio || hphon) {
        const score = hphon ? Math.max(hr, minRatio) : hr;
        if (!best || score > best.score) best = { intent, score, matched: phrase };
      }
    }
    if (best) return best;
  }
  return { intent: 'question', score: bestOverall };
}

export function isCommandIntent(intent: Intent): intent is CommandIntent {
  return intent === 'know' || intent === 'dont_know' || intent === 'bye';
}
