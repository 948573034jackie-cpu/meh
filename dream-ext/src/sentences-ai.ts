/**
 * The AI finds the complete sentences. YouTube's subtitles (above all the automatic ones) have no punctuation and
 * are cut in the middle of sentences; the rule-based split is only a first guess. Here the cheap model reads the
 * numbered words and answers one line per complete, punctuated sentence ("<last word number>|<sentence>"). The
 * words keep their times, so every sentence still knows exactly where it is in the video. Chunks end at long pauses
 * (where a sentence most likely ends) and run a few at a time; the result is cached per video.
 */
import type { PromptBundle } from '@core/ai/prompts';
import type { TimedSentence, TimedWord } from './video-book';

export const SPLIT_VERSION = 7;
const CHUNK_WORDS = 380;

export function flatten(sentences: TimedSentence[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const s of sentences) {
    if (s.words?.length) out.push(...s.words);
    else {
      // no word times: spread the sentence over its time
      const ws = s.text.split(/\s+/).filter(Boolean);
      const step = (s.end - s.start) / Math.max(1, ws.length);
      ws.forEach((w, i) => out.push({ w, t: s.start + i * step, e: s.start + (i + 1) * step }));
    }
  }
  return out;
}

/** Chunk boundaries [from, to): about CHUNK_WORDS words each, ending at the longest pause near the end (best after a
 * word that ends a written sentence, when the subtitles have punctuation). */
export function chunkBounds(words: TimedWord[], size = CHUNK_WORDS): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  while (from < words.length) {
    let to = Math.min(words.length, from + size);
    if (to < words.length) {
      let best = to, bestGap = -1;
      for (let i = Math.max(from + Math.floor(size * 0.6), from + 1); i < Math.min(words.length, from + Math.floor(size * 1.25)); i++) {
        const gap = words[i].t - words[i - 1].e + (ENDS_SENTENCE.test(words[i - 1].w) ? 2 : 0);
        if (gap > bestGap) { bestGap = gap; best = i; }
      }
      to = best;
    }
    out.push([from, to]);
    from = to;
  }
  return out;
}

export function buildSplitPrompt(words: TimedWord[], from: number, to: number): PromptBundle {
  const list = words.slice(from, to).map((w, i) => `${from + i}:${w.w}`).join(' ');
  return {
    system: 'You turn the speech subtitles of a YouTube video into complete, well-punctuated sentences for an English learner. Answer only in the requested line format.',
    user: `These are the words of a YouTube video's subtitles, in order, each with its number (number:word). Speech-recognition subtitles often have no punctuation and are cut in the middle of sentences.

Rebuild the complete sentences. A sentence is one complete thought, punctuated the way a careful writer would punctuate this speech; split run-on speech (thoughts joined with "and", "so", "but" without a real end) into natural sentences, but never cut a real sentence: a long sentence stays whole (up to 60 words), and a sentence never ends at a comma. Keep every word in the same order and do not add or remove words: only add punctuation and capital letters, and fix an obvious speech-recognition spelling mistake of a single word. Leave sound tags like [Music] out of the sentence text.

Answer with one line per sentence and nothing else (no notes, no thinking aloud), in this form:
<number of the last word of the sentence>|<the sentence, punctuated>
Your last line must end at word ${to - 1}. These words may stop in the middle of a sentence (the video goes on): then write that unfinished last sentence with ~ in front of it, like this: ${to - 1}|~And then we

Words:
${list}`,
    // (room for the model's own thinking too: with too little, the answer comes back empty)
    maxTokens: Math.min(16000, Math.round((to - from) * 4) + 1500),
  };
}

export interface SplitLine {
  end: number;
  text: string;
  /** the words stop in the middle of this sentence (the next chunk finishes it) */
  open?: boolean;
}

/** Every "<number>|<sentence>" line in order (numbers are not trusted: alignLines finds the ends from the words). */
export function parseLines(raw: string): SplitLine[] {
  const out: SplitLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*\|\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const open = /^~/.test(m[2]);
    const text = m[2].replace(/^~\s*/, '');
    if (text) out.push({ end: Number(m[1]), text, ...(open ? { open } : {}) });
  }
  return out;
}

