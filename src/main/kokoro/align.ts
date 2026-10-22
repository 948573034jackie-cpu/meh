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

/**
 * Energy trim (after trimRange): Kokoro gives the pause after a sentence or clause to its LAST phoneme (about 22
 * frames, 0.55 s, against about 2 for an ordinary phoneme), so trimRange, which trusts the durations, still keeps
 * about 0.6 s of silence at the end of every clip (15% of all audio, measured). The renderer adds the pauses on
 * purpose instead (SEGMENT_PAUSE_MS between segments, the sentence pause between sentences).
 */
export interface SpeechTrimOptions { frameSec: number; floorDb: number; rangeDb: number; keepSec: number; fadeSec: number; leadSec: number; searchSec: number }

export const SPEECH_TRIM: Readonly<SpeechTrimOptions> = {
  /** 10 ms RMS frames */
  frameSec: 0.01,
  /**
   * speech = a frame above max(floorDb, peak - rangeDb). Not higher: a soft final consonant (the "f" of "wife.") runs
   * about 150 ms at -41 to -48 dBFS; the noise floor after the speech is -75 to -85 dBFS, then digital silence
   */
  floorDb: -58,
  rangeDb: 45,
  /** kept after the last speech frame, then faded out linearly over fadeSec */
  keepSec: 0.08,
  fadeSec: 0.015,
  /** kept before the first speech frame */
  leadSec: 0.03,
  /** only this much at each end is searched; when no speech frame is found there, that end stays as it was */
  searchSec: 1.2,
};

/**
 * The part of `wave[start, end)` to keep by energy (SPEECH_TRIM): from `leadSec` before the first speech frame to
 * `keepSec + fadeSec` after the last one, with the fade applied to `wave` in place. Returns [start, end).
 */
export function speechRange(wave: Float32Array, start: number, end: number, sampleRate: number, opts: Readonly<SpeechTrimOptions> = SPEECH_TRIM): [number, number] {
  const frame = Math.max(1, Math.round(opts.frameSec * sampleRate));
  const n = Math.floor((end - start) / frame);
  if (n < 3) return [start, end];
  const db = new Float64Array(n);
  let peak = -Infinity;
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const from = start + f * frame;
    for (let i = from; i < from + frame; i++) sum += wave[i] * wave[i];
    db[f] = 10 * Math.log10(sum / frame + 1e-12);
    if (db[f] > peak) peak = db[f];
  }
  const thr = Math.max(opts.floorDb, peak - opts.rangeDb);
  const search = Math.ceil(opts.searchSec / opts.frameSec);
  let first = -1;
  for (let f = 0; f < Math.min(n, search); f++) if (db[f] > thr) { first = f; break; }
  let last = -1;
  for (let f = n - 1; f >= Math.max(0, n - search); f--) if (db[f] > thr) { last = f; break; }
  const newStart = first > 0 ? Math.max(start, start + first * frame - Math.round(opts.leadSec * sampleRate)) : start;
  // the last full frame is speech: the clip may end inside a word, keep it whole
  if (last < 0 || last === n - 1) return [newStart, end];
  const fadeFrom = start + (last + 1) * frame + Math.round(opts.keepSec * sampleRate);
  const fadeLen = Math.max(1, Math.round(opts.fadeSec * sampleRate));
  const newEnd = Math.min(end, fadeFrom + fadeLen);
  for (let i = fadeFrom; i < newEnd; i++) wave[i] *= 1 - (i - fadeFrom + 1) / fadeLen;
  return newEnd > newStart ? [newStart, newEnd] : [start, end];
}
