// Real-sounding test music: drums (kick, snare, clap, hi-hats), bass,
// chords, pads and a singing voice, synthesised as audio, with the exact time
// of every beat the drummer played. Used by the beat tests and to build the
// tempo-change test video (tools/make-fixtures.js).

function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

function synth(spec, SR = 16000) {
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
    tom: (t, f = 120, a = 1) => { let ph = 0; at(t, 0.5, (u) => { ph += 2 * Math.PI * f * (1 + 0.25 * Math.exp(-u / 0.04)) / SR; return a * (0.7 * Math.sin(ph) * Math.exp(-u / 0.22) + (u < 0.004 ? 0.25 * noise() : 0)); }); },
    crash: (t, a = 1) => { let p = 0; at(t, 2.0, (u) => { const nz = noise(); const hp = nz - 0.6 * p; p = nz; return a * 0.32 * hp * (Math.exp(-u / 0.7) * 0.8 + (u < 0.02 ? 0.5 : 0)); }); },
    ride: (t, a = 1) => { let p = 0; at(t, 0.9, (u) => { const nz = noise(); const hp = nz - p; p = nz; return a * (0.12 * hp * Math.exp(-u / 0.45) + 0.08 * Math.sin(2 * Math.PI * 3300 * u) * Math.exp(-u / 0.35)); }); },
    cowbell: (t, a = 1) => at(t, 0.25, (u) => a * 0.22 * (Math.sign(Math.sin(2 * Math.PI * 540 * u)) + Math.sign(Math.sin(2 * Math.PI * 800 * u))) * Math.exp(-u / 0.07)),
    voice: (t, len, f, a = 1) => { let ph = 0; at(t, len, (u) => { ph += 2 * Math.PI * f * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * u)) / SR; return a * 0.25 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) * Math.min(1, u / 0.04) * Math.min(1, (len - u) / 0.05); }); },
  };
  const beats = spec.make(S, r); // truth beat times (drum region), downbeats = every 4th starting at index spec.firstDown||0
  for (let i = 0; i < N; i++) x[i] += 0.003 * noise();
  return { x, beats, dur };
}

const grid = (bpm, t0, n, swing = 0, hum = 0, r) => { const out = []; let t = t0; for (let i = 0; i < n; i++) { out.push(t + (hum && r ? (r() - 0.5) * 2 * hum : 0)); t += 60 / (typeof bpm === 'function' ? bpm(i) : bpm); } return out; };
// beat times from a list of [count, bpm or [bpmFrom, bpmTo]] parts
const tempoMap = (t0, parts) => { const out = []; let t = t0; for (const [n, bpm] of parts) for (let i = 0; i < n; i++) { out.push(t); const b = Array.isArray(bpm) ? bpm[0] + (bpm[1] - bpm[0]) * (i / n) : bpm; t += 60 / b; } return out; };
const popKit = (S, B, opts = {}) => B.forEach((t, i) => { const p = (B[i + 1] || t + 0.5) - t; if (opts.skip && opts.skip(t, i)) return; if (opts.half && opts.half(t, i)) { if (i % 4 === 0) S.kick(t); if (i % 4 === 2) S.snare(t); S.hat(t, 0.6); return; } if (i % 2 === 0) S.kick(t); else S.snare(t); S.hat(t, 0.7); S.hat(t + p / 2, 0.5); if (i % 4 === 0) S.chord(t, 4 * p, [262, 330, 392], 0.8); S.bass(t, p * 0.9, i % 8 < 4 ? 55 : 65, 0.8); });
// A full drum kit at 100 BPM over 24 bars, every hit written down:
// kick, snare, closed and open hi-hat, crash, ride, three toms (fills),
// cowbell; with a bass line and chords under it.
function drumKit(bars = 24, rideFrom = 8, rideTo = 16, bellFrom = 16, fillEvery = 8) {
  const hits = [];
  const add = (kind, t) => hits.push({ kind, t });
  const beat = 0.6;
  const t0 = 0.8;
  const play = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let s16 = 0; s16 < 16; s16++) {
      const t = t0 + (bar * 16 + s16) * (beat / 4);
      const fill = bar % fillEvery === fillEvery - 1 && s16 >= 8;
      const ride = bar >= rideFrom && bar < rideTo;
      if (s16 === 0 || s16 === 8 || (bar % 2 && s16 === 10)) if (!fill) { play.push(['kick', t]); add('kick', t); }
      if ((s16 === 4 || s16 === 12) && !fill) { play.push(['snare', t]); add('snare', t); }
      if (fill) {
        if (s16 % 2 === 0) {
          const f = [210, 210, 160, 160, 110, 110, 110, 110][s16 - 8];
          play.push(['tom', t, f]);
          add('tom', t);
        }
      } else if (s16 % 2 === 0) {
        if (ride) { play.push(['ride', t]); add('hat', t); } // a ride keeps time like a hi-hat: same row
        else if (s16 === 14 && bar % 2) { play.push(['ohat', t]); add('hat', t); }
        else { play.push(['hat', t]); add('hat', t); }
      }
      if (s16 === 0 && bar % 4 === 0) { play.push(['crash', t]); add('cym', t); }
      if (bar >= bellFrom && (s16 === 6 || s16 === 14)) { play.push(['cowbell', t]); add('perc', t); }
    }
  }
  return {
    dur: t0 + bars * 4 * beat + 2,
    hits,
    make(S) {
      for (const [k, t, f] of play) {
        if (k === 'tom') S.tom(t, f);
        else if (k === 'hat') S.hat(t, 0.8);
        else if (k === 'ohat') S.ohat(t, 1);
        else S[k](t);
      }
      for (let bar = 0; bar < bars; bar++) {
        const tb = t0 + bar * 4 * beat;
        S.bass(tb, beat * 1.8, bar % 2 ? 49 : 55, 0.7);
        S.bass(tb + beat * 2, beat * 1.8, bar % 2 ? 44 : 41, 0.7);
        S.chord(tb, 4 * beat, [262, 330, 392], 0.5);
      }
      const B = [];
      for (let i = 0; i < bars * 4; i++) B.push(t0 + i * beat);
      return B;
    },
  };
}

const songs = {
  drumKit: drumKit(),
  tempoJump: { dur: 62, make(S) { const B = tempoMap(0.9, [[48, 90], [64, 120]]); popKit(S, B); return B; } },
  accel: { dur: 66, make(S) { const B = tempoMap(1.1, [[120, [100, 130]]]); popKit(S, B); return B; } },
  ritard: { dur: 66, make(S) { const B = tempoMap(0.7, [[96, 110], [16, [110, 80]]]); popKit(S, B); return B; } },
  halfBridge: { dur: 66, make(S) { const B = tempoMap(1.3, [[108, 100]]); popKit(S, B, { half: (t, i) => i >= 64 && i < 96 }); return B; } },
  breakNewTempo: { dur: 70, make(S) { const A = tempoMap(0.5, [[64, 128]]); const t1 = A[A.length - 1] + 60 / 128; S.pad(t1, 8, [220, 277, 330]); const B2 = tempoMap(t1 + 8, [[64, 140]]); [...A, ...B2].forEach((t, i, all) => { const p = (all[i + 1] || t + 0.43) - t; S.kick(t); if (i % 2) S.clap(t, 0.8); S.ohat(t + Math.min(p, 0.5) / 2, 0.9); }); return [...A, ...B2]; } },

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

module.exports = { synth, songs, tempoMap, popKit, drumKit };