/** Lines "<end>|<text>" -> sentence ends inside [from, to); bad or out-of-order lines are dropped, the end is closed. */
export function parseSplit(raw: string, from: number, to: number): SplitLine[] {
  return parseSplitOrNull(raw, from, to) ?? [{ end: to - 1, text: '' }];
}

/** Like parseSplit, but null when the answer is not usable (no valid line, or most of the words left over). */
export function parseSplitOrNull(raw: string, from: number, to: number): SplitLine[] | null {
  const out: SplitLine[] = [];
  let last = from - 1;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*\|\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const end = Number(m[1]);
    if (!(end > last) || end >= to) continue;
    out.push({ end, text: m[2] });
    last = end;
  }
  if (!out.length) return null;
  // the answer stopped early (cut off) and most of the chunk is not covered: not usable
  if (last - from + 1 < (to - from) * 0.6) return null;
  if (last < to - 1) {
    if (to - 1 - last <= 3) out[out.length - 1] = { ...out[out.length - 1], end: to - 1 }; // a few words left: they belong to the last sentence
    else out.push({ end: to - 1, text: '' });
  }
  return out;
}

/** A sentence this long is not a sentence: the AI's split of that chunk is not used. */
const MAX_WORDS = 70, MAX_SECONDS = 40;

const SOUND_TAG = /^\[[^\]]*\]$|^\([^)]*\)$/;
const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);
const norm = (w: string) => w.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
const ENDS_SENTENCE = /[.!?…]["”'’)\]]*$/;

/** The longest common subsequence of two word lists: for each word of `a`, the index of the word of `b` it is (or -1). */
function lcsMatch(a: string[], b: string[]): Int32Array {
  const A = a.length, B = b.length, W = B + 1;
  const dp = new Uint16Array((A + 1) * W);
  for (let i = A - 1; i >= 0; i--) for (let j = B - 1; j >= 0; j--) dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const m = new Int32Array(A).fill(-1);
  let i = 0, j = 0;
  while (i < A && j < B) {
    if (a[i] === b[j]) { m[i] = j; i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
    else j++;
  }
  return m;
}

const spokenWords = (ws: string[]) => ws.filter((w) => !SOUND_TAG.test(w)).map(norm).filter(Boolean);

/** The AI's text is still these words (punctuation, capitals, a fixed spelling): at least 80% the same. */
export function sameWords(text: string, real: string[]): boolean {
  const a = spokenWords(wordsOf(text)), b = spokenWords(real);
  if (!a.length || !b.length) return false;
  let n = 0;
  for (const x of lcsMatch(a, b)) if (x >= 0) n++;
  return n / Math.max(a.length, b.length) >= 0.8;
}

/**
 * The AI's word numbers drift (models count badly) but its sentences are right: its text is matched word by word with
 * the real words, and every sentence ends where its own last word is, so a sentence is never cut in the middle
 * ("…a government major," | "which means…"). A line that is not these words (the AI thinking aloud, a sentence it
 * made up) is dropped: its words go to the next sentence.
 */
export function alignLines(words: TimedWord[], lines: SplitLine[], from: number, to: number): SplitLine[] {
  const spoken = (i: number) => !SOUND_TAG.test(words[i].w) && norm(words[i].w) !== '';
  const real: number[] = [];
  for (let i = from; i < to; i++) if (spoken(i)) real.push(i);
  const ai: string[] = [], lineOf: number[] = [];
  lines.forEach((l, li) => { for (const w of spokenWords(wordsOf(l.text))) { ai.push(w); lineOf.push(li); } });
  const m = lcsMatch(ai, real.map((i) => norm(words[i].w)));
  const last = new Array<number>(lines.length).fill(-1), found = new Array<number>(lines.length).fill(0), total = new Array<number>(lines.length).fill(0);
  ai.forEach((_, k) => { const li = lineOf[k]; total[li]++; if (m[k] >= 0) { found[li]++; last[li] = m[k]; } });
  const out: SplitLine[] = [];
  let prev = -1; // the last real word of the sentence before (index in real)
  lines.forEach((l, li) => {
    if (last[li] <= prev || found[li] < total[li] * 0.5) return;
    let end = real[last[li]];
    while (end + 1 < to && !spoken(end + 1)) end++; // sound tags right after a sentence belong to it
    out.push({ end, text: l.text, ...(l.open ? { open: true } : {}) });
    prev = last[li];
  });
  // the end is closed: a few words left belong to the last sentence, more are a sentence of their own
  const end = out.length ? out[out.length - 1].end : from - 1;
  if (end < to - 1) {
    if (out.length && to - 1 - end <= 3) out[out.length - 1] = { ...out[out.length - 1], end: to - 1 };
    else out.push({ end: to - 1, text: '', open: lines[lines.length - 1]?.open });
  }
  return out;
}

/** Plain words as a sentence: capital first letter, closing full stop. */
export function plainSentence(ws: string[]): string {
  const t = ws.filter((w) => !SOUND_TAG.test(w)).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
  if (!t) return ws.join(' ');
  const cap = (t[0].toUpperCase() + t.slice(1)).replace(/[\s,;:–—-]+$/, '');
  return /[.!?…"'”’)]$/.test(cap) ? cap : `${cap}.`;
}

/** Sentences from the AI's ends: each keeps its words (with times); the AI's punctuated text is used when it fits. */
export function regroup(words: TimedWord[], lines: SplitLine[], from = 0): TimedSentence[] {
  const out: TimedSentence[] = [];
  let start = from;
  for (const l of lines) {
    const ws = words.slice(start, l.end + 1);
    start = l.end + 1;
    if (!ws.length) continue;
    const spoken = ws.filter((w) => !SOUND_TAG.test(w.w));
    if (!spoken.length) { if (out.length) { out[out.length - 1].words!.push(...ws); out[out.length - 1].end = ws[ws.length - 1].e; } continue; }
    // the AI's text must still be these words (punctuation and capitals added); otherwise the words themselves
    const fits = !!l.text && sameWords(l.text, spoken.map((w) => w.w));
    out.push({ start: ws[0].t, end: ws[ws.length - 1].e, text: fits ? l.text : plainSentence(ws.map((w) => w.w)), words: ws });
  }
  return out;
}

/** Two pieces of one sentence (cut where two chunks meet) as one sentence. */
function joinSentences(a: TimedSentence, b: TimedSentence, punctuated: boolean): TimedSentence {
  const t1 = a.text.replace(/[\s.…]+$/, '');
  const first = b.text.split(/\s+/)[0] ?? '';
  const realFirst = b.words?.find((w) => !SOUND_TAG.test(w.w))?.w ?? '';
  // written subtitles: the real word says if it starts with a capital; speech subtitles: only "I" and names in capitals
  const lower = punctuated ? /^[a-z]/.test(realFirst) : !/^(I|I'm|I'll|I've|I'd)\b/.test(first) && !/^[A-Z]{2,}/.test(first);
  const t2 = lower ? b.text.charAt(0).toLowerCase() + b.text.slice(1) : b.text;
  return { start: a.start, end: b.end, text: `${t1} ${t2}`, words: [...(a.words ?? []), ...(b.words ?? [])] };
}

/** The whole video: chunks a few at a time; `onProgress(done, total)`. A failed chunk keeps the first guess there. */
/** Written subtitles (with full stops): the sentences are where the full stops are. */
export function punctuationLines(words: TimedWord[], from: number, to: number): SplitLine[] {
  const out: SplitLine[] = [];
  for (let i = from; i < to; i++) {
    if (!ENDS_SENTENCE.test(words[i].w) || SOUND_TAG.test(words[i].w)) continue;
    let e = i;
    while (e + 1 < to && SOUND_TAG.test(words[e + 1].w)) e++;
    out.push({ end: e, text: '' });
    i = e;
  }
  if (!out.length || out[out.length - 1].end < to - 1) out.push({ end: to - 1, text: '' });
  return out;
}

/** How the AI's split went, chunk by chunk (for the diagnostics). */
export const splitReport: string[] = [];

/** The whole video: chunks a few at a time; `onProgress(done, total)`. A failed chunk keeps the first guess there. */
export async function splitWithAi(sentences: TimedSentence[], complete: (p: PromptBundle) => Promise<string>, onProgress?: (done: number, total: number) => void, parallel = 3, size = CHUNK_WORDS): Promise<TimedSentence[]> {
  const words = flatten(sentences);
  if (!words.length) return sentences;
  const bounds = chunkBounds(words, size);
  const results: (SplitLine[] | null)[] = new Array(bounds.length).fill(null);
  splitReport.length = 0;
  const one = async (from: number, to: number): Promise<SplitLine[] | string> => {
    const raw = await complete(buildSplitPrompt(words, from, to));
    const parsed = parseLines(raw);
    if (!parsed.length) return `no lines (${raw.slice(0, 60)})`;
    const lines = alignLines(words, parsed, from, to);
    // the answer stopped early (cut off) and most of the chunk is not covered: not usable
    const covered = [...lines].reverse().find((l) => l.text)?.end ?? from - 1;
    if (covered - from + 1 < (to - from) * 0.6) return `covers ${covered - from + 1} of ${to - from} words`;
    // every sentence must be a real sentence (not most of the chunk in one piece)
    let prev = from - 1;
    for (const l of lines) { const n = l.end - prev, secs = words[l.end].e - words[prev + 1].t; if (n > MAX_WORDS || secs > MAX_SECONDS) return `a sentence of ${n} words / ${Math.round(secs)} s`; prev = l.end; }
    return lines;
  };
  let next = 0, done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= bounds.length) return;
      const [from, to] = bounds[i];
      // a bad answer gets one more try
      for (let attempt = 0; attempt < 2 && !results[i]; attempt++) {
        try { const r = await one(from, to); if (typeof r === 'string') splitReport.push(`chunk ${i + 1} (words ${from}-${to - 1}): ${r}`); else results[i] = r; }
        catch (e) { splitReport.push(`chunk ${i + 1}: error ${(e as Error).message}`); }
      }
      if (results[i]) splitReport.push(`chunk ${i + 1}: ok`);
      onProgress?.(++done, bounds.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, bounds.length) }, worker));
  if (results.every((r) => r === null)) throw new Error('The AI could not find the sentences.');
  // where two chunks meet, a sentence may be cut in two: its two pieces become one sentence again
  const punctuated = words.filter((w) => ENDS_SENTENCE.test(w.w)).length >= words.length * 0.02;
  const out: TimedSentence[] = [];
  const aiMade = new Set<TimedSentence>();
  let carry: TimedSentence | null = null;
  bounds.forEach(([from, to], i) => {
    const r = results[i];
    // a failed chunk: written subtitles are cut at their full stops; speech subtitles keep the first guess (rule-based)
    const part = r ? regroup(words, r, from)
      : punctuated ? regroup(words, punctuationLines(words, from, to), from)
      : sentences.filter((s) => s.start >= words[from].t - 0.01 && s.start < (to < words.length ? words[to].t : Infinity));
    if (r) for (const s of part) aiMade.add(s);
    if (carry) { if (r && part.length) { part[0] = joinSentences(carry, part[0], punctuated); aiMade.add(part[0]); } else out.push(carry); carry = null; }
    if (r && i < bounds.length - 1 && part.length) {
      const lastS = part[part.length - 1];
      const lastWord = [...(lastS.words ?? [])].reverse().find((w) => !SOUND_TAG.test(w.w))?.w ?? '';
      if (r[r.length - 1].open || (punctuated && !ENDS_SENTENCE.test(lastWord))) carry = part.pop()!;
    }
    out.push(...part);
  });
  if (carry) out.push(carry);
  return joinCut(out, aiMade, punctuated);
}

const ENDS_CLAUSE = /[,;:–—-]["”'’)]*$/;

/**
 * A sentence that ends at a comma (or with no full stop, from the AI or in written subtitles) followed by one that
 * starts with a small letter is one sentence cut in two: joined again (the learner never gets half a sentence).
 */
export function joinCut(list: TimedSentence[], aiMade?: Set<TimedSentence>, punctuated = false): TimedSentence[] {
  const out = [...list];
  for (let i = 0; i < out.length - 1;) {
    const a = out[i], b = out[i + 1];
    const ta = a.text.trim(), tb = b.text.trim();
    const open = ENDS_CLAUSE.test(ta) || ((punctuated || !!aiMade?.has(a)) && !ENDS_SENTENCE.test(ta));
    if (open && /^[a-z]/.test(tb) && wordsOf(ta).length + wordsOf(tb).length <= 90) {
      const joined = { start: a.start, end: b.end, text: `${ta} ${tb}`, words: [...(a.words ?? []), ...(b.words ?? [])] };
      if (aiMade?.has(a) || aiMade?.has(b)) aiMade?.add(joined);
      out.splice(i, 2, joined);
      continue;
    }
    i++;
  }
  return out;
}
