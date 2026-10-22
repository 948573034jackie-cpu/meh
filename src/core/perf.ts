import type { KokoroSegmentStat } from '@shared/api';
import type { UsageRecord } from '@shared/settings';

/**
 * Speed numbers for the Diagnostics screen (src/renderer/views/Diagnostics.tsx), so the estimates for the learner's
 * Mac become measurements: a fixed-size log of the latest measurements (the main process keeps the Kokoro segments in
 * one) and medians / percentiles of the voice's real-time factor and of the AI's time to its first words.
 */

/** The latest `capacity` items; once full, each push replaces the oldest. */
export class RecentLog<T> {
  private items: T[] = [];
  /** where the next push goes once the log is full (= the oldest item) */
  private next = 0;
  constructor(readonly capacity: number) { if (!(capacity >= 1)) throw new RangeError('RecentLog needs a capacity of at least 1'); }
  push(item: T): void {
    if (this.items.length < this.capacity) this.items.push(item);
    else this.items[this.next] = item;
    this.next = (this.next + 1) % this.capacity;
  }
  get size(): number { return this.items.length; }
  /** oldest first */
  toArray(): T[] { return this.items.length < this.capacity ? [...this.items] : [...this.items.slice(this.next), ...this.items.slice(0, this.next)]; }
}

/** The q-quantile (0..1) of the finite values, interpolated between the two nearest ranks; null when there are none. */
export function quantile(values: readonly number[], q: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export function median(values: readonly number[]): number | null { return quantile(values, 0.5); }

export interface SegmentSummary {
  /** segments summarized (at most `last`) */
  count: number;
  /** synthesis time / audio time: under 1 is faster than real time */
  medianRtf: number | null;
  p90Rtf: number | null;
  /** ms from the request to the start of the synthesis */
  medianQueueWaitMs: number | null;
  maxQueueWaitMs: number | null;
}

/** The voice's speed over its last `last` synthesized segments (oldest first in `segments`). */
export function summarizeSegments(segments: readonly KokoroSegmentStat[], last = 50): SegmentSummary {
  const s = segments.slice(-last);
  const rtf = s.map((x) => x.rtf);
  const wait = s.map((x) => x.queueWaitMs);
  return { count: s.length, medianRtf: median(rtf), p90Rtf: quantile(rtf, 0.9), medianQueueWaitMs: median(wait), maxQueueWaitMs: wait.length ? Math.max(...wait) : null };
}

export interface AiLatency {
  model: string;
  /** timed requests summarized (at most `last`) */
  count: number;
  /** ms from the request to the first words of the reply */
  medianTtftMs: number | null;
  /** ms from the request to the whole reply (requests that were not cancelled) */
  medianTotalMs: number | null;
}

/**
 * Per model, the medians of its last `last` timed explanation requests (usage records with ttftMs or totalMs; the
 * chapter hints job and older records have none), the model used most recently first.
 */
export function aiLatencyByModel(records: readonly UsageRecord[], last = 20): AiLatency[] {
  const byModel = new Map<string, UsageRecord[]>();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (typeof r?.ttftMs !== 'number' && typeof r?.totalMs !== 'number') continue;
    const list = byModel.get(r.model) ?? [];
    if (!byModel.has(r.model)) byModel.set(r.model, list);
    if (list.length < last) list.push(r);
  }
  return [...byModel].map(([model, rs]) => ({
    model,
    count: rs.length,
    medianTtftMs: median(rs.flatMap((r) => (typeof r.ttftMs === 'number' ? [r.ttftMs] : []))),
    medianTotalMs: median(rs.flatMap((r) => (typeof r.totalMs === 'number' && !r.partial ? [r.totalMs] : []))),
  }));
}
