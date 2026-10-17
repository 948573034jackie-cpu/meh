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
    if (res) P.add(res.startBin, res.peak, res.low, res.mid, res.high, res.att, res.atv, res);
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

test('drum chart: kick, snare, toms, hi-hats, crash and cowbell of a whole kit, each in its own row', () => {
  const spec = songs.drumKit;
  const s = synth(spec);
  const P = toStore(s.x, s.dur);
  const g = C.beatGrid(P, s.dur);
  const hits = C.drumHits(P, s.dur, g && g.beats);
  const near = (list, t) => list.some((x) => Math.abs(x - t) < 0.03);
  const score = (kind, truthKinds = [kind]) => {
    const truth = spec.hits.filter((h) => truthKinds.includes(h.kind)).map((h) => h.t);
    const got = hits.filter((h) => h.kind === kind).map((h) => h.t);
    return { n: truth.length, found: truth.filter((t) => near(got, t)).length, wrong: got.filter((t) => !near(truth, t)).length };
  };
  const k = score('kick');
  assert.ok(k.found >= k.n - 1 && k.wrong <= 1, `kicks ${JSON.stringify(k)}`);
  const sn = score('snare');
  assert.ok(sn.found >= sn.n - 2 && sn.wrong <= 3, `snares ${JSON.stringify(sn)}`);
  const t = score('tom');
  assert.ok(t.found === t.n && t.wrong <= 1, `toms ${JSON.stringify(t)}`);
  const c = score('cym');
  assert.ok(c.found === c.n && c.wrong <= 1, `crashes ${JSON.stringify(c)}`);
  const p = score('perc');
  assert.ok(p.found >= p.n * 0.7 && p.wrong <= 2, `cowbell ${JSON.stringify(p)}`);
  // hi-hats (and the ride) that are not hidden under a snare or a crash
  const busy = spec.hits.filter((h) => h.kind === 'snare' || h.kind === 'cym').map((h) => h.t);
  const hatT = spec.hits.filter((h) => h.kind === 'hat' && !near(busy, h.t)).map((h) => h.t);
  const gotH = hits.filter((h) => h.kind === 'hat').map((h) => h.t);
  const foundH = hatT.filter((x) => near(gotH, x)).length;
  assert.ok(foundH >= hatT.length * 0.75, `hi-hats ${foundH} of ${hatT.length}`);
});

test('drum chart: house claps on 2 and 4 are snares, the open hi-hat on every off-beat is a hi-hat', () => {
  const s = synth(songs.house124);
  const P = toStore(s.x, s.dur);
  const g = C.beatGrid(P, s.dur);
  const hits = C.drumHits(P, s.dur, g.beats);
  const sn = hits.filter((h) => h.kind === 'snare');
  const claps = s.beats.filter((_, i) => i % 2);
  assert.ok(Math.abs(sn.length - claps.length) <= 6, `${sn.length} snares for ${claps.length} claps`);
  const onClap = sn.filter((h) => claps.some((t) => Math.abs(t - h.t) < 0.03)).length;
  assert.ok(onClap >= sn.length - 3, `snares are on the claps (${onClap} of ${sn.length})`);
  assert.ok(hits.filter((h) => h.kind === 'kick').length >= s.beats.length - 3, 'four on the floor');
});

test('drum chart: piano chords and a voice are not toms', () => {
  for (const name of ['balladPiano70', 'vocalPop96']) {
    const s = synth(songs[name]);
    const P = toStore(s.x, s.dur);
    const hits = C.drumHits(P, s.dur, (C.beatGrid(P, s.dur) || {}).beats);
    assert.ok(hits.filter((h) => h.kind === 'tom').length <= 2, `${name}: toms ${hits.filter((h) => h.kind === 'tom').length}`);
  }
});
