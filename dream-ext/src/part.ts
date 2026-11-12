/**
 * "Explain the last N seconds": which COMPLETE sentences that is. The last sentence heard is always in (even when it
 * alone is longer than N); an earlier one only when it was (partly) heard inside the last N seconds and the whole part
 * stays within about N x 1.3. So a "10 s" part is about 10 s: a long sentence that began 25 s ago no longer makes it
 * 30 s long, and two long sentences are never taken together.
 */
export interface Span { start: number; end: number }

/** a part of "N seconds" may be this much longer, so that its sentences stay complete */
export const PART_STRETCH = 1.3;

/** the first and last index (inclusive) of the part, or null when there are no sentences */
export function partRange(spans: readonly Span[], time: number, seconds: number, stretch = PART_STRETCH): [number, number] | null {
  if (!spans.length) return null;
  let end = -1;
  for (let i = 0; i < spans.length; i++) { if (spans[i].start <= time + 0.05) end = i; else break; }
  if (end < 0) return [0, 0];
  // a sentence that has only just started is not part of what was heard
  if (end > 0 && time - spans[end].start < 0.8) end--;
  const partEnd = spans[end].end;
  let start = end;
  while (start > 0) {
    const prev = spans[start - 1];
    if (prev.end <= time - seconds || partEnd - prev.start > seconds * stretch) break;
    start--;
  }
  return [start, end];
}
