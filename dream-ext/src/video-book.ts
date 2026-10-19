/**
 * A YouTube video as a Dream Read book: its subtitles (complete sentences with the time of every word, from
 * lib.js buildSentences(cues, { words: true })) become one chapter of paragraphs, sentences and tokens, so the
 * dictionary, the hard-word rules, the listening teacher and the prompts of Dream Read work on it unchanged.
 * Each sentence also keeps its time range and the start/end time of each of its tokens.
 */
import type { Book, Paragraph, Position, Sentence, Token } from '@core/model';
import { sentenceKey } from '@core/model';
import { createSegmenter } from '@core/segment';
import { computeStats } from '@core/import/text';

export interface TimedWord { w: string; t: number; e: number }
export interface TimedSentence { start: number; end: number; text: string; words?: TimedWord[] | null }

export interface SentenceTiming {
  start: number;
  end: number;
  /** per token of the sentence: when it is spoken (null for spaces and punctuation) */
  tokenStart: (number | null)[];
  tokenEnd: (number | null)[];
  /** per token: char offset inside the sentence text (what TtsEngine.onWord reports) */
  tokenChar: number[];
}

export interface VideoBook {
  book: Book;
  /** sentence key "c.p.s" -> timing */
  timing: Map<string, SentenceTiming>;
  /** every sentence in reading (time) order */
  order: Position[];
  timingOf(pos: Position): SentenceTiming | null;
  /** the sentence being spoken at `time` (the last one that started at or before it; the first one before the start) */
  positionAt(time: number): Position | null;
}

export interface BuildOptions {
  /** a pause this long between two sentences starts a new paragraph */
  paragraphGapSec?: number;
  /** a paragraph is closed after this long */
  paragraphMaxSec?: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}']+/gu, '');

/**
 * Gives every word token of `tokens` the time of the subtitle word it came from. Subtitle words and tokens are
 * in the same order with the same letters (the sentence text was made from those words), but a token may be part
 * of a word ("well-known" is three tokens) or span two ("can not" -> "cannot" is rare); anything that does not
 * line up gets a time between its neighbours.
 */
export function alignTokenTimes(tokens: Token[], words: TimedWord[], start: number, end: number): { s: (number | null)[]; e: (number | null)[] } {
  const s: (number | null)[] = tokens.map(() => null);
  const e: (number | null)[] = tokens.map(() => null);
  const ws = words.map((w) => ({ n: norm(w.w), t: w.t, e: w.e })).filter((w) => w.n);
  let j = 0;
  let rest = ws[0]?.n ?? '';
  const advance = () => { j++; rest = ws[j]?.n ?? ''; };
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.kind !== 'word' && tk.kind !== 'number') continue;
    let n = norm(tk.text);
    if (!n || j >= ws.length) continue;
    if (rest.startsWith(n)) {
      s[i] = ws[j].t; e[i] = ws[j].e;
      rest = rest.slice(n.length);
      if (!rest) advance();
      continue;
    }
    if (n.startsWith(rest)) { // one token over several subtitle words
      s[i] = ws[j].t;
      while (j < ws.length && n.startsWith(rest)) { n = n.slice(rest.length); e[i] = ws[j].e; advance(); if (!n) break; }
      continue;
    }
    // out of step: look a few words ahead for this token
    let found = -1;
    for (let k = j + 1; k < Math.min(ws.length, j + 4); k++) if (ws[k].n.startsWith(n)) { found = k; break; }
    if (found >= 0) {
      j = found; rest = ws[j].n;
      s[i] = ws[j].t; e[i] = ws[j].e;
      rest = rest.slice(n.length);
      if (!rest) advance();
    }
  }
  // fill the gaps: between the neighbours that have a time, else spread over the sentence
  const idx = tokens.map((t, i) => (t.kind === 'word' || t.kind === 'number' ? i : -1)).filter((i) => i >= 0);
  for (let a = 0; a < idx.length; a++) {
    const i = idx[a];
    if (s[i] !== null) continue;
    let b = a + 1;
    while (b < idx.length && s[idx[b]] === null) b++;
    const prevEnd = a > 0 && e[idx[a - 1]] !== null ? (e[idx[a - 1]] as number) : start;
    const nextStart = b < idx.length ? (s[idx[b]] as number) : end;
    const count = b - a;
    const step = Math.max(0, nextStart - prevEnd) / count;
    for (let k = 0; k < count; k++) { const ti = idx[a + k]; s[ti] = prevEnd + k * step; e[ti] = prevEnd + (k + 1) * step; }
    a = b - 1;
  }
  return { s, e };
}

