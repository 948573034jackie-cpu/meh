import type { Diagnostics, KokoroSegmentStat } from '@shared/api';
import type { UsageRecord } from '@shared/settings';
import { summarizeSegments, aiLatencyByModel } from '@core/perf';

/**
 * The text of the Diagnostics screen and of its "Copy diagnostics" button: the environment, and the speed facts that
 * turn the estimates for the learner's Mac into numbers (the voice's real-time factor, the CPU and threads, how long
 * the AI takes to its first words).
 */

/** Diagnostics fields shown in speedLines (not as raw key: value lines) */
const SPEED_FIELDS = new Set(['cpu', 'sttThreads', 'kokoro']);

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const fixed = (n: number | null, digits: number) => (n === null ? '?' : n.toFixed(digits));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One "key: value" line per environment fact. */
export function environmentLines(d: Diagnostics | null): string[] {
  if (!d) return [];
  return Object.entries(d).filter(([k, v]) => !SPEED_FIELDS.has(k) && v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
}

/** The speed summary: the local voice, its real-time factor over the last 50 segments, the CPU, the AI per model. */
export function speedLines(d: Diagnostics | null, usage: readonly UsageRecord[]): string[] {
  const out: string[] = [];
  const k = d?.kokoro;
  if (k) {
    out.push(`Dream voice: ${k.state}, ${k.variant}, ${plural(k.threads, 'thread')}, spinning ${k.spinning ? 'on' : 'off'}, inference in ${k.inference === 'worker' ? 'a worker thread' : 'the main thread'}; model load ${k.loadMs === null ? 'not yet' : `${k.loadMs} ms`}, warm-up ${k.warmUpMs === null ? 'not yet' : `${k.warmUpMs} ms`}`);
    const s = summarizeSegments(k.segments, 50);
    out.push(s.count
      ? `Dream voice speed (last ${plural(s.count, 'segment')}): median RTF ${fixed(s.medianRtf, 2)}, p90 ${fixed(s.p90Rtf, 2)} (under 1 = faster than real time); queue wait median ${Math.round(s.medianQueueWaitMs ?? 0)} ms, max ${Math.round(s.maxQueueWaitMs ?? 0)} ms`
      : 'Dream voice speed: nothing synthesized yet since the app started (read a few sentences, then copy again)');
  }
  if (d?.cpu) {
    const c = d.cpu;
    out.push(`CPU: ${c.model}; ${plural(c.logical, 'logical CPU')}${c.physical !== null ? `, ${plural(c.physical, 'physical core')}` : ''}${d.sttThreads !== undefined ? `; speech recognition ${plural(d.sttThreads, 'thread')}` : ''}`);
  }
  const ai = aiLatencyByModel(usage, 20);
  if (!ai.length) out.push('AI first words: no timed explanation yet');
  for (const a of ai) {
    out.push(`AI ${a.model} (median of the last ${plural(a.count, 'explanation')}): first words after ${a.medianTtftMs === null ? '?' : sec(a.medianTtftMs)}, whole reply after ${a.medianTotalMs === null ? '?' : sec(a.medianTotalMs)}`);
  }
  return out;
}

/** The voice's segments, one line each, oldest first: what was synthesized, how fast, after how long a wait. */
export function segmentLines(segments: readonly KokoroSegmentStat[]): string[] {
  if (!segments.length) return [];
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = (at: number) => { const t = new Date(at); return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`; };
  return [
    `Dream voice segments (${segments.length}, oldest first): time, characters, synthesis ms, audio s, RTF, queue wait ms, priority`,
    ...segments.map((s) => `${time(s.at)} ${s.chars}ch ${s.ms}ms ${s.audioSec.toFixed(2)}s rtf ${s.rtf.toFixed(2)} wait ${s.queueWaitMs}ms p${s.priority}`),
  ];
}
