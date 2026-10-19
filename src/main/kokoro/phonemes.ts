import { splitPieces, isBreak, type Piece } from './text';

/**
 * Grapheme-to-phoneme for Kokoro v1.0 using espeak-ng (the `phonemizer` npm package, espeak-ng compiled to
 * WebAssembly). Kokoro was trained on misaki (a Python G2P) with espeak-ng as its fallback, so espeak IPA
 * plus the small replacements below is what every JS/ONNX port feeds it.
 *
 * The important part for karaoke is `alignTokens`: every model token is attributed to the word it belongs
 * to, so the model's per-token durations become per-word times. espeak merges some function words
 * ("was the" -> "wʌzðə") and expands others ("1999" -> three groups), so the attribution falls back to a
 * length-proportional split whenever the phoneme groups of a chunk do not line up 1:1 with its words.
 */

/** Kokoro v1.0 vocabulary (from kokoro-onnx config.json, identical to onnx-community/Kokoro-82M-v1.0-ONNX). */
const VOCAB_LIST: [number, string][] = [[1, ';'], [2, ':'], [3, ','], [4, '.'], [5, '!'], [6, '?'], [9, '—'], [10, '…'], [11, '"'], [12, '('], [13, ')'], [14, '“'], [15, '”'], [16, ' '], [17, '̃'], [18, 'ʣ'], [19, 'ʥ'], [20, 'ʦ'], [21, 'ʨ'], [22, 'ᵝ'], [23, 'ꭧ'], [24, 'A'], [25, 'I'], [31, 'O'], [33, 'Q'], [35, 'S'], [36, 'T'], [39, 'W'], [41, 'Y'], [42, 'ᵊ'], [43, 'a'], [44, 'b'], [45, 'c'], [46, 'd'], [47, 'e'], [48, 'f'], [50, 'h'], [51, 'i'], [52, 'j'], [53, 'k'], [54, 'l'], [55, 'm'], [56, 'n'], [57, 'o'], [58, 'p'], [59, 'q'], [60, 'r'], [61, 's'], [62, 't'], [63, 'u'], [64, 'v'], [65, 'w'], [66, 'x'], [67, 'y'], [68, 'z'], [69, 'ɑ'], [70, 'ɐ'], [71, 'ɒ'], [72, 'æ'], [75, 'β'], [76, 'ɔ'], [77, 'ɕ'], [78, 'ç'], [80, 'ɖ'], [81, 'ð'], [82, 'ʤ'], [83, 'ə'], [85, 'ɚ'], [86, 'ɛ'], [87, 'ɜ'], [90, 'ɟ'], [92, 'ɡ'], [99, 'ɥ'], [101, 'ɨ'], [102, 'ɪ'], [103, 'ʝ'], [110, 'ɯ'], [111, 'ɰ'], [112, 'ŋ'], [113, 'ɳ'], [114, 'ɲ'], [115, 'ɴ'], [116, 'ø'], [118, 'ɸ'], [119, 'θ'], [120, 'œ'], [123, 'ɹ'], [125, 'ɾ'], [126, 'ɻ'], [128, 'ʁ'], [129, 'ɽ'], [130, 'ʂ'], [131, 'ʃ'], [132, 'ʈ'], [133, 'ʧ'], [135, 'ʊ'], [136, 'ʋ'], [138, 'ʌ'], [139, 'ɣ'], [140, 'ɤ'], [142, 'χ'], [143, 'ʎ'], [147, 'ʒ'], [148, 'ʔ'], [156, 'ˈ'], [157, 'ˌ'], [158, 'ː'], [162, 'ʰ'], [164, 'ʲ'], [169, '↓'], [171, '→'], [172, '↗'], [173, '↘'], [177, 'ᵻ']];
export const VOCAB: ReadonlyMap<string, number> = new Map(VOCAB_LIST.map(([i, c]) => [c, i]));
export const PAD_TOKEN = 0;
export const SPACE_TOKEN = 16;
/** the model accepts at most 510 phoneme tokens between the two pad tokens */
export const MAX_TOKENS = 510;

export type Phonemizer = (text: string, lang: string) => Promise<string[]>;

let phonemizerPromise: Promise<Phonemizer> | null = null;
/** Loads espeak-ng (WASM) once; the first call costs ~300 ms, later calls a few ms. */
export function defaultPhonemizer(): Promise<Phonemizer> {
  if (!phonemizerPromise) phonemizerPromise = import('phonemizer').then((m) => (text: string, lang: string) => m.phonemize(text, lang));
  return phonemizerPromise;
}

/** espeak-ng voice for a Kokoro voice id: 'b*' voices are British (espeak "en" = en-gb), everything else American. */
export function espeakLang(voiceId: string): string { return voiceId.startsWith('b') ? 'en' : 'en-us'; }

/** Post-processing applied by kokoro-js to espeak output (symbols Kokoro never saw in training). */
export function fixPhonemes(ph: string, lang: string): string {
  let s = ph
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (lang === 'en-us') s = s.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return s;
}

export function tokenize(phonemes: string): number[] {
  const out: number[] = [];
  for (const ch of phonemes) { const id = VOCAB.get(ch); if (id !== undefined) out.push(id); }
  return out;
}

