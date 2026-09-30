'use strict';
// Builds the fake-microphone recording for the "only my voice" test (48 kHz, mono):
//   8 s room noise | the user reads 6 sentences (voice enrollment) | then, 4.5 s apart:
//   other person, USER, "Claude through the speaker", USER, other person, "Claude", USER, other person
const fs = require('fs');
const path = require('path');
const FIX = path.join(__dirname, '..', 'fixtures', 'voice-e2e');
const OUT_RATE = 48000;

function readWav(file) { // 16-bit PCM, any header layout
  const b = fs.readFileSync(file);
  let p = 12, data = null, rate = 16000;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), len = b.readUInt32LE(p + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(p + 12);
    if (id === 'data') { data = b.subarray(p + 8, p + 8 + len); break; }
    p += 8 + len + (len & 1);
  }
  const n = data.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return { samples: out, rate };
}
const up = (x, from) => { // linear resample to 48 kHz
  const k = OUT_RATE / from, n = Math.floor(x.length * k), o = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / k, i0 = Math.floor(t), f = t - i0; o[i] = x[i0] * (1 - f) + (x[Math.min(i0 + 1, x.length - 1)] || 0) * f; }
  return o;
};
let seed = 99;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

// Someone's voice coming out of a laptop speaker and across the room into the mic:
// band-limited, room echo, some noise, and quieter than a person speaking into the mic.
function throughSpeaker(x, level) {
  const ir = new Float32Array(Math.round(0.35 * OUT_RATE / 4)); // 0.35 s echo tail at 12 kHz-equivalent density
  const step = 4;
  for (let i = 1; i < ir.length; i++) ir[i] = rnd() * Math.exp(-6.9 * i / ir.length) * 0.15;
  ir[0] = 1;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { let s = 0; for (let k = 0; k < ir.length; k++) { const j = i - k * step; if (j < 0) break; s += ir[k] * x[j]; } y[i] = s; }
  let lp = 0; const a = Math.exp(-2 * Math.PI * 4000 / OUT_RATE), b = Math.exp(-2 * Math.PI * 250 / OUT_RATE);
  let hp = 0, prev = 0; const z = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) { lp = (1 - a) * y[i] + a * lp; hp = b * (hp + lp - prev); prev = lp; z[i] = hp; }
  const g = level / (rms(z) || 1);
  return z.map((v) => v * g + 0.0015 * rnd());
}

module.exports = function build(outFile, { userLevel = 0.11 } = {}) {
  const load = (n) => { const w = readWav(path.join(FIX, n + '.wav')); const x = up(w.samples, w.rate); const g = userLevel / (rms(x) || 1); return x.map((v) => v * g); };
  const parts = [];
  const timeline = [];
  let t = 0;
  const add = (x, label) => { if (label) timeline.push({ label, start: t / OUT_RATE, end: (t + x.length) / OUT_RATE }); parts.push(x); t += x.length; };
  const quiet = (sec) => add(Float32Array.from({ length: Math.round(sec * OUT_RATE) }, (_, i) => 0.0018 * Math.sin(2 * Math.PI * 60 * i / OUT_RATE) + 0.0008 * rnd()));
  quiet(8);
  for (const n of ['user_enroll1', 'user_enroll2', 'user_enroll3', 'user_enroll4', 'user_enroll5', 'user_enroll6']) { add(load(n), 'enroll'); quiet(0.5); }
  quiet(3);
  const script = [['other1', 'other'], ['user_test1', 'user'], ['claude1', 'claude'], ['user_test2', 'user'], ['other2', 'other'], ['claude2', 'claude'], ['user_test3', 'user'], ['other3', 'other']];
  for (const [n, who] of script) {
    const x = who === 'claude' ? throughSpeaker(load(n), userLevel * 0.5) : load(n);
    add(x, who);
    quiet(4.5);
  }
  const all = new Float32Array(t);
  let k = 0;
  for (const p of parts) { all.set(p, k); k += p.length; }
  const pcm = Buffer.alloc(all.length * 2);
  for (let i = 0; i < all.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(all[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(OUT_RATE, 24); h.writeUInt32LE(OUT_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(outFile, Buffer.concat([h, pcm]));
  return timeline;
};
if (require.main === module) console.log(JSON.stringify(module.exports(process.argv[2] || '/tmp/voice-test.wav'), null, 1));
