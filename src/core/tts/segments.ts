/**
 * Synthesis segments for the local neural voice (Kokoro). Synthesis time grows with the text, so a long sentence
 * (or a multi-sentence explanation) is synthesized in clause-sized pieces: the first piece is ready after a
 * fraction of the time and the rest is synthesized while it plays. The renderer plays the pieces back to back
 * (src/core/tts/audio.ts) and the main process uses the same split for prepare()/synthesize() of whole texts
 * (src/main/kokoro/engine.ts), so both ask for exactly the same pieces and share one cache entry per piece.
 *
 * The split is deterministic and ignores leading/trailing whitespace (the main process trims what it is given).
 * Cut points, best first: the end of a sentence, then ; : — , then a comma; never after a title such as "Mr.".
 * A text with no punctuation at all is cut at a space.
 */

export interface SynthesisSegment {
  /** the piece to synthesize (trimmed) */
  text: string;
  /** offset of `text` in the text given to synthesisSegments() (UTF-16 units) */
  start: number;
}

/** texts up to this many characters (about 10 s of speech) are synthesized whole */
export const SEGMENT_SPLIT_ABOVE = 180;
/** a piece is at most this long (about 8 s of speech, 2–4 s to synthesize on a 4-core Intel Mac) */
export const SEGMENT_MAX = 150;
/** and at least this long (shorter pieces sound choppy and gain nothing) */
export const SEGMENT_MIN = 40;

const TITLE_BEFORE_DOT = /(?:^|[\s“"‘'(])(?:Mr|Mrs|Ms|Dr|St|Prof|Jr|Sr|vs|etc|e\.g|i\.e|[A-Z])$/;
const CLOSERS = /["”’'»)\]]/;

/** Strength of a cut right after index `i` of `s` (0 = not a cut point). */
function cutStrength(s: string, i: number): number {
  const ch = s[i];
  let end = i;
  while (end + 1 < s.length && CLOSERS.test(s[end + 1])) end++; // keep closing quotes with the clause they close
  const after = s[end + 1];
  if (ch === '—' || ch === '–') return after === undefined ? 0 : 2;
  if (after !== undefined && !/\s/.test(after)) return 0;
  if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
    if (ch === '.' && TITLE_BEFORE_DOT.test(s.slice(Math.max(0, i - 6), i))) return 0;
    return 3;
  }
  if (ch === ';' || ch === ':') return 2;
  if (ch === ',') return 1;
  return 0;
}

/** Index just after the cut at `i` (closing quotes included). */
function cutEnd(s: string, i: number): number {
  let end = i;
  while (end + 1 < s.length && CLOSERS.test(s[end + 1])) end++;
  return end + 1;
}

export function synthesisSegments(text: string, splitAbove = SEGMENT_SPLIT_ABOVE, max = SEGMENT_MAX, min = SEGMENT_MIN): SynthesisSegment[] {
  const lead = text.length - text.trimStart().length;
  const s = text.trim();
  if (s.length <= splitAbove) return [{ text: s, start: lead }];
  const out: SynthesisSegment[] = [];
  let pos = 0;
  while (pos < s.length) {
    if (s.length - pos <= max) { out.push(piece(s, pos, s.length, lead)); break; }
    let best = -1; let bestStrength = 0;
    for (let i = pos + min; i < Math.min(s.length, pos + max); i++) {
      const st = cutStrength(s, i);
      if (!st) continue;
      const end = cutEnd(s, i);
      if (end - pos > max || s.length - end < min / 2) continue;
      // strongest cut wins; between equals the later one (fewer, longer pieces)
      if (st >= bestStrength) { best = end; bestStrength = st; }
    }
    if (best < 0) {
      const space = s.lastIndexOf(' ', pos + max);
      best = space > pos + min ? space : Math.min(s.length, pos + max);
    }
    out.push(piece(s, pos, best, lead));
    pos = best;
    while (pos < s.length && /\s/.test(s[pos])) pos++;
  }
  return out.filter((p) => p.text.length > 0);
}

function piece(s: string, from: number, to: number, lead: number): SynthesisSegment {
  const raw = s.slice(from, to);
  const l = raw.length - raw.trimStart().length;
  return { text: raw.trim(), start: lead + from + l };
}

/** The punctuation a synthesized piece ends with (closing quotes ignored); null = none (cut at a space). */
export type EndPunct = '.' | '?' | '!' | ',' | ';' | ':' | '—' | null;

/** The trailing punctuation of `text`: '…' counts as '.', '–' as '—'; closing quotes and brackets are skipped. */
export function endPunctOf(text: string): EndPunct {
  let i = text.trimEnd().length - 1;
  while (i >= 0 && CLOSERS.test(text[i])) i--;
  const ch = text[i];
  if (ch === '.' || ch === '…') return '.';
  if (ch === '?' || ch === '!' || ch === ',' || ch === ';' || ch === ':' || ch === '—') return ch;
  if (ch === '–') return '—';
  return null;
}

/**
 * Silence (ms) played after a segment that ends with this punctuation, before the next segment of the same text. The
 * local voice's audio is trimmed to about 80 ms after the speech (src/main/kokoro/engine.ts), so the pause the model
 * would have made is added here on purpose: close to what Kokoro leaves when it reads both pieces in one call.
 */
export const SEGMENT_PAUSE_MS: Record<Exclude<EndPunct, null>, number> = { ',': 180, ';': 280, ':': 280, '—': 280, '.': 350, '?': 350, '!': 350 };

export function pauseAfter(p: EndPunct | undefined): number { return p ? SEGMENT_PAUSE_MS[p] : 0; }

/** Request priorities of the Kokoro queue in the main process (higher first). */
export const PRIORITY = {
  /** a speak() waiting for its audio right now (reading or an explanation) */
  now: 100,
  /**
   * an explanation the learner will hear in a few seconds (prepareSoon: the first sentences of a reply that streams in
   * during a Listening stop's commands window, then the rest while it is spoken), and the hard word a Listening stop
   * will say 3 times (asked for when its sentence starts, readAhead's `urgent`): after any speak(), before the book's
   * next sentence and read-ahead
   */
  soon: 95,
  /** the sentence after the one playing: synthesized as soon as nothing is waiting */
  next: 90,
  /** the hard words of that next sentence when it will stop (readAhead's `upcoming`): after it, before the read-ahead */
  nextWords: 85,
  /** read-ahead: `ahead - distance` (distance 1 = the next sentence) */
  ahead: 80,
  /** a plain prepare() without priority */
  background: 0,
} as const;
