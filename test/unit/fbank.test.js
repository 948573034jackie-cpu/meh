'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractFeatures, filterbank, MELS } = require('../../src/voice/fbank');
const FIX = path.join(__dirname, '..', 'fixtures', 'voice');

function readWav16(file) {
  const b = fs.readFileSync(file);
  const n = (b.length - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(44 + i * 2) / 32768;
  return out;
}

test('features match the reference implementation (Python/numpy) sample by sample', () => {
  const ref = JSON.parse(fs.readFileSync(path.join(FIX, 'ref-features.json'), 'utf8'));
  for (const [file, r] of Object.entries(ref)) {
    const { data, frames } = extractFeatures(readWav16(path.join(FIX, file)));
    assert.equal(frames, r.frames, `${file} frame count`);
    // reference is stored as band x frame; both are band-major
    let worst = 0;
    for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(data[i] - r.features[i]));
    assert.ok(worst < 2e-3, `${file}: largest difference ${worst}`);
  }
});

test('features are normalised per band (mean 0, std 1) and finite', () => {
  const { data, frames } = extractFeatures(readWav16(path.join(FIX, 'spk10_s1.wav')));
  for (let m = 0; m < MELS; m += 13) {
    let mean = 0, v = 0;
    for (let t = 0; t < frames; t++) mean += data[m * frames + t];
    mean /= frames;
    for (let t = 0; t < frames; t++) v += (data[m * frames + t] - mean) ** 2;
    assert.ok(Math.abs(mean) < 1e-3);
    assert.ok(Math.abs(Math.sqrt(v / (frames - 1)) - 1) < 1e-3);
  }
  assert.ok(data.every(Number.isFinite));
});

test('80 mel bands cover 0-7600 Hz; filters are non-negative', () => {
  const fb = filterbank();
  assert.equal(fb.length, 80);
  assert.ok(fb.every((r) => r.every((v) => v >= 0)));
  assert.ok(fb[79][Math.round((7600 / 8000) * 256) - 1] > 0);
  assert.equal(fb[79][256], 0); // nothing above 7600 Hz
});

test('silence and very short audio are handled', () => {
  assert.throws(() => extractFeatures(new Float32Array(100)), /too short/);
  const { data } = extractFeatures(new Float32Array(16000));
  assert.ok(data.every(Number.isFinite));
});
