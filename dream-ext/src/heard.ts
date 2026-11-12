/**
 * "Words heard": ONE counter for the learner that never goes back to zero. A word (or phrase) asked or explained is
 * not asked again within the next N words heard (1,000), and the count goes on from one video to the next, because
 * the counter belongs to the learner, not to the video.
 *
 * The counter grows by a sentence's words when the sentence is heard for the first time in this sitting; hearing the
 * same sentence again (a rewind, a replay after an explanation) adds nothing. Each explained word keeps the counter's
 * value at that moment. A place in the video has a counter value too (`at`): the counter now, plus or minus the words
 * between that place and the sentence heard last, so the stops still to come can be planned.
 */
export interface HeardState { n: number; asked: Record<string, number> }
export const EMPTY_HEARD: HeardState = { n: 0, asked: {} };

/** saved data -> a clean state (anything broken = an empty one) */
export function readHeard(raw: unknown): HeardState {
  const r = raw as Partial<HeardState> | null | undefined;
  const n = typeof r?.n === 'number' && Number.isFinite(r.n) && r.n >= 0 ? Math.floor(r.n) : 0;
  const asked: Record<string, number> = {};
  if (r?.asked && typeof r.asked === 'object') for (const [k, v] of Object.entries(r.asked)) if (typeof v === 'number' && Number.isFinite(v) && v <= n) asked[k] = Math.floor(v);
  return { n, asked };
}

/** two devices' states -> one: the bigger counter; a word's newest explanation, measured as "how many words ago" */
export function mergeHeard(a: HeardState, b: HeardState): HeardState {
  const n = Math.max(a.n, b.n);
  const asked: Record<string, number> = {};
  for (const [s, src] of [[a, a.n], [b, b.n]] as [HeardState, number][]) for (const [k, v] of Object.entries(s.asked)) {
    const ago = src - v, at = n - ago;
    if (asked[k] === undefined || at > asked[k]) asked[k] = at;
  }
  return { n, asked };
}

export class HeardCounter {
  private n: number;
  private asked: Record<string, number>;
  /** the counter's value at this video's word 0 (moves when the learner jumps in the video) */
  private base: number;
  private counted = new Set<string>();
  /** something changed since the last save() */
  dirty = false;

  constructor(state: HeardState = EMPTY_HEARD) {
    const s = readHeard(state);
    this.n = s.n;
    this.asked = { ...s.asked };
    this.base = s.n;
  }

  /** the words heard so far, in all */
  get total(): number { return this.n; }

  /** a sentence was heard: `key` names it, it starts `offset` words into the video and has `words` words */
  hear(key: string, offset: number, words: number): void {
    if (!this.counted.has(key)) { this.counted.add(key); this.n += Math.max(0, words); this.dirty = true; }
    // (the place heard now is "now": what comes after it is that many words away)
    this.base = this.n - (offset + Math.max(0, words));
  }

  /** the counter's value at a place `offset` words into this video */
  at(offset: number): number { return this.base + offset; }

  /** a word or phrase was asked or explained at this place */
  ask(lemma: string, offset: number): void {
    this.asked[lemma] = Math.max(0, Math.min(this.n, Math.round(this.at(offset))));
    this.dirty = true;
  }

  /** asked or explained within the last `win` words heard before this place: not again so soon (win 0 = no such rule) */
  lately(lemma: string, offset: number, win: number): boolean {
    const a = this.asked[lemma];
    if (a === undefined || win <= 0) return false;
    const here = this.at(offset);
    return here - a < win && here >= a - 1;
  }

  /** what to save: the counter and the words explained within the last `win` words (older ones no longer matter) */
  state(win = 1000): HeardState {
    const asked: Record<string, number> = {};
    const keep = Math.max(win, 1000) * 2;
    for (const [k, v] of Object.entries(this.asked)) if (this.n - v < keep) asked[k] = v;
    return { n: this.n, asked };
  }

  /** another device's (or the saved) state came in: both are kept */
  merge(other: HeardState): void {
    const before = this.n;
    const m = mergeHeard(this.state(1e9), readHeard(other));
    this.base += m.n - before;
    this.n = m.n;
    this.asked = m.asked;
  }
}
