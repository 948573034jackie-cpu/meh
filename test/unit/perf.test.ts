import { describe, it, expect } from 'vitest';
import { RecentLog, quantile, median, summarizeSegments, aiLatencyByModel } from '@core/perf';
import { speedLines, segmentLines, environmentLines } from '../../src/renderer/views/diagnosticsText';
import type { Diagnostics, KokoroSegmentStat } from '@shared/api';
import type { UsageRecord } from '@shared/settings';

const seg = (rtf: number, queueWaitMs = 0, priority = 100): KokoroSegmentStat => ({ at: Date.UTC(2026, 9, 22, 12, 0, 0), chars: 100, ms: Math.round(rtf * 6000), audioSec: 6, rtf, queueWaitMs, priority });
const rec = (model: string, ttftMs?: number, totalMs?: number, partial?: boolean): UsageRecord => ({
  date: '2026-10-22T12:00:00.000Z', provider: 'anthropic', model, inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0,
  ...(ttftMs !== undefined ? { ttftMs } : {}), ...(totalMs !== undefined ? { totalMs } : {}), ...(partial ? { partial } : {}),
});

describe('RecentLog (the Kokoro segment ring buffer)', () => {
  it('keeps the latest items, oldest first, and overwrites the oldest once full', () => {
    const log = new RecentLog<number>(3);
    expect(log.toArray()).toEqual([]);
    log.push(1); log.push(2);
    expect(log.toArray()).toEqual([1, 2]);
    log.push(3); log.push(4); log.push(5);
    expect(log.toArray()).toEqual([3, 4, 5]);
    expect(log.size).toBe(3);
    for (let i = 6; i <= 107; i++) log.push(i);
    expect(log.toArray()).toEqual([105, 106, 107]);
    expect(() => new RecentLog(0)).toThrow(RangeError);
  });
});

describe('quantiles', () => {
  it('median and p90 interpolate between the nearest ranks and ignore what is not a number', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
    expect(quantile([1, NaN, Infinity, 3], 0.5)).toBe(2);
    expect(quantile([1, 2], 2)).toBe(2); // q is clamped
  });

  it('summarizeSegments: median and p90 RTF of the last 50 segments only; queue wait median and max', () => {
    // 60 segments: the first 10 are very slow (RTF 5) and must not count
    const segs = [...Array.from({ length: 10 }, () => seg(5, 9000)), ...Array.from({ length: 50 }, (_, i) => seg(0.3 + i * 0.01, i * 10))];
    const s = summarizeSegments(segs, 50);
    expect(s.count).toBe(50);
    expect(s.medianRtf).toBeCloseTo(0.545, 6);
    expect(s.p90Rtf).toBeCloseTo(0.741, 6);
    expect(s.medianQueueWaitMs).toBe(245);
    expect(s.maxQueueWaitMs).toBe(490);
    expect(summarizeSegments([])).toEqual({ count: 0, medianRtf: null, p90Rtf: null, medianQueueWaitMs: null, maxQueueWaitMs: null });
  });

  it('aiLatencyByModel: the last 20 timed requests per model; records without timings ignored; a cancelled one has no total', () => {
    const records: UsageRecord[] = [
      rec('claude-opus-5-5'), // an old record (no timings)
      ...Array.from({ length: 10 }, () => rec('claude-opus-5-5', 20000, 40000)), // older than the last 20
      ...Array.from({ length: 20 }, (_, i) => rec('claude-opus-5-5', 2000 + i * 100, 6000 + i * 100)),
      rec('claude-sonnet-5-5', 1500, 3000),
      rec('claude-sonnet-5-5', 900, undefined, true), // a prepared explanation dropped after its first words
      rec('claude-haiku-4-5'), // the hints job: no timings
    ];
    const out = aiLatencyByModel(records, 20);
    expect(out.map((a) => a.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']); // the one used last first
    expect(out[1]).toEqual({ model: 'claude-opus-5-5', count: 20, medianTtftMs: 2950, medianTotalMs: 6950 });
    expect(out[0]).toEqual({ model: 'claude-sonnet-5-5', count: 2, medianTtftMs: 1200, medianTotalMs: 3000 });
    expect(aiLatencyByModel([rec('x')])).toEqual([]);
  });
});

describe('Diagnostics text', () => {
  const diag: Diagnostics = {
    platform: 'darwin', arch: 'x64', electron: '44', chrome: '1', node: '24', appVersion: '0.2.0', userData: '/u', secretsFile: '/s', dictWords: 5,
    secrets: {} as Diagnostics['secrets'],
    cpu: { model: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz', logical: 12, physical: 6 }, sttThreads: 2,
    kokoro: { state: 'ready', variant: 'fp16', threads: 4, spinning: true, inference: 'worker', loadMs: 2100, warmUpMs: 600, segments: [seg(0.5, 100), seg(0.6, 300), seg(0.7, 200, 79)] },
  };

  it('the speed summary names the voice settings, its median/p90 RTF, the CPU and the AI per model', () => {
    const lines = speedLines(diag, [rec('claude-opus-5-5', 3200, 7900)]);
    expect(lines[0]).toBe('Dream voice: ready, fp16, 4 threads, spinning on, inference in a worker thread; model load 2100 ms, warm-up 600 ms');
    expect(lines[1]).toMatch(/^Dream voice speed \(last 3 segments\): median RTF 0\.60, p90 0\.68 .*queue wait median 200 ms, max 300 ms$/);
    expect(lines[2]).toBe('CPU: Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz; 12 logical CPUs, 6 physical cores; speech recognition 2 threads');
    expect(lines[3]).toBe('AI claude-opus-5-5 (median of the last 1 explanation): first words after 3.2 s, whole reply after 7.9 s');
  });

  it('says so when nothing was measured yet; the web build (no voice facts, no physical cores) still reads well', () => {
    const lines = speedLines({ ...diag, kokoro: { ...diag.kokoro!, loadMs: null, warmUpMs: null, segments: [] } }, []);
    expect(lines[0]).toContain('model load not yet, warm-up not yet');
    expect(lines[1]).toMatch(/nothing synthesized yet/);
    expect(lines.at(-1)).toBe('AI first words: no timed explanation yet');
    const web = speedLines({ ...diag, kokoro: undefined, sttThreads: undefined, cpu: { model: 'unknown (browser)', logical: 8, physical: null } }, []);
    expect(web).toEqual(['CPU: unknown (browser); 8 logical CPUs', 'AI first words: no timed explanation yet']);
    expect(speedLines(null, [])).toEqual(['AI first words: no timed explanation yet']);
  });

  it('the environment lines leave the speed facts out; every segment gets one line for the copy', () => {
    const env = environmentLines(diag);
    expect(env).toContain('platform: darwin');
    expect(env.some((l) => /^(kokoro|cpu|sttThreads):/.test(l))).toBe(false);
    const segLines = segmentLines(diag.kokoro!.segments);
    expect(segLines).toHaveLength(4);
    expect(segLines[3]).toMatch(/^\d\d:\d\d:\d\d 100ch 4200ms 6\.00s rtf 0\.70 wait 200ms p79$/);
    expect(segmentLines([])).toEqual([]);
  });
});
