/**
 * The AI finds the complete sentences. YouTube's subtitles (above all the automatic ones) have no punctuation and
 * are cut in the middle of sentences; the rule-based split is only a first guess. Here the cheap model reads the
 * numbered words and answers one line per complete, punctuated sentence ("<last word number>|<sentence>"). The
 * words keep their times, so every sentence still knows exactly where it is in the video. Chunks end at long pauses
 * (where a sentence most likely ends) and run a few at a time; the result is cached per video.
 */
import type { PromptBundle } from '@core/ai/prompts';
import type { TimedSentence, TimedWord } from './video-book';

export const SPLIT_VERSION = 3;
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

/** Chunk boundaries [from, to): about CHUNK_WORDS words each, ending at the longest pause near the end. */
export function chunkBounds(words: TimedWord[], size = CHUNK_WORDS): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  while (from < words.length) {
    let to = Math.min(words.length, from + size);
    if (to < words.length) {
      let best = to, bestGap = -1;
      for (let i = Math.max(from + Math.floor(size * 0.6), from + 1); i < Math.min(words.length, from + Math.floor(size * 1.25)); i++) {
        const gap = words[i].t - words[i - 1].e;
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

Rebuild the complete sentences. A sentence is one complete thought, punctuated the way a careful writer would punctuate this speech; split long run-on speech into natural sentences (most sentences have 5 to 30 words). Keep every word in the same order and do not add or remove words: only add punctuation and capital letters, and fix an obvious speech-recognition spelling mistake of a single word. Leave sound tags like [Music] out of the sentence text.

Answer with one line per sentence and nothing else, in this form:
<number of the last word of the sentence>|<the sentence, punctuated>
Your last line must end at word ${to - 1}.

Words:
${list}`,
    maxTokens: Math.min(8000, Math.round((to - from) * 2.2) + 200),
  };
}

export interface SplitLine { end: number; text: string }

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

/**
 * The AI's word numbers drift (models count badly) but its sentences are right: every line's end is found again from
 * its own words (its last words, near where its word count says it ends), so a sentence is never cut in the middle
 * ("…a government major," | "which means…"). When its words cannot be found, the word count decides.
 */
export function alignLines(words: TimedWord[], lines: SplitLine[], from: number, to: number): SplitLine[] {
  const out: SplitLine[] = [];
  let start = from;
  const spoken = (i: number) => !SOUND_TAG.test(words[i].w) && norm(words[i].w) !== '';
  for (let li = 0; li < lines.length && start < to; li++) {
    const l = lines[li];
    const lw = wordsOf(l.text).filter((w) => !SOUND_TAG.test(w)).map(norm).filter(Boolean);
    if (!lw.length) continue; // an empty line (the words the AI left out): closed below
    // where the word count says the line ends (sound tags are not in the AI's text)
    let e0 = start, n = 0;
    for (let i = start; i < to && n < lw.length; i++) { if (spoken(i)) n++; e0 = i; }
    // the line's last words, compared with the words that end at each place near there
    const tail = lw.slice(-3);
    let best = -1, bestScore = -1;
    for (let e = Math.max(start, e0 - 10); e <= Math.min(to - 1, e0 + 10); e++) {
      if (!spoken(e)) continue;
      let score = 0, j = e;
      for (let k = tail.length - 1; k >= 0; k--) {
        while (j >= start && !spoken(j)) j--;
        if (j < start) break;
        if (norm(words[j].w) === tail[k]) score++;
        j--;
      }
      const s = score - Math.abs(e - e0) * 0.01; // of equal matches, the nearest
      if (score >= Math.min(2, tail.length) && s > bestScore) { bestScore = s; best = e; }
    }
    const end = best >= 0 ? best : e0;
    // sound tags right after a sentence belong to it
    let e = end;
    while (e + 1 < to - 1 && SOUND_TAG.test(words[e + 1].w)) e++;
    out.push({ end: e, text: l.text });
    start = e + 1;
  }
  // the end is closed: a few words left belong to the last sentence, more are a sentence of their own
  const last = out.length ? out[out.length - 1].end : from - 1;
  if (last < to - 1) {
    if (out.length && to - 1 - last <= 3) out[out.length - 1] = { ...out[out.length - 1], end: to - 1 };
    else out.push({ end: to - 1, text: '' });
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
    const n = wordsOf(l.text).length;
    // the AI's text must still be these words (punctuation and capitals added); otherwise the words themselves
    const fits = n > 0 && Math.abs(n - spoken.length) <= Math.max(2, Math.round(spoken.length * 0.25));
    out.push({ start: ws[0].t, end: ws[ws.length - 1].e, text: fits ? l.text : plainSentence(ws.map((w) => w.w)), words: ws });
  }
  return out;
}

/** The whole video: chunks a few at a time; `onProgress(done, total)`. A failed chunk keeps the first guess there. */
export async function splitWithAi(sentences: TimedSentence[], complete: (p: PromptBundle) => Promise<string>, onProgress?: (done: number, total: number) => void, parallel = 3): Promise<TimedSentence[]> {
  const words = flatten(sentences);
  if (!words.length) return sentences;
  const bounds = chunkBounds(words);
  const results: (SplitLine[] | null)[] = new Array(bounds.length).fill(null);
  let next = 0, done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= bounds.length) return;
      const [from, to] = bounds[i];
      try {
        const parsed = parseSplitOrNull(await complete(buildSplitPrompt(words, from, to)), from, to);
        const lines = parsed && alignLines(words, parsed, from, to);
        // every sentence must be a real sentence (not most of the chunk in one piece)
        let prev = from - 1, ok = !!lines;
        for (const l of lines ?? []) { const n = l.end - prev, secs = words[l.end].e - words[prev + 1].t; if (n > MAX_WORDS || secs > MAX_SECONDS) ok = false; prev = l.end; }
        results[i] = ok ? lines : null;
      } catch { results[i] = null; }
      onProgress?.(++done, bounds.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, bounds.length) }, worker));
  if (results.every((r) => r === null)) throw new Error('The AI could not find the sentences.');
  const out: TimedSentence[] = [];
  bounds.forEach(([from, to], i) => {
    const r = results[i];
    if (r) { out.push(...regroup(words, r, from)); return; }
    // this chunk failed: the first guess (rule-based) for its time range
    for (const s of sentences) if (s.start >= words[from].t - 0.01 && s.start < (to < words.length ? words[to].t : Infinity)) out.push(s);
  });
  return out;
}
