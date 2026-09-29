'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { layoutDisplays, stitchBitmaps, screenGranted } = require('../../src/layout');

const d = (id, x, y, width, height, scaleFactor = 1) => ({ id, bounds: { x, y, width, height }, scaleFactor });

test('one monitor keeps its size (and shrinks big Retina to 1920)', () => {
  assert.deepEqual(layoutDisplays([d(1, 0, 0, 1280, 800)]), { width: 1280, height: 800, tiles: [{ id: 1, x: 0, y: 0, w: 1280, h: 800 }] });
  const r = layoutDisplays([d(1, 0, 0, 1440, 900, 2)]);
  assert.equal(r.width, 1920); assert.equal(r.height, 1200);
});

test('two monitors side by side become one wide picture', () => {
  const r = layoutDisplays([d(1, 0, 0, 1000, 800), d(2, 1000, 0, 800, 600)]);
  assert.equal(r.width, 1800); assert.equal(r.height, 800);
  assert.deepEqual(r.tiles.map((t) => [t.x, t.y, t.w, t.h]), [[0, 0, 1000, 800], [1000, 0, 800, 600]]);
});

test('stacked monitors', () => {
  const r = layoutDisplays([d(1, 0, 0, 1000, 500), d(2, 0, 500, 1000, 500)]);
  assert.equal(r.width, 1000); assert.equal(r.height, 1000);
  assert.deepEqual(r.tiles.map((t) => t.y), [0, 500]);
});

test('a monitor placed left of / above the main one (negative coordinates)', () => {
  const r = layoutDisplays([d(1, 0, 0, 1000, 800), d(2, -800, -200, 800, 600)]);
  assert.equal(r.width, 1800); assert.equal(r.height, 1000);
  const t2 = r.tiles.find((t) => t.id === 2), t1 = r.tiles.find((t) => t.id === 1);
  assert.deepEqual([t2.x, t2.y], [0, 0]);
  assert.deepEqual([t1.x, t1.y], [800, 200]);
});

test('very wide desk is scaled so the long edge is at most 1920', () => {
  const r = layoutDisplays([d(1, 0, 0, 1920, 1080), d(2, 1920, 0, 1920, 1080)]);
  assert.equal(r.width, 1920); assert.equal(r.height, 540);
  assert.deepEqual(r.tiles.map((t) => [t.x, t.w]), [[0, 960], [960, 960]]);
});

test('mixed Retina + normal monitor share one scale, tiles never overflow', () => {
  const r = layoutDisplays([d(1, 0, 0, 1440, 900, 2), d(2, 1440, 0, 1920, 1080, 1)]);
  for (const t of r.tiles) { assert.ok(t.x + t.w <= r.width); assert.ok(t.y + t.h <= r.height); }
  assert.ok(Math.max(r.width, r.height) <= 1920);
});

test('no displays is an error', () => assert.throws(() => layoutDisplays([])));

// BGRA helper: solid colour block
const block = (w, h, [b, g, r]) => { const buf = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) buf.set([b, g, r, 255], i * 4); return buf; };
const px = (buf, width, x, y) => [...buf.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];

test('stitch puts each monitor in its own place, gaps are black', () => {
  const RED = [0, 0, 255], BLUE = [255, 0, 0];
  const out = stitchBitmaps([
    { bitmap: block(4, 4, RED), x: 0, y: 0, w: 4, h: 4 },
    { bitmap: block(2, 2, BLUE), x: 4, y: 0, w: 2, h: 2 },
  ], 6, 4);
  assert.equal(out.length, 6 * 4 * 4);
  assert.deepEqual(px(out, 6, 1, 1), RED);
  assert.deepEqual(px(out, 6, 5, 1), BLUE);
  assert.deepEqual(px(out, 6, 5, 3), [0, 0, 0]); // gap under the small monitor
  assert.equal(out[(3 * 6 + 5) * 4 + 3], 255); // still opaque
});

test('stitch rejects a bitmap of the wrong size', () => {
  assert.throws(() => stitchBitmaps([{ bitmap: Buffer.alloc(10), x: 0, y: 0, w: 4, h: 4 }], 4, 4));
});

test('only macOS can hide other apps; anything but "granted" there means blocked', () => {
  assert.equal(screenGranted('darwin', 'granted'), true);
  for (const s of ['denied', 'not-determined', 'restricted', 'unknown', undefined]) assert.equal(screenGranted('darwin', s), false);
  assert.equal(screenGranted('win32', 'denied'), true);
  assert.equal(screenGranted('linux', undefined), true);
});
