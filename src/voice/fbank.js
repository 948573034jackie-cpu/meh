(function () {
'use strict';
// Audio -> the 80-band log-mel features the speaker-recognition model (NeMo TitaNet-small) expects.
// Pure JS, no native code, so it runs the same in the app, in Node and in tests.
// Settings match the model's official pipeline (checked against it: 99.4% embedding agreement):
//   16 kHz, pre-emphasis 0.97, 25 ms Hann window / 10 ms step, 512-point FFT, centred frames (reflect
//   padding), Slaney mel bands 0-7600 Hz, ln(x + 2^-24), then per-band mean/std normalisation.

const SR = 16000;
const N_FFT = 512;
const WIN = 400;
const HOP = 160;
const MELS = 80;
const FMAX = 7600;
const PREEMPH = 0.97;
const GUARD = 2 ** -24;

function hzToMel(f) {
  const fsp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fsp, logStep = Math.log(6.4) / 27;
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logStep : f / fsp;
}
function melToHz(m) {
  const fsp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fsp, logStep = Math.log(6.4) / 27;
  return m >= minLogMel ? minLogHz * Math.exp(logStep * (m - minLogMel)) : fsp * m;
}

let FILTERS = null; // MELS x (N_FFT/2+1), Slaney-normalised
function filterbank() {
  if (FILTERS) return FILTERS;
  const bins = N_FFT / 2 + 1;
  const fft = new Float64Array(bins).map((_, i) => (i * SR) / N_FFT);
  const lo = hzToMel(0), hi = hzToMel(FMAX);
  const hz = new Float64Array(MELS + 2).map((_, i) => melToHz(lo + ((hi - lo) * i) / (MELS + 1)));
  const fb = [];
  for (let m = 0; m < MELS; m++) {
    const row = new Float32Array(bins);
    const enorm = 2 / (hz[m + 2] - hz[m]);
    for (let k = 0; k < bins; k++) {
      const lower = (fft[k] - hz[m]) / (hz[m + 1] - hz[m]);
      const upper = (hz[m + 2] - fft[k]) / (hz[m + 2] - hz[m + 1]);
      row[k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
    fb.push(row);
  }
  FILTERS = fb;
  return fb;
}

// In-place iterative radix-2 complex FFT (size N_FFT).
const COS = new Float64Array(N_FFT / 2), SIN = new Float64Array(N_FFT / 2);
for (let i = 0; i < N_FFT / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / N_FFT); SIN[i] = -Math.sin((2 * Math.PI * i) / N_FFT); }
const REV = new Uint16Array(N_FFT);
for (let i = 0; i < N_FFT; i++) { let r = 0; for (let b = 0, x = i; b < 9; b++, x >>= 1) r = (r << 1) | (x & 1); REV[i] = r; }
function fft(re, im) {
  for (let i = 0; i < N_FFT; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const half = size >> 1, step = N_FFT / size;
    for (let start = 0; start < N_FFT; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = start + k, b = a + half;
        const xr = re[b] * COS[t] - im[b] * SIN[t];
        const xi = re[b] * SIN[t] + im[b] * COS[t];
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

const WINDOW = new Float64Array(N_FFT); // 400-sample symmetric Hann, centred in the 512 frame
for (let n = 0; n < WIN; n++) WINDOW[(N_FFT - WIN) / 2 + n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (WIN - 1));

// pcm: Float32Array of 16 kHz mono samples in [-1, 1].
// Returns { data: Float32Array (MELS x frames, band-major), frames }.
function extractFeatures(pcm) {
  const L = pcm.length;
  if (L < N_FFT) throw new Error('audio too short');
  const x = new Float64Array(L);
  x[0] = pcm[0];
  for (let i = 1; i < L; i++) x[i] = pcm[i] - PREEMPH * pcm[i - 1];
  const half = N_FFT / 2;
  const at = (i) => { // reflect padding without repeating the edge sample
    if (i < 0) i = -i;
    if (i >= L) i = 2 * (L - 1) - i;
    return x[Math.min(Math.max(i, 0), L - 1)];
  };
  const frames = 1 + Math.floor(L / HOP);
  const fb = filterbank();
  const bins = N_FFT / 2 + 1;
  const logm = new Float64Array(MELS * frames);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT), pow = new Float64Array(bins);
  for (let t = 0; t < frames; t++) {
    const start = t * HOP - half;
    for (let n = 0; n < N_FFT; n++) { re[n] = at(start + n) * WINDOW[n]; im[n] = 0; }
    fft(re, im);
    for (let k = 0; k < bins; k++) pow[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < MELS; m++) {
      const row = fb[m];
      let s = 0;
      for (let k = 0; k < bins; k++) s += row[k] * pow[k];
      logm[m * frames + t] = Math.log(s + GUARD);
    }
  }
  const out = new Float32Array(MELS * frames);
  for (let m = 0; m < MELS; m++) {
    let mean = 0;
    for (let t = 0; t < frames; t++) mean += logm[m * frames + t];
    mean /= frames;
    let v = 0;
    for (let t = 0; t < frames; t++) v += (logm[m * frames + t] - mean) ** 2;
    const std = Math.sqrt(v / (frames - 1));
    for (let t = 0; t < frames; t++) out[m * frames + t] = (logm[m * frames + t] - mean) / (std + 1e-5);
  }
  return { data: out, frames };
}

const api = { extractFeatures, filterbank, SR, MELS, N_FFT, HOP };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else (globalThis.CEVoice = globalThis.CEVoice || {}).fbank = api; // plain <script> in the hidden page
})();
