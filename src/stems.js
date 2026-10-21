/*
 * Stem separation (vocals / drums / bass / other) with the MDX-Net models of
 * the KUIELab team (Music Demixing Challenge 2021; the ONNX files that
 * Ultimate Vocal Remover ships). The models take a short-time Fourier
 * transform of a stereo chunk (the first 2048 frequency rows, as real and
 * imaginary parts of each channel) and give back the same transform of one
 * stem; the sound is rebuilt with the inverse transform. The STFT / iSTFT
 * here match torch.stft / torch.istft (centre, reflect padding, periodic Hann
 * window), which is what the models were trained with.
 *
 * Pure JavaScript: used by the extension's offscreen page (ONNX Runtime Web)
 * and by the Node tests (same runtime, wasm backend).
 */
(function (root) {
  'use strict';

  // One MDX model per stem: the FFT size, and the chunk it looks at
  // (dimT frames of hop samples). dimF rows of the transform go in.
  const HOP = 1024;
  const MODELS = {
    vocals: { file: 'kuielab_a_vocals.onnx', nFft: 6144, dimF: 2048, dimT: 512 },
    drums: { file: 'kuielab_a_drums.onnx', nFft: 4096, dimF: 2048, dimT: 512 },
    bass: { file: 'kuielab_a_bass.onnx', nFft: 16384, dimF: 2048, dimT: 512 },
    other: { file: 'kuielab_a_other.onnx', nFft: 8192, dimF: 2048, dimT: 512 },
  };
  const SAMPLE_RATE = 44100; // the models were trained at 44.1 kHz
  const STEMS = ['vocals', 'drums', 'bass', 'other'];

  // ---------------------------------------------------------------------------
  // FFT (radix-2, in place, complex)
  // ---------------------------------------------------------------------------
  const fftCache = new Map();
  function fftTables(n) {
    let t = fftCache.get(n);
    if (t) return t;
    const bits = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    t = { rev, cos, sin };
    fftCache.set(n, t);
    return t;
  }

  /** In-place FFT of (re, im), length n = power of two. inverse: unscaled. */
  function fft2(re, im, inverse) {
    const n = re.length;
    const { rev, cos, sin } = fftTables(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, tw = 0; k < half; k++, tw += step) {
          const wr = cos[tw];
          const wi = inverse ? sin[tw] : -sin[tw];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  const r3Cache = new Map();
  /**
   * In-place FFT of length n = 2^k or 3 * 2^k (6144 for the vocals model):
   * three FFTs of a third of the points, joined with a radix-3 step.
   */
  function fft(re, im, inverse) {
    const n = re.length;
    if ((n & (n - 1)) === 0) return fft2(re, im, inverse);
    const m = n / 3;
    if (m !== Math.floor(m) || (m & (m - 1)) !== 0) throw new Error('FFT size must be 2^k or 3*2^k');
    let c = r3Cache.get(n);
    if (!c) {
      c = { r: [0, 1, 2].map(() => new Float64Array(m)), i: [0, 1, 2].map(() => new Float64Array(m)), cos: new Float64Array(n), sin: new Float64Array(n) };
      for (let k = 0; k < n; k++) {
        c.cos[k] = Math.cos((2 * Math.PI * k) / n);
        c.sin[k] = Math.sin((2 * Math.PI * k) / n);
      }
      r3Cache.set(n, c);
    }
    for (let r = 0; r < 3; r++) {
      const pr = c.r[r];
      const pi = c.i[r];
      for (let j = 0; j < m; j++) {
        pr[j] = re[3 * j + r];
        pi[j] = im[3 * j + r];
      }
      fft2(pr, pi, inverse);
    }
    const sg = inverse ? 1 : -1;
    for (let k = 0; k < n; k++) {
      const j = k % m;
      let sr = c.r[0][j];
      let si = c.i[0][j];
      for (let r = 1; r < 3; r++) {
        const tw = (r * k) % n;
        const wr = c.cos[tw];
        const wi = sg * c.sin[tw];
        const xr = c.r[r][j];
        const xi = c.i[r][j];
        sr += xr * wr - xi * wi;
        si += xr * wi + xi * wr;
      }
      re[k] = sr;
      im[k] = si;
    }
  }

  const winCache = new Map();
  function hann(n) {
    let w = winCache.get(n);
    if (w) return w;
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); // periodic
    winCache.set(n, w);
    return w;
  }

  // ---------------------------------------------------------------------------
  // STFT / iSTFT like torch (center=True, reflect padding, periodic Hann)
  // ---------------------------------------------------------------------------
  /**
   * chunk: [L, R] Float32Arrays of hop*(dimT-1) samples.
   * Returns Float32Array [4, dimF, dimT] (L re, L im, R re, R im).
   */
  function stft(chunk, m) {
    const { nFft, dimF, dimT } = m;
    const pad = nFft >> 1;
    const w = hann(nFft);
    const out = new Float32Array(4 * dimF * dimT);
    const re = new Float64Array(nFft);
    const im = new Float64Array(nFft);
    for (let c = 0; c < 2; c++) {
      const x = chunk[c];
      const L = x.length;
      // reflect padding: x[-k] = x[k], x[L-1+k] = x[L-1-k]
      const at = (i) => {
        if (i < 0) i = -i;
        else if (i >= L) i = 2 * L - 2 - i;
        return x[i];
      };
      for (let t = 0; t < dimT; t++) {
        const s0 = t * HOP - pad;
        for (let i = 0; i < nFft; i++) {
          re[i] = at(s0 + i) * w[i];
          im[i] = 0;
        }
        fft(re, im, false);
        const oR = (2 * c) * dimF * dimT;
        const oI = (2 * c + 1) * dimF * dimT;
        for (let f = 0; f < dimF; f++) {
          out[oR + f * dimT + t] = re[f];
          out[oI + f * dimT + t] = im[f];
        }
      }
    }
    return out;
  }

  /** Inverse of stft: spec [4, dimF, dimT] -> [L, R] of hop*(dimT-1) samples. */
  function istft(spec, m) {
    const { nFft, dimF, dimT } = m;
    const pad = nFft >> 1;
    const nBins = (nFft >> 1) + 1;
    const w = hann(nFft);
    const len = HOP * (dimT - 1);
    const full = len + 2 * pad;
    const re = new Float64Array(nFft);
    const im = new Float64Array(nFft);
    // window envelope (the same for both channels)
    const env = new Float64Array(full);
    for (let t = 0; t < dimT; t++) for (let i = 0; i < nFft; i++) env[t * HOP + i] += w[i] * w[i];
    const out = [];
    for (let c = 0; c < 2; c++) {
      const y = new Float64Array(full);
      const oR = (2 * c) * dimF * dimT;
      const oI = (2 * c + 1) * dimF * dimT;
      for (let t = 0; t < dimT; t++) {
        re.fill(0);
        im.fill(0);
        for (let f = 0; f < dimF; f++) {
          re[f] = spec[oR + f * dimT + t];
          im[f] = spec[oI + f * dimT + t];
        }
        // rows dimF..nBins-1 are zero; the upper half mirrors (real signal)
        for (let f = 1; f < nBins - 1; f++) {
          re[nFft - f] = re[f];
          im[nFft - f] = -im[f];
        }
        fft(re, im, true);
        const s0 = t * HOP;
        for (let i = 0; i < nFft; i++) y[s0 + i] += (re[i] / nFft) * w[i];
      }
      const ch = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const e = env[i + pad];
        ch[i] = e > 1e-11 ? y[i + pad] / e : 0;
      }
      out.push(ch);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Separation: chunk the song, run the model on each chunk, join.
  // ---------------------------------------------------------------------------
  /**
   * mix: [L, R] Float32Arrays at 44.1 kHz. run(spec) -> Promise<spec> runs the
   * model on one [1, 4, dimF, dimT] input. onProgress(0..1) optional.
   * Returns [L, R] of the stem, same length as the mix.
   */
  async function separate(mix, m, run, onProgress) {
    const n = mix[0].length;
    const chunkSize = HOP * (m.dimT - 1);
    const trim = m.nFft >> 1;
    const gen = chunkSize - 2 * trim;
    const padN = gen - (n % gen);
    const total = trim + n + padN + trim;
    const padded = [new Float32Array(total), new Float32Array(total)];
    padded[0].set(mix[0], trim);
    padded[1].set(mix[1], trim);
    const out = [new Float32Array(n + padN), new Float32Array(n + padN)];
    const steps = Math.ceil((n + padN) / gen);
    let k = 0;
    for (let i = 0; i < n + padN; i += gen, k++) {
      const chunk = [padded[0].subarray(i, i + chunkSize), padded[1].subarray(i, i + chunkSize)];
      const spec = stft(chunk, m);
      const res = await run(spec);
      const wave = istft(res, m);
      for (let c = 0; c < 2; c++) out[c].set(wave[c].subarray(trim, chunkSize - trim), i);
      if (onProgress) onProgress((k + 1) / steps);
    }
    return [out[0].subarray(0, n), out[1].subarray(0, n)];
  }

  /**
   * Sample-rate conversion with a windowed sinc (32 taps, Kaiser-like
   * Blackman window), good enough that 48 kHz -> 44.1 kHz -> 48 kHz is
   * transparent. outLen: the exact length wanted (default: scaled).
   */
  function resample(x, from, to, outLen) {
    if (from === to) return outLen == null || outLen === x.length ? x : Float32Array.from(x.subarray(0, outLen));
    const ratio = from / to; // input samples per output sample
    const n = outLen == null ? Math.round((x.length * to) / from) : outLen;
    const out = new Float32Array(n);
    const TAPS = 16; // each side
    const cutoff = Math.min(1, to / from) * 0.95; // relative to the input's Nyquist
    for (let i = 0; i < n; i++) {
      const c = i * ratio;
      const k0 = Math.floor(c);
      let acc = 0;
      let wsum = 0;
      for (let k = k0 - TAPS + 1; k <= k0 + TAPS; k++) {
        const d = k - c; // distance in input samples
        if (Math.abs(d) >= TAPS) continue;
        const win = 0.42 + 0.5 * Math.cos((Math.PI * d) / TAPS) + 0.08 * Math.cos((2 * Math.PI * d) / TAPS);
        const z = Math.PI * d * cutoff;
        const sinc = Math.abs(z) < 1e-9 ? 1 : Math.sin(z) / z;
        const w = win * sinc * cutoff;
        wsum += w;
        const xi = k < 0 ? 0 : k >= x.length ? 0 : x[k];
        acc += xi * w;
      }
      out[i] = wsum > 1e-9 ? acc / wsum : 0;
    }
    return out;
  }

  /** Signal-to-distortion ratio in dB of est against the true stem ref. */
  function sdr(ref, est) {
    let s = 0;
    let e = 0;
    for (let c = 0; c < ref.length; c++) {
      for (let i = 0; i < ref[c].length; i++) {
        s += ref[c][i] * ref[c][i];
        const d = ref[c][i] - est[c][i];
        e += d * d;
      }
    }
    return 10 * Math.log10((s + 1e-9) / (e + 1e-9));
  }

  const api = { HOP, MODELS, SAMPLE_RATE, STEMS, fft, stft, istft, separate, resample, sdr };
  root.YTLStems = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
