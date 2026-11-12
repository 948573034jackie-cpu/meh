/**
 * Video mode on a phone or iPad: the subtitles on the video are like a film's: only what is being said now, in one or
 * two lines, never the whole long sentence (its end used to be cut off). A sentence that does not fit in two lines is
 * shown in pieces; the piece with the word being said is on the screen.
 */

/** how many letters fit in one line of this width and text size (a film uses about 42 at most) */
export function lettersPerLine(widthPx: number, fontPx: number): number {
  const n = Math.floor(widthPx / Math.max(1, fontPx * 0.52));
  return Math.max(14, Math.min(42, Number.isFinite(n) ? n : 42));
}

/**
 * The pieces of a sentence: `lengths[i]` = the letters of word i (with the space and punctuation after it);
 * `breakAfter[i]` = a comma, a full stop … follows word i (a good place to cut). Each piece holds at most `budget`
 * letters (a single longer word is its own piece); the pieces are about the same length, cut at punctuation when one
 * is near. Returns, for every word, the number of its piece.
 */
export function chunkWords(lengths: readonly number[], budget: number, breakAfter: readonly boolean[] = []): number[] {
  const total = lengths.reduce((a, b) => a + b, 0);
  const out: number[] = new Array(lengths.length).fill(0);
  if (total <= budget || lengths.length < 2) return out;
  const pieces = Math.ceil(total / budget);
  const target = Math.min(budget, Math.ceil(total / pieces) + 2);
  let piece = 0, used = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (used > 0 && used + lengths[i] > budget) { piece++; used = 0; }
    out[i] = piece;
    used += lengths[i];
    const left = lengths.length - 1 - i;
    if (!left) break;
    // (cut here: the piece is long enough; or punctuation follows and it is nearly long enough)
    if (used >= target || (breakAfter[i] && used >= target * 0.7)) { piece++; used = 0; }
  }
  return out;
}
