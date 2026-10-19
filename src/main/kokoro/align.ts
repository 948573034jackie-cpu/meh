import { PAD_TOKEN } from './phonemes';

export interface WordTime { charIndex: number; charLength: number; start: number; end: number }

/**
 * Converts the model's per-token frame counts into word start/end seconds.
 * `durations` has one entry per input token INCLUDING the two pad tokens (so durations.length = tokens + 2).
 * The frame size is not assumed (Kokoro v1.0 exports give 600 samples per frame at 24 kHz): the frame sum is
 * scaled to the real waveform length, as kokoro-onnx does.
 */
export function wordTimes(
  durations: ArrayLike<number | bigint>,
  owner: number[],
  words: { charIndex: number; charLength: number }[],
  samples: number,
  sampleRate: number,
  offsetSamples = 0,
): WordTime[] {
  const n = durations.length;
  const frames = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) frames[i + 1] = frames[i] + Number(durations[i]);
  const scale = frames[n] > 0 ? samples / frames[n] : 0;
  const edge = (i: number) => frames[i] * scale + offsetSamples;
  const out: WordTime[] = [];
  let cur = -1;
  // token i (0-based, no pads) is durations[i + 1]
  for (let i = 0; i < owner.length && i + 1 < n; i++) {
    const w = owner[i];
    if (w < 0 || w === cur) { if (w === cur && w >= 0) out[out.length - 1].end = edge(i + 2) / sampleRate; continue; }
    cur = w;
    out.push({ charIndex: words[w].charIndex, charLength: words[w].charLength, start: edge(i + 1) / sampleRate, end: edge(i + 2) / sampleRate });
  }
  return out;
}

/**
 * Sample range to keep: Kokoro pads ~0.3 s of silence before the first token and more after the last.
 * Returns [startSample, endSample) keeping `leadSec` before the first real token and `tailSec` after the last.
 */
export function trimRange(durations: ArrayLike<number | bigint>, tokens: number[], samples: number, sampleRate: number, leadSec = 0.05, tailSec = 0.12): [number, number] {
  const n = durations.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += Number(durations[i]);
  if (!total || n < 3) return [0, samples];
  const scale = samples / total;
  const first = Number(durations[0]) * scale;
  let tailFrames = Number(durations[n - 1]);
  // trailing pad plus any trailing punctuation/space tokens are silence too
  for (let i = tokens.length - 1; i >= 0 && (tokens[i] === PAD_TOKEN || tokens[i] <= 16); i--) tailFrames += Number(durations[i + 1]);
  const last = samples - tailFrames * scale;
  const start = Math.max(0, Math.floor(first - leadSec * sampleRate));
  const end = Math.min(samples, Math.ceil(last + tailSec * sampleRate));
  return end > start ? [start, end] : [0, samples];
}
