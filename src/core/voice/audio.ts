/**
 * Small PCM helpers for the voice pipeline (pure TypeScript, no dependencies): sample-format conversion, a
 * stateful linear resampler for streaming frames, and a ring buffer addressed by absolute sample index so a
 * VAD segment [start, end) can be sliced out after the fact.
 */

/** Int16 PCM → Float32 in -1..1. */
export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/** Float32 in -1..1 → Int16 PCM (clamped). */
export function float32ToInt16(pcm: Float32Array): Int16Array {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    out[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
  }
  return out;
}

/** Whole-buffer linear resampling (good enough for speech going into a 16 kHz recogniser). */
export function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const r = new Resampler(from, to);
  const a = r.process(x);
  const b = r.flush();
  if (!b.length) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

/**
 * Stateful linear resampler: feed frames of any size, get frames back; the last input sample is kept as the
 * interpolation context for the next call so there is no seam between frames.
 */
export class Resampler {
  private readonly ratio: number; // input samples per output sample
  private last: number | null = null;
  private pos = 0; // position of the next output sample in input-sample units, relative to `last`
  constructor(readonly from: number, readonly to: number) {
    if (!(from > 0) || !(to > 0)) throw new Error('Resampler: sample rates must be positive');
    this.ratio = from / to;
  }

  process(x: Float32Array): Float32Array {
    if (this.from === this.to) return x;
    if (!x.length) return new Float32Array(0);
    // Virtual input: [last, ...x]; index 0 is `last` (or x[0] on the very first call).
    const first = this.last === null;
    const n = x.length + (first ? 0 : 1);
    const at = (i: number): number => (first ? x[i] : i === 0 ? (this.last as number) : x[i - 1]);
    const out: number[] = [];
    let p = this.pos;
    while (p + 1 < n) {
      const j = Math.floor(p), f = p - j;
      out.push(at(j) * (1 - f) + at(j + 1) * f);
      p += this.ratio;
    }
    // Keep the last input sample as context; rebase p onto it.
    this.last = x[x.length - 1];
    this.pos = p - (n - 1);
    return Float32Array.from(out);
  }

  /** Emit the final sample(s) that are still waiting for a next frame and reset. */
  flush(): Float32Array {
    const out: number[] = [];
    if (this.last !== null && this.pos <= 0) out.push(this.last);
    this.reset();
    return Float32Array.from(out);
  }

  reset(): void { this.last = null; this.pos = 0; }
}

/**
 * Fixed-capacity Float32 ring buffer addressed by absolute sample index: `write` appends, `slice(start, end)`
 * returns a copy of the samples at those absolute positions (clamped to what is still in the buffer).
 */
export class RingBuffer {
  private readonly buf: Float32Array;
  /** absolute index of the next sample to be written */
  private _end = 0;
  constructor(readonly capacity: number) { this.buf = new Float32Array(capacity); }

  get end(): number { return this._end; }
  /** oldest absolute index still available */
  get start(): number { return Math.max(0, this._end - this.capacity); }

  write(x: Float32Array): void {
    let src = x;
    if (src.length > this.capacity) src = src.subarray(src.length - this.capacity);
    const at = this._end % this.capacity;
    const firstPart = Math.min(src.length, this.capacity - at);
    this.buf.set(src.subarray(0, firstPart), at);
    if (firstPart < src.length) this.buf.set(src.subarray(firstPart), 0);
    this._end += x.length;
  }

  slice(start: number, end: number): Float32Array {
    const s = Math.max(start, this.start), e = Math.min(end, this._end);
    if (e <= s) return new Float32Array(0);
    const out = new Float32Array(e - s);
    const at = s % this.capacity;
    const firstPart = Math.min(out.length, this.capacity - at);
    out.set(this.buf.subarray(at, at + firstPart));
    if (firstPart < out.length) out.set(this.buf.subarray(0, out.length - firstPart), firstPart);
    return out;
  }

  reset(): void { this._end = 0; }
}

/** Root-mean-square level of a frame (0..1), handy for silence checks in tests and benches. */
export function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return x.length ? Math.sqrt(s / x.length) : 0;
}
