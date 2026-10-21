// The real MDX-Net models on a synthesised band (voice, drums, bass, chords):
// each stem must come out far cleaner than the mix. Slow (a few minutes):
// run with  npm run test:stems  (needs test/fixtures/models/*.onnx).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/stems.js');
const { synth } = require('./music.js');

const DIR = path.join(__dirname, 'fixtures', 'models');
const have = ['vocals', 'drums', 'bass'].every((k) => fs.existsSync(path.join(DIR, S.MODELS[k].file)));

test('MDX-Net stems: vocals, drums and bass each far cleaner than the mix', { skip: !have && 'no models in test/fixtures/models' }, async () => {
  const ort = require('onnxruntime-web');
  ort.env.wasm.numThreads = 4;
  const SR = 44100;
  const dur = 14;
  const beat = 0.5;
  const nBeats = Math.floor((dur - 1) / beat);
  const parts = {
    vocals: (S_) => { for (let i = 0; i < nBeats; i += 4) { const t = 0.5 + i * beat; S_.sing(t, beat * 1.6, [262, 294, 330, 392][(i / 4) % 4], 1, ['ah', 'oh', 'ee', 'ah'][(i / 4) % 4]); S_.sing(t + beat * 2, beat * 1.2, [330, 349, 392, 440][(i / 4) % 4], 0.9, ['oh', 'ah', 'ah', 'ee'][(i / 4) % 4]); } },
    drums: (S_) => { for (let i = 0; i < nBeats; i++) { const t = 0.5 + i * beat; if (i % 2 === 0) S_.kick(t); else S_.snare(t); S_.hat(t, 0.7); S_.hat(t + beat / 2, 0.5); } },
    bass: (S_) => { for (let i = 0; i < nBeats; i++) { const t = 0.5 + i * beat; S_.bass(t, beat * 0.9, [55, 55, 65, 49][Math.floor(i / 4) % 4], 0.9); } },
    other: (S_) => { for (let i = 0; i < nBeats; i += 2) { const t = 0.5 + i * beat; S_.chord(t, beat * 2, [[262, 330, 392], [262, 349, 440], [294, 392, 494], [247, 330, 392]][Math.floor(i / 4) % 4], 0.9); } },
  };
  const stems = {};
  for (const k of Object.keys(parts)) stems[k] = synth({ dur, seed: 5, make(S_) { parts[k](S_); return []; } }, SR).x;
  const n = stems.vocals.length;
  const mix = new Float32Array(n);
  for (const k of Object.keys(stems)) for (let i = 0; i < n; i++) mix[i] += stems[k][i] * 0.3;
  for (const k of Object.keys(stems)) for (let i = 0; i < n; i++) stems[k][i] *= 0.3;
  const want = { vocals: 9, drums: 6, bass: 9 };
  for (const k of Object.keys(want)) {
    const m = S.MODELS[k];
    const sess = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(path.join(DIR, m.file))), { executionProviders: ['wasm'] });
    const est = await S.separate([mix, mix], m, async (spec) => (await sess.run({ input: new ort.Tensor('float32', spec, [1, 4, m.dimF, m.dimT]) })).output.data);
    const ref = [stems[k], stems[k]];
    const got = S.sdr(ref, est);
    const base = S.sdr(ref, [mix, mix]);
    assert.ok(got > want[k] && got > base + 8, `${k}: ${got.toFixed(1)} dB (mix alone: ${base.toFixed(1)} dB)`);
  }
});
