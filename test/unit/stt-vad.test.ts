import { describe, it, expect } from 'vitest';
import { SpeechSegmenter, type SegmenterEvent } from '../../src/core/voice/vad';
import { Resampler, resampleLinear, RingBuffer, int16ToFloat32, float32ToInt16 } from '../../src/core/voice/audio';

const W = 512; // samples per window
const ms = (n: number): number => Math.round((n / 1000) * 16000);

/** Feed `n` windows of probability `p`, collecting events. */
function feed(seg: SpeechSegmenter, p: number, n: number): SegmenterEvent[] {
  const out: SegmenterEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...seg.push(p));
  return out;
}

describe('SpeechSegmenter', () => {
  it('ignores silence', () => {
    const seg = new SpeechSegmenter();
    expect(feed(seg, 0.01, 200)).toEqual([]);
    expect(seg.active).toBeNull();
    expect(seg.position).toBe(200 * W);
  });

  it('confirms speech after minSpeechMs with padding before it, and ends after minSilenceMs', () => {
    const seg = new SpeechSegmenter({ minSpeechMs: 200, minSilenceMs: 600, padMs: 300 });
    feed(seg, 0, 100); // 3.2 s of silence
    const ev = feed(seg, 0.95, 7); // 7 * 32 ms = 224 ms ≥ 200 ms
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({ type: 'speechStart', segmentId: 1, start: 100 * W - ms(300) });
    expect(seg.active).toEqual({ segmentId: 1, start: 100 * W - ms(300) });
    feed(seg, 0.95, 30);
    const lastSpeechEnd = seg.position;
    // 18 windows of silence = 576 ms: not yet
    expect(feed(seg, 0.02, 18)).toEqual([]);
    const end = feed(seg, 0.02, 1);
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ type: 'speechEnd', segmentId: 1, reason: 'silence', start: 100 * W - ms(300) });
    expect((end[0] as { end: number }).end).toBe(lastSpeechEnd + ms(300));
    expect(seg.active).toBeNull();
  });

  it('drops bursts shorter than minSpeechMs', () => {
    const seg = new SpeechSegmenter({ minSpeechMs: 250 });
    feed(seg, 0, 10);
    expect(feed(seg, 0.9, 3)).toEqual([]); // 96 ms
    expect(feed(seg, 0.1, 30)).toEqual([]);
    expect(seg.active).toBeNull();
  });

  it('uses hysteresis: a dip between threshold and negThreshold keeps the segment open', () => {
    const seg = new SpeechSegmenter({ threshold: 0.5, negThreshold: 0.35, minSilenceMs: 600 });
    feed(seg, 0.9, 20);
    expect(seg.inSpeech).toBe(true);
    expect(feed(seg, 0.4, 30)).toEqual([]); // ~1 s at 0.4: still speech
    expect(seg.inSpeech).toBe(true);
    expect(feed(seg, 0.3, 19).filter((e) => e.type === 'speechEnd')).toHaveLength(1);
  });

  it('keeps a sentence with a short pause in one segment', () => {
    const seg = new SpeechSegmenter({ minSilenceMs: 600 });
    feed(seg, 1, 40);
    feed(seg, 0, 12); // 384 ms pause
    const ev = feed(seg, 1, 40);
    expect(ev).toEqual([]);
    expect(seg.active?.segmentId).toBe(1);
  });

  it('cuts at maxSpeechMs and opens the next segment immediately', () => {
    const seg = new SpeechSegmenter({ maxSpeechMs: 2000, padMs: 100, minSpeechMs: 100 });
    feed(seg, 0, 10);
    const all = feed(seg, 1, 200);
    const ends = all.filter((e) => e.type === 'speechEnd') as Extract<SegmenterEvent, { type: 'speechEnd' }>[];
    const starts = all.filter((e) => e.type === 'speechStart') as Extract<SegmenterEvent, { type: 'speechStart' }>[];
    expect(ends.length).toBeGreaterThanOrEqual(2);
    expect(ends[0].reason).toBe('max');
    expect(ends[0].end - ends[0].start).toBeGreaterThanOrEqual(ms(2000));
    expect(ends[0].end - ends[0].start).toBeLessThan(ms(2000) + W);
    expect(starts[1].start).toBe(ends[0].end); // no padding back into the cut segment
    expect(starts.map((s) => s.segmentId)).toEqual([1, 2, 3, 4].slice(0, starts.length));
  });

  it('flush ends an open segment at the current position', () => {
    const seg = new SpeechSegmenter();
    feed(seg, 1, 20);
    const ev = seg.flush();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'speechEnd', reason: 'flush', end: 20 * W });
    expect(seg.flush()).toEqual([]);
  });

  it('never pads the start back into the previous segment', () => {
    const seg = new SpeechSegmenter({ minSilenceMs: 600, padMs: 300, minSpeechMs: 100 });
    feed(seg, 1, 20);
    const end = feed(seg, 0, 19).find((e) => e.type === 'speechEnd') as Extract<SegmenterEvent, { type: 'speechEnd' }>;
    const start = feed(seg, 1, 5).find((e) => e.type === 'speechStart') as Extract<SegmenterEvent, { type: 'speechStart' }>;
    expect(start.start).toBeGreaterThanOrEqual(end.end);
  });

  it('reset starts over at position 0', () => {
    const seg = new SpeechSegmenter();
    feed(seg, 1, 20);
    seg.reset();
    expect(seg.position).toBe(0);
    expect(seg.active).toBeNull();
  });
});

