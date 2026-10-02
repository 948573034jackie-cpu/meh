// Generates icons/icon{16,32,48,128}.png (no dependencies): a rounded dark
// square with a cyan-to-pink waveform and a loop bracket.
// Run: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, pixels) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const SS = 4; // supersampling
  const N = size * SS;
  const acc = new Float64Array(size * size * 4);
  const bars = [0.35, 0.6, 0.9, 0.7, 1.0, 0.55, 0.8, 0.45, 0.3];
  const r = 0.22; // corner radius
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      // rounded square mask
      const dx = Math.max(r - u, 0, u - (1 - r));
      const dy = Math.max(r - v, 0, v - (1 - r));
      if (dx * dx + dy * dy > r * r) continue;
      let col = [16, 20, 30, 255];
      // waveform bars
      const area = { x0: 0.14, x1: 0.86 };
      if (u > area.x0 && u < area.x1) {
        const f = (u - area.x0) / (area.x1 - area.x0);
        const i = Math.floor(f * bars.length);
        const inBar = (f * bars.length - i) < 0.62;
        const hgt = bars[i] * 0.3;
        if (inBar && Math.abs(v - 0.5) < hgt) {
          const t = f;
          col = [Math.round(25 + (255 - 25) * t), Math.round(211 - 120 * t), Math.round(255 - 140 * t), 255];
        }
      }
      // loop bracket (A/B lines)
      if ((Math.abs(u - 0.2) < 0.025 || Math.abs(u - 0.8) < 0.025) && v > 0.14 && v < 0.86) col = [255, 207, 61, 255];
      const o = (Math.floor(y / SS) * size + Math.floor(x / SS)) * 4;
      for (let k = 0; k < 4; k++) acc[o + k] += col[k];
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3] / (SS * SS);
    out[i * 4 + 3] = Math.round(a);
    for (let k = 0; k < 3; k++) out[i * 4 + k] = a > 0 ? Math.round(acc[i * 4 + k] / (acc[i * 4 + 3] / 255)) : 0;
  }
  return out;
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${s}.png`), png(s, draw(s)));
}
console.log('icons written');
