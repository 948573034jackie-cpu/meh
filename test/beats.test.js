// Beat grid on real-sounding music: drums, bass, chords and singing are
// synthesised as audio, read into the waveform bands exactly like on YouTube
// (inject.js computePeaks), and every beat the grid finds is checked against
// where the drummer really played. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const C = require('../src/core.js');
const ctx = { __YTL_TEST__: { parsersOnly: true }, Uint8Array, Float32Array, ArrayBuffer, Math, String, Number, Set, Promise, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'inject.js'), 'utf8'), ctx);
const PP = ctx.__YTL_TEST__.parsers;
const SR = 16000;
const { synth, songs } = require('./music.js');

function toStore(x, dur, chunkSec = 10) {
  const P = new C.PeakStore(50);
  for (let s = 0; s < x.length; s += chunkSec * SR) {
    const ch = x.subarray(s, Math.min(x.length, s + chunkSec * SR));
    const res = PP.computePeaks([ch], SR, s / SR);
    if (res) P.add(res.startBin, res.peak, res.low, res.mid, res.high, res.att, res.atv);
  }
  P.setDuration(dur);
  return P;
}

function check(name, { maxErr, bpm, down = true, steady }) {
  const s = synth(songs[name]);
  const g = C.beatGrid(toStore(s.x, s.dur), s.dur);
  assert.ok(g, `${name}: a grid`);
  const T = s.beats.filter((t) => t < s.dur - 0.1);
  if (bpm) assert.ok(bpm.some((b) => Math.abs(g.bpm - b) < 0.05), `${name}: ${g.bpm} BPM`);
  if (steady != null) assert.equal(g.steady, steady, `${name}: steady`);
  // Every beat the drummer played has a grid line on it.
  const half = g.bpm < (60 / ((T[T.length - 1] - T[0]) / (T.length - 1))) * 0.75;
  T.forEach((t, i) => {
    if (half && i % 2) return;
    const k = C.nearestBeatIndex(g.beats, t);
    const e = Math.abs(g.beats[k] - t) * 1000;
    assert.ok(e < maxErr, `${name}: beat ${i} at ${t.toFixed(3)} is ${e.toFixed(1)} ms off`);
  });
  if (down) {
    const k0 = C.nearestBeatIndex(g.beats, T[0]);
    assert.equal((((k0 - g.first) % 4) + 4) % 4, 0, `${name}: the "1" is right`);
  }
}

test('beat grid on music: steady songs land within 2 ms of every beat, the "1" right', () => {
  check('pop120', { maxErr: 2, bpm: [120], steady: true });
  check('house124', { maxErr: 2, bpm: [124], steady: true });
  check('hiphop90', { maxErr: 2, bpm: [90], steady: true });
  check('vocalPop96', { maxErr: 2, bpm: [96], steady: true });
  check('dnb174', { maxErr: 2, bpm: [174], down: false });
});

test('beat grid on music: intro and breakdown without drums, a piano ballad', () => {
  check('introBreak100', { maxErr: 2, bpm: [100] });
  check('balladPiano70', { maxErr: 10, bpm: [70] });
});

test('beat grid on music: half-time trap gets a straight tempo (70 or 140, not 93)', () => {
  check('trap140half', { maxErr: 2, bpm: [70, 140], down: false });
});

test('beat grid on music: a live drummer speeding up 88 -> 93 BPM is followed', () => {
  check('liveDrift', { maxErr: 15, steady: false });
});

test('attack data survives saving the waveform (and old saves still load)', () => {
  const s = synth(songs.pop120);
  const P = toStore(s.x, s.dur);
  const back = C.PeakStore.deserialize(JSON.parse(JSON.stringify(P.serialize())));
  assert.deepEqual(Array.from(back.att.subarray(0, P.n)), Array.from(P.att.subarray(0, P.n)));
  const old = P.serialize();
  const raw = Buffer.from(old.data, 'base64');
  const five = C.PeakStore.deserialize({ binRate: 50, n: old.n, data: raw.subarray(0, old.n * 5).toString('base64') });
  assert.equal(five.n, P.n);
  assert.ok(C.beatGrid(five, s.dur), 'grid without attack data too');
});

test('beat grid follows the tempo: a jump 90 -> 120, speeding up 100 -> 130, slowing down at the end, a new tempo after a break', () => {
  check('tempoJump', { maxErr: 2, steady: false });
  check('accel', { maxErr: 3, steady: false });
  check('ritard', { maxErr: 3, steady: false });
  check('breakNewTempo', { maxErr: 2, steady: false });
  // a half-time bridge is not a tempo change
  check('halfBridge', { maxErr: 2, bpm: [100], steady: true });
  const s = synth(songs.tempoJump);
  const g = C.beatGrid(toStore(s.x, s.dur), s.dur);
  assert.deepEqual(g.segments.map((x) => Math.round(x.bpm)), [90, 120], 'two tempos, marked where they start');
  assert.ok(Math.abs(g.segments[1].t - 32.9) < 0.01, `the new tempo starts on its first beat (${g.segments[1].t})`);
});