describe('audio helpers', () => {
  it('converts Int16 <-> Float32', () => {
    const f = int16ToFloat32(new Int16Array([0, 16384, -32768, 32767]));
    expect(Array.from(f).map((v) => +v.toFixed(4))).toEqual([0, 0.5, -1, 1]);
    expect(Array.from(float32ToInt16(new Float32Array([0, 0.5, -1, 1, 2])))).toEqual([0, 16384, -32768, 32767, 32767]);
  });

  it('resamples 24 kHz to 16 kHz with the right length and preserves a DC level', () => {
    const x = new Float32Array(2400).fill(0.25);
    const y = resampleLinear(x, 24000, 16000);
    expect(Math.abs(y.length - 1600)).toBeLessThanOrEqual(1);
    expect(y.every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
    expect(resampleLinear(x, 16000, 16000)).toBe(x);
  });

  it('streams frames without seams', () => {
    const sr = 24000, n = 4800;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 440 * i) / sr);
    const whole = resampleLinear(x, sr, 16000);
    const r = new Resampler(sr, 16000);
    const parts: Float32Array[] = [];
    for (let i = 0; i < n; i += 480) parts.push(r.process(x.subarray(i, i + 480)));
    parts.push(r.flush());
    const total = parts.reduce((s, p) => s + p.length, 0);
    const streamed = new Float32Array(total);
    let off = 0; for (const p of parts) { streamed.set(p, off); off += p.length; }
    expect(Math.abs(streamed.length - whole.length)).toBeLessThanOrEqual(1);
    const m = Math.min(streamed.length, whole.length);
    for (let i = 0; i < m; i++) expect(Math.abs(streamed[i] - whole[i])).toBeLessThan(1e-5);
  });

  it('ring buffer slices by absolute index across the wrap', () => {
    const rb = new RingBuffer(10);
    rb.write(Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
    rb.write(Float32Array.from([8, 9, 10, 11, 12]));
    expect(rb.end).toBe(13); expect(rb.start).toBe(3);
    expect(Array.from(rb.slice(3, 13))).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Array.from(rb.slice(0, 5))).toEqual([3, 4]); // clamped to what is still there
    expect(Array.from(rb.slice(11, 20))).toEqual([11, 12]);
    expect(rb.slice(5, 5)).toHaveLength(0);
    rb.write(new Float32Array(25).fill(7)); // larger than capacity
    expect(rb.end).toBe(38);
    expect(Array.from(rb.slice(28, 38))).toEqual(new Array(10).fill(7));
  });
});
