'use strict';
// Runs captureScreen() against FAKE monitors (plain Node, no Electron) to prove the
// multi-monitor wiring: matching screens to displays, resizing, stitching.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function fakeImage(w, h, [b, g, r]) {
  const make = (w, h) => ({
    getSize: () => ({ width: w, height: h }),
    isEmpty: () => false,
    resize: ({ width, height }) => make(width, height),
    toBitmap: () => { const buf = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) buf.set([b, g, r, 255], i * 4); return buf; },
  });
  return make(w, h);
}

function loadWith({ displays, sources, platform = 'darwin', status = 'granted' }) {
  const fakeElectron = {
    screen: { getAllDisplays: () => displays, getDisplayNearestPoint: () => displays[0], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async () => sources },
    nativeImage: { createFromBitmap: (bitmap, size) => ({ bitmap, ...size, getSize: () => size }) },
    systemPreferences: { getMediaAccessStatus: () => status },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : orig.call(this, req, ...rest); };
  delete require.cache[require.resolve('../../src/screenshot')];
  try { return require('../../src/screenshot'); } finally { Module._load = orig; }
}

const RED = [0, 0, 255], BLUE = [255, 0, 0];
const pix = (img, x, y) => [...img.bitmap.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
const two = [
  { id: 10, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 1 },
  { id: 20, bounds: { x: 1000, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
];

test('two monitors -> one picture with each screen in its own place', async () => {
  // sources deliberately listed in the OPPOSITE order: must be matched by display_id
  const { captureScreen } = loadWith({ displays: two, sources: [
    { display_id: '20', thumbnail: fakeImage(800, 600, BLUE) },
    { display_id: '10', thumbnail: fakeImage(1000, 800, RED) },
  ] });
  const img = await captureScreen({ all: true });
  assert.equal(img.width, 1800); assert.equal(img.height, 800);
  assert.deepEqual(pix(img, 500, 400), RED);
  assert.deepEqual(pix(img, 1400, 300), BLUE);
  assert.deepEqual(pix(img, 1400, 700), [0, 0, 0]); // empty corner under the smaller screen
});

test('thumbnails of the wrong size are resized to fit their place', async () => {
  const { captureScreen } = loadWith({ displays: two, sources: [
    { display_id: '10', thumbnail: fakeImage(500, 400, RED) },
    { display_id: '20', thumbnail: fakeImage(400, 300, BLUE) },
  ] });
  const img = await captureScreen({ all: true });
  assert.equal(img.width, 1800);
  assert.deepEqual(pix(img, 100, 100), RED);
  assert.deepEqual(pix(img, 1700, 100), BLUE);
});

test('sources without display_id (some systems) fall back to the same order', async () => {
  const { captureScreen } = loadWith({ displays: two, sources: [
    { display_id: '', thumbnail: fakeImage(1000, 800, RED) },
    { display_id: '', thumbnail: fakeImage(800, 600, BLUE) },
  ] });
  const img = await captureScreen({ all: true });
  assert.deepEqual(pix(img, 10, 10), RED);
  assert.deepEqual(pix(img, 1790, 10), BLUE);
});

test('all:false captures just one monitor', async () => {
  const { captureScreen } = loadWith({ displays: two, sources: [
    { display_id: '10', thumbnail: fakeImage(1000, 800, RED) },
    { display_id: '20', thumbnail: fakeImage(800, 600, BLUE) },
  ] });
  const img = await captureScreen({ all: false });
  assert.deepEqual(img.getSize(), { width: 1000, height: 800 });
});

test('single monitor is returned untouched', async () => {
  const one = [two[0]];
  const thumb = fakeImage(1000, 800, RED);
  const { captureScreen } = loadWith({ displays: one, sources: [{ display_id: '10', thumbnail: thumb }] });
  assert.equal(await captureScreen(), thumb);
});

test('a monitor with no picture is an error, never a half screenshot', async () => {
  const { captureScreen } = loadWith({ displays: two, sources: [{ display_id: '10', thumbnail: fakeImage(1000, 800, RED) }] });
  await assert.rejects(captureScreen({ all: true }), /empty-capture/);
  const { captureScreen: c2 } = loadWith({ displays: [two[0]], sources: [] });
  await assert.rejects(c2(), /no-screen-source/);
});

test('screenAccess reports macOS state; other systems are always granted', () => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    assert.equal(loadWith({ displays: two, sources: [], status: 'denied' }).screenAccess(), 'denied');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.equal(loadWith({ displays: two, sources: [], status: 'denied' }).screenAccess(), 'granted');
  } finally { Object.defineProperty(process, 'platform', orig); }
});
