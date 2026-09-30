'use strict';
// Draws the tray logo with no image files: a round badge (green = working,
// yellow = stopped) with a voice-wave glyph (working) or pause bars (stopped).
const zlib = require('zlib');

const GREEN = [34, 197, 94];
const YELLOW = [250, 204, 21];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Coverage of shapes in a unit square (0..1), sampled 4x4 per pixel for smooth edges.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inCapsule(x, y, x0, y0, x1, y1, r) {
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= r;
}

// state: 'on' (green wave) | 'off' (yellow pause) | 'sent' (green check, flashed after a send).
// Returns a PNG Buffer of size `size` x `size`.
function renderIcon(state, size) {
  const color = state === 'off' ? YELLOW : GREEN;
  const glyph = state === 'off' ? [70, 50, 0] : [255, 255, 255];
  const bars =
    state === 'off'
      ? [[0.34, 0.27, 0.46, 0.73], [0.54, 0.27, 0.66, 0.73]] // pause
      : state === 'sent'
      ? [] // check mark is drawn as capsules below
      : [ // voice-wave: [center x, half height]
          [0.30, 0.10], [0.40, 0.20], [0.50, 0.28], [0.60, 0.18], [0.70, 0.09],
        ].map(([cx, hh]) => [cx - 0.035, 0.5 - hh, cx + 0.035, 0.5 + hh])
    ;
  const rgba = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          const d = Math.hypot(x - 0.5, y - 0.5);
          let c = null;
          if (d <= 0.48) {
            c = d > 0.44 ? [0, 0, 0, 0.35] : null; // thin dark rim so yellow shows on light bars
            if (!c) {
              c = [...color, 1];
              for (const [x0, y0, x1, y1] of bars) {
                if (inRoundRect(x, y, x0, y0, x1, y1, 0.035)) c = [...glyph, 1];
              }
              if (state === 'sent' && (inCapsule(x, y, 0.28, 0.52, 0.44, 0.68, 0.055) || inCapsule(x, y, 0.44, 0.68, 0.73, 0.33, 0.055))) c = [...glyph, 1];
            }
          }
          if (c) {
            const w = c[3];
            r += c[0] * w; g += c[1] * w; b += c[2] * w; a += w;
          }
        }
      }
      const n = S * S;
      const o = (py * size + px) * 4;
      if (a > 0) {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
        rgba[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return encodePng(rgba, size, size);
}

module.exports = { renderIcon, encodePng, GREEN, YELLOW };
