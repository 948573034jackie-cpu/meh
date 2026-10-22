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
  /**
   * the same limit for the first piece only (default maxChars): a spoken explanation starts after its first piece is
   * synthesized, so a long first sentence is cut at a comma to start sooner
   */
  firstMaxChars?: number;
  /** shortest piece emitted on its own; shorter ones wait to be joined with the next sentence (default 2) */
  minChars?: number;
}

/** A piece of the reply and whether a blank line (a new paragraph) came before it. */
export interface SentencePiece { text: string; paragraph: boolean }

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
  private carry: SentencePiece | null = null;
  /** pieces returned so far (the first one may use firstMaxChars) */
  private emitted = 0;
  /** index just after the last non-space character of the previous piece (where the gap before the next one starts) */
  private lastEnd = 0;
  private readonly maxChars: number;
  private readonly firstMaxChars: number;
  private readonly minChars: number;

  constructor(opts: SplitterOptions = {}) {
    this.maxChars = opts.maxChars ?? 220;
    this.firstMaxChars = opts.firstMaxChars ?? this.maxChars;
    this.minChars = opts.minChars ?? 2;
  }

  /** The full reply so far (each call passes the whole text, as the AI client's onDelta does); returns new sentences. */
  push(full: string): string[] { return this.pushPieces(full).map((p) => p.text); }

  /** push(), with each sentence's paragraph mark */
  pushPieces(full: string): SentencePiece[] {
    if (!full.startsWith(this.text)) {
      // the stream restarted (should not happen): start over from what is new
      this.text = full; this.consumed = Math.min(this.consumed, full.length); this.lastEnd = Math.min(this.lastEnd, this.consumed);
    } else this.text = full;
    return this.drain(false);
  }

  /** Appends a piece of text (delta) instead of the full text; returns new sentences. */
  append(delta: string): string[] { return this.push(this.text + delta); }

  /** The reply is complete: everything not yet returned. `final` (the complete text) replaces what was streamed. */
  flush(final?: string): string[] { return this.flushPieces(final).map((p) => p.text); }

  /** flush(), with each sentence's paragraph mark */
  flushPieces(final?: string): SentencePiece[] {
    if (final !== undefined && final.startsWith(this.text)) this.text = final;
    const out = this.drain(true);
    if (this.carry) { out.push(this.carry); this.carry = null; this.emitted++; }
    return out;
  }

  /** text received but not yet returned as a sentence */
  get pending(): string { return (this.carry ? `${this.carry.text} ` : '') + this.text.slice(this.consumed).trim(); }

  private drain(final: boolean): SentencePiece[] {
    const out: SentencePiece[] = [];
    for (;;) {
      const max = this.emitted === 0 && !this.carry ? this.firstMaxChars : this.maxChars;
      let end = findSentenceEnd(this.text, this.consumed, final);
      if (end < 0 || end - this.consumed > max) { const soft = softBreak(this.text, this.consumed, max); if (soft > 0) end = soft; }
      if (end < 0) break;
      const raw = this.text.slice(this.consumed, end);
      const piece = raw.replace(/\s+/g, ' ').trim();
      const start = this.consumed + (raw.length - raw.trimStart().length);
      this.consumed = end;
      if (!piece) continue;
      // a blank line between the previous piece and this one: a new paragraph
      const paragraph = this.lastEnd > 0 && /\n[^\S\n]*\n/.test(this.text.slice(this.lastEnd, start));
      this.lastEnd = start + raw.trim().length;
      const joined: SentencePiece = this.carry ? { text: `${this.carry.text} ${piece}`, paragraph: this.carry.paragraph } : { text: piece, paragraph };
      if (joined.text.replace(/[^\p{L}\p{N}]/gu, '').length < this.minChars) { this.carry = joined; continue; }
      this.carry = null;
      this.emitted++;
      out.push(joined);
    }
    return out;
  }
}

/** Splits a complete text into sentences (same rules as the streamed splitter). */
export function splitSentences(text: string, opts?: SplitterOptions): string[] {
  return new StreamSentenceSplitter(opts).flush(text);
}
