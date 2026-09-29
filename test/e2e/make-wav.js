'use strict';
// Builds a 9-second, 48kHz mono test "microphone" recording (loops forever):
//   0.0-1.0  room hum + hiss only
//   1.0      a 10ms loud click (like a keyboard/mouse pop)  -> must be ignored
//   2.0-4.0  speech, with a 0.4s pause inside (3.0-3.4)     -> ONE trigger at 2.0
//   6.5-7.5  a second sentence after a real silence         -> trigger at 6.5 (if interval allows)
const fs = require('fs');
const SR = 48000, LEN = 9;
const n = SR * LEN;
const buf = new Float32Array(n);
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const db = (d) => 10 ** (d / 20);

for (let i = 0; i < n; i++) {
  const t = i / SR;
  buf[i] = db(-52) * Math.sin(2 * Math.PI * 60 * t) + db(-62) * rnd(); // hum + hiss
}
function speech(t0, t1, pauseFrom = -1, pauseTo = -1) {
  for (let i = Math.floor(t0 * SR); i < Math.floor(t1 * SR); i++) {
    const t = i / SR;
    if (t >= pauseFrom && t < pauseTo) continue;
    const syll = 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 3.5 * t)); // syllable rhythm
    const edge = Math.min(1, (t - t0) / 0.02, (t1 - t) / 0.05); // fast on, short fade off
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * 140 * h * t) / (h ** 0.9);
    buf[i] += v * 0.12 * syll * edge; // ~ -22 dBFS RMS
  }
}
for (let i = 1.0 * SR; i < 1.01 * SR; i++) buf[i] += rnd() * 0.9; // click
speech(2.0, 4.0, 3.0, 3.4);
speech(6.5, 7.5);

const pcm = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf[i] * 32767))), i * 2);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
module.exports = (file) => fs.writeFileSync(file, Buffer.concat([h, pcm]));
if (require.main === module) module.exports(process.argv[2] || 'test.wav');
