// Stem separation maths (src/stems.js): the FFT / STFT like torch's, the
// sample-rate conversion, and the chunking of a song. The models themselves
// are checked by test/stems-model.test.js (slow; needs the model files).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/stems.js');

test('FFT: a 3·2^k size (6144, the vocals model) matches the definition; inverse gives the input back', () => {
  for (const n of [8, 6144]) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let seed = 3;
    const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
      re[i] = r() - 0.5;
      im[i] = r() - 0.5;
    }
    const x = { re: Float64Array.from(re), im: Float64Array.from(im) };
    S.fft(re, im, false);
    // a few bins by the definition
    for (const k of [0, 1, 7, n >> 1, n - 1]) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += x.re[t] * Math.cos(a) - x.im[t] * Math.sin(a);
        si += x.re[t] * Math.sin(a) + x.im[t] * Math.cos(a);
      }
      assert.ok(Math.abs(sr - re[k]) < 1e-6 && Math.abs(si - im[k]) < 1e-6, `n=${n} bin ${k}`);
    }
    S.fft(re, im, true);
    for (let i = 0; i < n; i += 97) assert.ok(Math.abs(re[i] / n - x.re[i]) < 1e-9, 'inverse');
  }
});

test('STFT -> iSTFT gives the sound back (below the rows the model keeps)', () => {
  for (const name of ['vocals', 'bass']) {
    const m = S.MODELS[name];
    const L = S.HOP * (m.dimT - 1);
    const x = [new Float32Array(L), new Float32Array(L)];
    for (let i = 0; i < L; i++) {
      x[0][i] = 0.5 * Math.sin(i * 0.05) + 0.2 * Math.sin(i * 0.013);
      x[1][i] = 0.4 * Math.cos(i * 0.02);
    }
    const y = S.istft(S.stft(x, m), m);
    assert.equal(y[0].length, L);
    assert.ok(S.sdr(x, y) > 80, `${name}: ${S.sdr(x, y).toFixed(1)} dB`);
  }
});

test('separate(): a song longer than one chunk comes back whole, in order, the same length', async () => {
  const m = S.MODELS.drums;
  const n = Math.round(44100 * 20.5);
  const x = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    x[0][i] = 0.5 * Math.sin(i * 0.03) * (1 + 0.5 * Math.sin(i * 0.0001));
    x[1][i] = 0.3 * Math.sin(i * 0.07);
  }
  let runs = 0;
  const y = await S.separate(x, m, async (spec) => {
    runs++;
    return spec; // the "model" hands the sound straight back
  });
  assert.equal(runs, 2);
  assert.equal(y[0].length, n);
  assert.ok(S.sdr(x, y) > 60, `whole and in order: ${S.sdr(x, y).toFixed(1)} dB`);
});

test('resample 48 kHz -> 44.1 kHz -> 48 kHz is transparent', () => {
  const n = 48000;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000) + 0.3 * Math.sin((2 * Math.PI * 7000 * i) / 48000);
  const y = S.resample(x, 48000, 44100);
  assert.equal(y.length, 44100);
  const z = S.resample(y, 44100, 48000, n);
  assert.equal(z.length, n);
  let num = 0;
  let den = 0;
  for (let i = 2000; i < n - 2000; i++) {
    den += x[i] * x[i];
    num += (x[i] - z[i]) ** 2;
  }
  assert.ok(10 * Math.log10(den / num) > 80);
});
