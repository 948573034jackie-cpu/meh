'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { renderIcon, GREEN, YELLOW } = require('../../src/icons');

function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let off = 8, w, h; const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = (x, y) => { const o = y * (w * 4 + 1) + 1 + x * 4; return [...raw.subarray(o, o + 4)]; };
  return { w, h, px };
}

test('valid PNG of the requested size', () => {
  for (const size of [44, 256, 1024]) {
    const d = decode(renderIcon('on', size));
    assert.equal(d.w, size); assert.equal(d.h, size);
  }
});

test('working = green badge, stopped = yellow badge', () => {
  const on = decode(renderIcon('on', 128)), off = decode(renderIcon('off', 128));
  // sample a badge pixel away from the glyph (upper-left inside the circle)
  assert.deepEqual(on.px(30, 64).slice(0, 3), GREEN);
  assert.deepEqual(off.px(30, 64).slice(0, 3), YELLOW);
  assert.equal(on.px(30, 64)[3], 255);
});

test('corners are transparent (round logo)', () => {
  assert.equal(decode(renderIcon('on', 64)).px(0, 0)[3], 0);
});

test('glyph differs between states (wave vs pause)', () => {
  const on = decode(renderIcon('on', 128)), off = decode(renderIcon('off', 128));
  assert.deepEqual(on.px(64, 64).slice(0, 3), [255, 255, 255]); // centre wave bar, white
  assert.notDeepEqual(off.px(64, 64).slice(0, 3), [255, 255, 255]);
});
