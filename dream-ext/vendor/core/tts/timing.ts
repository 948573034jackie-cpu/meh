import type { Sentence } from '@core/model';

/** Maps a char index inside a sentence's text to the index of the token containing it (or the next token). */
export function tokenIndexAtChar(sentence: Sentence, charIndexInSentence: number): number {
  const abs = sentence.start + charIndexInSentence;
  const toks = sentence.tokens;
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].start <= abs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans >= 0 && abs < toks[ans].end) return ans;
  // inside a gap between tokens: return the next word-ish token
  return Math.min(ans + 1, toks.length - 1);
}

export interface EstimatedWord { charIndex: number; charLength: number; at: number }

/**
 * Estimates when each word of `text` is spoken, spreading `durationSec` over the characters.
 * Punctuation gets a small extra pause weight. Used when an engine gives no word boundaries.
 */
export function estimateWordTimes(text: string, durationSec: number): EstimatedWord[] {
  const words: { start: number; end: number; weight: number }[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2);
    const pause = /[.!?;:,—…]/.test(after) ? 2.5 : 0;
    words.push({ start: m.index, end: m.index + m[0].length, weight: m[0].length + 1 + pause });
  }
  const total = words.reduce((s, w) => s + w.weight, 0) || 1;
  let acc = 0;
  return words.map((w) => {
    const at = (acc / total) * durationSec;
    acc += w.weight;
    return { charIndex: w.start, charLength: w.end - w.start, at };
  });
}

/** Rough spoken duration in seconds for text at a given rate (about 2.7 words per second at rate 1). */
export function estimateDurationSec(text: string, rate: number): number {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  return Math.max(0.3, (words / 2.7 + 0.25) / Math.max(0.3, rate));
}