export function buildVideoBook(video: { id: string; title: string; channel?: string }, sentences: TimedSentence[], opts: BuildOptions = {}): VideoBook {
  const gap = opts.paragraphGapSec ?? 2.5;
  const maxLen = opts.paragraphMaxSec ?? 45;
  const seg = createSegmenter();
  const clean = sentences
    .filter((x) => x && typeof x.text === 'string' && x.text.trim() && Number.isFinite(x.start))
    .map((x) => ({ ...x, text: x.text.replace(/\s+/g, ' ').trim(), end: Number.isFinite(x.end) && x.end > x.start ? x.end : x.start + 1 }))
    .sort((a, b) => a.start - b.start);
  // group into paragraphs
  const groups: (typeof clean)[] = [];
  let cur: typeof clean = [];
  for (const x of clean) {
    const last = cur[cur.length - 1];
    if (last && (x.start - last.end >= gap || x.end - cur[0].start > maxLen)) { groups.push(cur); cur = []; }
    cur.push(x);
  }
  if (cur.length) groups.push(cur);
  const timing = new Map<string, SentenceTiming>();
  const order: Position[] = [];
  const paragraphs: Paragraph[] = groups.map((g, pi) => {
    let text = '';
    const sents: Sentence[] = [];
    g.forEach((x, si) => {
      if (text) text += ' ';
      const off = text.length;
      text += x.text;
      const toks = seg.tokenize(x.text).map((t) => ({ ...t, start: t.start + off, end: t.end + off }));
      sents.push({ index: si, start: off, end: off + x.text.length, tokens: toks });
      const local = toks.map((t) => ({ ...t, start: t.start - off, end: t.end - off }));
      const times = x.words && x.words.length ? alignTokenTimes(local, x.words, x.start, x.end) : spread(local, x.start, x.end);
      const pos = { chapter: 0, paragraph: pi, sentence: si };
      timing.set(sentenceKey(pos), { start: x.start, end: x.end, tokenStart: times.s, tokenEnd: times.e, tokenChar: local.map((t) => t.start) });
      order.push(pos);
    });
    return { index: pi, kind: 'p', text, sentences: sents };
  });
  const chapters = [{ index: 0, title: video.title || 'YouTube video', paragraphs }];
  const book: Book = {
    id: `yt:${video.id}`,
    title: video.title || 'YouTube video',
    author: video.channel,
    language: 'en',
    source: { kind: 'text', path: `https://www.youtube.com/watch?v=${video.id}`, importedAt: new Date().toISOString() },
    chapters,
    names: [],
    stats: computeStats(chapters),
  };
  const starts = order.map((p) => timing.get(sentenceKey(p))!.start);
  return {
    book, timing, order,
    timingOf: (pos) => timing.get(sentenceKey(pos)) ?? null,
    positionAt(time) {
      if (!order.length) return null;
      let lo = 0, hi = order.length - 1, best = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= time + 0.05) { best = mid; lo = mid + 1; } else hi = mid - 1; }
      return order[best];
    },
  };
}

/** No word times (a subtitle file without them): words spread evenly over the sentence. */
function spread(tokens: Token[], start: number, end: number): { s: (number | null)[]; e: (number | null)[] } {
  const words = tokens.map((t, i) => (t.kind === 'word' || t.kind === 'number' ? i : -1)).filter((i) => i >= 0);
  const s: (number | null)[] = tokens.map(() => null);
  const e: (number | null)[] = tokens.map(() => null);
  const step = (end - start) / Math.max(1, words.length);
  words.forEach((ti, k) => { s[ti] = start + k * step; e[ti] = start + (k + 1) * step; });
  return { s, e };
}