/** One model input: tokens (without pads) and which word each token belongs to (-1 for punctuation/space). */
export interface Chunk {
  tokens: number[];
  /** per token: index into `words`, or -1 */
  owner: number[];
  /** the words of this chunk in order, with their offsets in the original text */
  words: { charIndex: number; charLength: number }[];
  phonemes: string;
}

/**
 * Turns text into model chunks. Words between punctuation marks are phonemized together (espeak uses the
 * context for stress and reductions); punctuation is inserted as its own token. Long texts are cut at
 * sentence ends (or, failing that, clause ends) so every chunk stays under MAX_TOKENS.
 */
export async function textToChunks(text: string, lang: string, phonemize: Phonemizer): Promise<Chunk[]> {
  const pieces = splitPieces(text);
  const groups = groupPieces(pieces);
  const units: { tokens: number[]; owner: number[]; words: Chunk['words']; phonemes: string; sentenceEnd: boolean }[] = [];
  for (const g of groups) {
    const unit = await phonemizeGroup(g, lang, phonemize);
    if (unit) units.push(unit);
  }
  // pack units into chunks
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let curEndsSentence = false;
  for (const u of units) {
    const fits = cur && cur.tokens.length + 1 + u.tokens.length <= MAX_TOKENS;
    if (cur && fits && !curEndsSentence) { append(cur, u); }
    else if (cur && fits && curEndsSentence && cur.tokens.length + u.tokens.length < MAX_TOKENS / 2) { append(cur, u); }
    else { cur = { tokens: [], owner: [], words: [], phonemes: '' }; chunks.push(cur); append(cur, u); }
    curEndsSentence = u.sentenceEnd;
    if (cur.tokens.length > MAX_TOKENS) { cur.tokens.length = MAX_TOKENS; cur.owner.length = MAX_TOKENS; }
  }
  return chunks;
}

function append(c: Chunk, u: { tokens: number[]; owner: number[]; words: Chunk['words']; phonemes: string }): void {
  const base = c.words.length;
  if (c.tokens.length) { c.tokens.push(SPACE_TOKEN); c.owner.push(-1); c.phonemes += ' '; }
  for (let i = 0; i < u.tokens.length; i++) { c.tokens.push(u.tokens[i]); c.owner.push(u.owner[i] < 0 ? -1 : u.owner[i] + base); }
  c.words.push(...u.words);
  c.phonemes += u.phonemes;
}

/** A group is a run of words followed by (at most) one punctuation piece. */
function groupPieces(pieces: Piece[]): { words: Piece[]; punct: Piece | null }[] {
  const groups: { words: Piece[]; punct: Piece | null }[] = [];
  let cur: { words: Piece[]; punct: Piece | null } = { words: [], punct: null };
  for (const p of pieces) {
    if (p.kind === 'word') { if (cur.punct) { groups.push(cur); cur = { words: [], punct: null }; } cur.words.push(p); }
    else { if (cur.punct) { groups.push(cur); cur = { words: [], punct: null }; } cur.punct = p; }
  }
  if (cur.words.length || cur.punct) groups.push(cur);
  return groups;
}

async function phonemizeGroup(g: { words: Piece[]; punct: Piece | null }, lang: string, phonemize: Phonemizer) {
  const tokens: number[] = []; const owner: number[] = []; const words: Chunk['words'] = [];
  let phonemes = '';
  if (g.words.length) {
    const ph = fixPhonemes((await phonemize(g.words.map((w) => w.spoken).join(' '), lang)).join(' '), lang).trim();
    const phGroups = ph.split(/\s+/).filter(Boolean);
    let perWord: string[][];
    if (phGroups.length === g.words.length) perWord = phGroups.map((p) => [p]);
    else {
      // counts differ (espeak merged or expanded words): split the phoneme string over the words in
      // proportion to each word's own phoneme length
      const singles = await Promise.all(g.words.map(async (w) => fixPhonemes((await phonemize(w.spoken, lang)).join(' '), lang).replace(/\s+/g, '')));
      perWord = proportionalSplit(ph.replace(/\s+/g, ''), singles.map((s) => Math.max(1, s.length))).map((p) => [p]);
    }
    perWord.forEach((parts, wi) => {
      const w = g.words[wi];
      const widx = words.push({ charIndex: w.charIndex, charLength: w.charLength }) - 1;
      const ids = tokenize(parts.join(''));
      if (tokens.length) { tokens.push(SPACE_TOKEN); owner.push(-1); phonemes += ' '; }
      for (const id of ids) { tokens.push(id); owner.push(widx); }
      phonemes += parts.join('');
    });
  }
  if (g.punct) {
    const ids = tokenize(g.punct.spoken);
    for (const id of ids) { tokens.push(id); owner.push(-1); }
    phonemes += g.punct.spoken;
  }
  if (!tokens.length) return null;
  return { tokens, owner, words, phonemes, sentenceEnd: !!g.punct && isBreak(g.punct) };
}

/** Splits `s` into pieces whose lengths follow `weights` proportionally (every piece at least 1 char when possible). */
export function proportionalSplit(s: string, weights: number[]): string[] {
  const chars = [...s];
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out: string[] = [];
  let pos = 0;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    let end = i === weights.length - 1 ? chars.length : Math.round((acc / total) * chars.length);
    if (end <= pos && pos < chars.length) end = pos + 1;
    out.push(chars.slice(pos, Math.max(pos, end)).join(''));
    pos = Math.max(pos, end);
  }
  return out;
}
