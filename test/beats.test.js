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

function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

function synth(spec) {
  const { dur, seed = 3 } = spec;
  const N = Math.ceil(dur * SR);
  const x = new Float32Array(N);
  const r = rng(seed);
  const noise = () => r() * 2 - 1;
  const at = (t, len, fn) => { const s = Math.round(t * SR); for (let i = Math.max(0, s); i < Math.min(N, s + len * SR); i++) x[i] += fn((i - s) / SR); };
  const S = {
    kick: (t, a = 1) => { let ph = 0; at(t, 0.4, (u) => { ph += 2 * Math.PI * (48 + 90 * Math.exp(-u / 0.025)) / SR; return a * 0.9 * Math.sin(ph) * Math.exp(-u / 0.16) + (u < 0.003 ? a * 0.3 * noise() : 0); }); },
    snare: (t, a = 1) => { let lp = 0; at(t, 0.3, (u) => { const nz = noise(); lp = lp * 0.3 + nz * 0.7; return a * (0.45 * (nz - lp * 0.5) * Math.exp(-u / 0.11) + 0.35 * Math.sin(2 * Math.PI * 190 * u) * Math.exp(-u / 0.06)); }); },
    clap: (t, a = 1) => at(t, 0.25, (u) => a * 0.5 * noise() * (u < 0.03 ? (Math.floor(u / 0.01) % 2 ? 0.6 : 1) : Math.exp(-(u - 0.03) / 0.08))),
    hat: (t, a = 1) => { let p = 0; at(t, 0.08, (u) => { const nz = noise(); const hp = nz - p; p = nz; return a * 0.18 * hp * Math.exp(-u / 0.025); }); },
    ohat: (t, a = 1) => { let p = 0; at(t, 0.35, (u) => { const nz = noise(); const hp = nz - p; p = nz; return a * 0.22 * hp * Math.exp(-u / 0.14); }); },
    bass: (t, len, f, a = 1) => at(t, len, (u) => a * 0.45 * Math.sin(2 * Math.PI * f * u) * Math.min(1, u / 0.012) * Math.min(1, (len - u) / 0.02)),
    chord: (t, len, fs_, a = 1) => at(t, len, (u) => a * 0.12 * fs_.reduce((s, f) => s + Math.sin(2 * Math.PI * f * u) + 0.3 * Math.sin(4 * Math.PI * f * u), 0) * Math.min(1, u / 0.01) * Math.exp(-u / 0.8)),
    pad: (t, len, fs_, a = 1) => at(t, len, (u) => a * 0.06 * fs_.reduce((s, f) => s + Math.sin(2 * Math.PI * f * u), 0) * Math.min(1, u / 0.3) * Math.min(1, (len - u) / 0.3)),
    voice: (t, len, f, a = 1) => { let ph = 0; at(t, len, (u) => { ph += 2 * Math.PI * f * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * u)) / SR; return a * 0.25 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) * Math.min(1, u / 0.04) * Math.min(1, (len - u) / 0.05); }); },
  };
  const beats = spec.make(S, r); // truth beat times (drum region), downbeats = every 4th starting at index spec.firstDown||0
  for (let i = 0; i < N; i++) x[i] += 0.003 * noise();
  return { x, beats, dur };
}

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

