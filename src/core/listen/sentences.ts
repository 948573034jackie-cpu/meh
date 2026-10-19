/**
 * Splits a streamed AI reply into sentences as the text arrives, so each sentence can be spoken as soon as it
 * is complete (voice chat: the tutor starts talking after the first sentence, not after the whole reply).
 * Pure: feed it the full text so far (`push`) and the final text (`flush`).
 */

/** Words ending in "." that do not end a sentence (lower-cased, without the dot). */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'prof', 'sr', 'jr', 'vs', 'e.g', 'i.e', 'eg', 'ie', 'cf', 'approx', 'no', 'vol', 'ch', 'p', 'pp', 'fig', 'mt', 'lt', 'col', 'gen', 'capt', 'rev', 'sgt']);
const END = '.!?…。！？';
const CLOSERS = '"\')]}”’»*_';

export interface SplitterOptions {
  /** a run without sentence punctuation longer than this is split at a comma, semicolon, colon or dash (default 220) */
  maxChars?: number;
  /** shortest piece emitted on its own; shorter ones wait to be joined with the next sentence (default 2) */
  minChars?: number;
}

/**
 * Index just after the sentence that starts at `from`, or -1 when the text so far does not yet show where it
 * ends. `final` = no more text will come (the end of the text ends the sentence).
 */
export function findSentenceEnd(text: string, from: number, final = false): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      if (text.slice(from, i).trim()) return i + 1;
      continue;
    }
    if (!END.includes(c)) continue;
    let j = i + 1;
    while (j < text.length && END.includes(text[j])) j++;
    while (j < text.length && CLOSERS.includes(text[j])) j++;
    if (j >= text.length) return final ? j : -1; // more punctuation or a closing quote may follow
    if ('。！？'.includes(c)) return j; // Chinese punctuation needs no space after it
    if (!/\s/.test(text[j])) continue; // "3.5", "U.S.", "word.word"
    if (c === '.' && j === i + 1 && !isSentenceDot(text, from, i)) continue;
    // the next word: a lower-case start means the sentence goes on ("e.g. this", "... and then")
    let k = j;
    while (k < text.length && /\s/.test(text[k])) { if (text[k] === '\n') return j; k++; }
    if (k >= text.length) return final ? j : -1;
    if (/[a-z]/.test(text[k])) continue;
    return j;
  }
  return final && text.slice(from).trim() ? text.length : -1;
}

/** false for "Mr." / "e.g." / a single initial ("J."): a dot that does not end the sentence. */
function isSentenceDot(text: string, from: number, dot: number): boolean {
  const m = /([A-Za-z.]+)$/.exec(text.slice(from, dot));
  if (!m) return true;
  const word = m[1].replace(/^\.+/, '');
  if (!word) return true;
  if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  if (/^[A-Z]$/.test(word)) return false; // initial
  return true;
}

/** Where a long run without sentence punctuation can be cut (after a comma / semicolon / colon / dash), or -1. */
function softBreak(text: string, from: number, maxChars: number): number {
  if (text.length - from <= maxChars) return -1;
  const window = text.slice(from, from + maxChars);
  let best = -1;
  for (const m of window.matchAll(/[,;:–—](?=\s)/g)) if (m.index! >= 40) best = m.index! + 1;
  return best < 0 ? -1 : from + best;
}

export class StreamSentenceSplitter {
  private text = '';
  private consumed = 0;
  private carry = '';
  private readonly maxChars: number;
  private readonly minChars: number;

  constructor(opts: SplitterOptions = {}) {
    this.maxChars = opts.maxChars ?? 220;
    this.minChars = opts.minChars ?? 2;
  }

  /** The full reply so far (each call passes the whole text, as the AI client's onDelta does); returns new sentences. */
  push(full: string): string[] {
    if (!full.startsWith(this.text)) {
      // the stream restarted (should not happen): start over from what is new
      this.text = full; this.consumed = Math.min(this.consumed, full.length);
    } else this.text = full;
    return this.drain(false);
  }

  /** Appends a piece of text (delta) instead of the full text; returns new sentences. */
  append(delta: string): string[] { return this.push(this.text + delta); }

  /** The reply is complete: everything not yet returned. `final` (the complete text) replaces what was streamed. */
  flush(final?: string): string[] {
    if (final !== undefined && final.startsWith(this.text)) this.text = final;
    const out = this.drain(true);
    if (this.carry) { out.push(this.carry); this.carry = ''; }
    return out;
  }

  /** text received but not yet returned as a sentence */
  get pending(): string { return (this.carry ? `${this.carry} ` : '') + this.text.slice(this.consumed).trim(); }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      let end = findSentenceEnd(this.text, this.consumed, final);
      if (end < 0 || end - this.consumed > this.maxChars) { const soft = softBreak(this.text, this.consumed, this.maxChars); if (soft > 0) end = soft; }
      if (end < 0) break;
      const piece = this.text.slice(this.consumed, end).replace(/\s+/g, ' ').trim();
      this.consumed = end;
      if (!piece) continue;
      const joined = this.carry ? `${this.carry} ${piece}` : piece;
      if (joined.replace(/[^\p{L}\p{N}]/gu, '').length < this.minChars) { this.carry = joined; continue; }
      this.carry = '';
      out.push(joined);
    }
    return out;
  }
}

/** Splits a complete text into sentences (same rules as the streamed splitter). */
export function splitSentences(text: string, opts?: SplitterOptions): string[] {
  return new StreamSentenceSplitter(opts).flush(text);
}