// --- songs -----------------------------------------------------------------
const grid = (bpm, t0, n, swing = 0, hum = 0, r) => { const out = []; let t = t0; for (let i = 0; i < n; i++) { out.push(t + (hum && r ? (r() - 0.5) * 2 * hum : 0)); t += 60 / (typeof bpm === 'function' ? bpm(i) : bpm); } return out; };
const songs = {
  pop120: { dur: 60, make(S) { const B = grid(120, 1.2345, 112); B.forEach((t, i) => { const p = 60 / 120; if (i % 2 === 0) S.kick(t); else S.snare(t); S.hat(t, 0.8); S.hat(t + p / 2, 0.6); if (i % 4 === 0) S.chord(t, 2, [262, 330, 392]); S.bass(t, p * 0.9, i % 8 < 4 ? 55 : 65); }); return B; } },
  house124: { dur: 60, make(S) { const p = 60 / 124; const B = grid(124, 0.517, 118); B.forEach((t, i) => { S.kick(t); if (i % 2) S.clap(t, 0.8); S.ohat(t + p / 2, 1.3); S.hat(t + p / 4, 0.4); S.hat(t + 3 * p / 4, 0.4); S.bass(t + p / 2, p * 0.45, 55, 1.1); }); return B; } },
  hiphop90: { dur: 60, make(S, r) { const p = 60 / 90; const sw = 0.62; const B = grid(90, 0.9, 84); B.forEach((t, i) => { const pos = i % 4; if (pos === 0) { S.kick(t); S.kick(t + p * 0.75, 0.8); } if (pos === 1 || pos === 3) S.snare(t); if (pos === 2) { S.kick(t + p * 0.5); } S.hat(t, 0.7); S.hat(t + p * sw, 0.5); if (pos === 0) S.chord(t + p * 0.5, 1.5, [220, 277, 330], 1.2); if (pos === 2) S.bass(t + p * 0.25, p * 0.7, 49, 1); }); return B; } },
  trap140half: { dur: 50, make(S) { const p = 60 / 140; const B = grid(140, 1.05, 112); B.forEach((t, i) => { const pos = i % 8; if (pos === 0 || pos === 3.5) S.kick(t); if (pos === 3 && i % 16 >= 8) S.kick(t + p / 2); if (pos === 4) S.snare(t, 1.2); for (let k = 0; k < (i % 8 === 7 ? 4 : 2); k++) S.hat(t + k * p / (i % 8 === 7 ? 4 : 2), 0.6); if (pos === 0) S.bass(t, p * 3, 41, 1.2); }); return B; } },
  introBreak100: { dur: 70, make(S) { const p = 0.6; S.pad(0.3, 9.6, [220, 262, 330]); for (let k = 0; k < 4; k++) S.chord(0.3 + k * 2.4 + 0.9, 1, [262, 330, 392], 0.8); const B = grid(100, 0.3, 112); B.forEach((t, i) => { if (t < 9.85) return; if (t > 38.25 && t < 47.85) { if (i % 4 === 0) S.pad(t, 2.4, [196, 247, 294]); return; } if (i % 2 === 0) S.kick(t); else S.snare(t); S.hat(t + p / 2, 0.6); }); return B.filter((t) => t >= 9.85); } },
  liveDrift: { dur: 70, make(S, r) { const B = grid((i) => 88 + i * 0.05, 1.4, 105, 0, 0.008, r); B.forEach((t, i) => { if (i % 2 === 0) S.kick(t, 0.8 + 0.3 * r()); else S.snare(t, 0.8 + 0.3 * r()); S.hat(t, 0.6); S.hat(t + 0.33, 0.4); }); return B; } },
  balladPiano70: { dur: 60, make(S) { const p = 60 / 70; const B = grid(70, 1.7, 66); B.forEach((t, i) => { S.chord(t, p, [262, 330, 392], 1.3); if (i % 4 === 0) S.bass(t, p * 2, 65); if (i % 2 === 1) S.snare(t, 0.4); if (i % 4 === 0) S.kick(t, 0.5); S.voice(t + p * 0.5, p * 1.2, 330, 0.7); }); return B; } },
  dnb174: { dur: 45, make(S) { const p = 60 / 174; const B = grid(174, 0.6, 128); B.forEach((t, i) => { const pos = i % 8; if (pos === 0 || pos === 5) S.kick(t); if (pos === 2.5) S.kick(t); if (pos === 2 || pos === 6) S.snare(t, 1.1); S.hat(t, 0.6); S.hat(t + p / 2, 0.5); if (pos === 0) S.bass(t, p * 4, 44, 1); }); return B; } },
  vocalPop96: { dur: 60, make(S) { const p = 0.625; const B = grid(96, 0.8, 94); B.forEach((t, i) => { if (i % 2 === 0) S.kick(t); else S.snare(t); S.hat(t + p / 2, 0.5); if (i % 4 === 3) S.voice(t + p * 0.5, p * 2.5, 294, 1.2); }); return B; } },
};


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
