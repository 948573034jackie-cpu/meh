// Unit tests for the pure logic (src/core.js) and the media parsers in
// src/inject.js. Run: npm test   (needs fixtures: node tools/make-fixtures.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const C = require('../src/core.js');
const FX = path.join(__dirname, 'fixtures');
const hasFixtures = fs.existsSync(path.join(FX, 'manifest.json'));

function loadParsers() {
  const ctx = { __YTL_TEST__: { parsersOnly: true }, Uint8Array, ArrayBuffer, Math, String, Number, Set, Promise, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'inject.js'), 'utf8'), ctx);
  return ctx.__YTL_TEST__.parsers;
}
const P = loadParsers();
// Objects from the vm context have a different prototype; compare as JSON.
const plain = (o) => JSON.parse(JSON.stringify(o));
const read = (f) => new Uint8Array(fs.readFileSync(path.join(FX, f)));

test('formatTime', () => {
  assert.equal(C.formatTime(0), '0:00.00');
  assert.equal(C.formatTime(83.456), '1:23.45');
  assert.equal(C.formatTime(3725.1), '1:02:05.10');
  assert.equal(C.formatTime(59.999), '0:59.99');
  assert.equal(C.formatTime(61, false), '1:01');
  assert.equal(C.formatTime(NaN), '0:00.00');
  assert.equal(C.formatTime(-3), '0:00.00');
});

test('trainerRate ramps linearly from start to goal and then stays', () => {
  assert.equal(C.trainerRate(0.5, 1, 10, 1), 0.5);
  assert.equal(C.trainerRate(0.5, 1, 10, 10), 1);
  assert.equal(C.trainerRate(0.5, 1, 10, 25), 1);
  let prev = 0;
  for (let r = 1; r <= 10; r++) {
    const v = C.trainerRate(0.5, 1, 10, r);
    assert.ok(v >= prev, `rep ${r} should not slow down`);
    prev = v;
  }
  assert.equal(C.trainerRate(0.3, 1, 50, 1), 0.3);
  assert.equal(C.trainerRate(0.3, 1, 50, 50), 1);
  assert.equal(C.trainerRate(0.3, 1, 1, 1), 1, 'one rep means straight to the goal');
  assert.equal(C.trainerRate(0.7, 1.2, 5, 3), 0.95);
});

test('roundRate clamps to the supported speed range', () => {
  assert.equal(C.roundRate(0.1), 0.25);
  assert.equal(C.roundRate(5), 2);
  assert.equal(C.roundRate(0.7499999), 0.75);
});

test('loopEnd keeps clear of the real end of the video', () => {
  assert.equal(C.loopEnd(10, 100), 10);
  assert.equal(C.loopEnd(100, 100), 100 - C.END_GUARD);
  assert.equal(C.loopEnd(10, 0), 10);
});

test('normalizeLoop orders, clamps and rejects tiny loops', () => {
  assert.deepEqual(C.normalizeLoop(5, 2, 10), { a: 2, b: 5 });
  assert.deepEqual(C.normalizeLoop(-1, 20, 10), { a: 0, b: 10 });
  assert.equal(C.normalizeLoop(2, 2.05, 10), null);
  assert.equal(C.normalizeLoop(null, 2, 10), null);
  assert.deepEqual(C.normalizeLoop(1, 3, 0), { a: 1, b: 3 }, 'unknown duration still works');
});

test('PeakStore: add, coverage, gaps, merge, serialize', () => {
  const s = new C.PeakStore(50);
  s.setDuration(10);
  assert.equal(s.coverage(10), 0);
  const chunk = (n, v) => new Uint8Array(n).fill(v);
  s.add(0, chunk(100, 50), chunk(100, 1), chunk(100, 2), chunk(100, 3)); // 0..2s
  s.add(250, chunk(100, 200), null, null, null); // 5..7s
  assert.equal(s.coverage(10), 0.4);
  assert.equal(s.maxPeak, 200);
  assert.ok(s.isCovered(1.5));
  assert.ok(!s.isCovered(3));
  const g = s.gaps(10);
  assert.deepEqual(g.map((x) => [x.start, x.end]), [[2, 5], [7, 9.4]]);
  assert.deepEqual(s.nextGap(6, 10), { start: 7, end: 9.4 });
  assert.deepEqual(s.nextGap(9.5, 10), { start: 2, end: 5 }, 'wraps to the first gap');
  // max-merge: repeating a chunk with lower values changes nothing
  s.add(0, chunk(10, 10), null, null, null);
  assert.equal(s.peak[0], 50);

  const round = C.PeakStore.deserialize(s.serialize());
  assert.equal(round.n, s.n);
  assert.equal(round.coverage(10), 0.4);
  assert.equal(round.peak[260], 200);
  assert.equal(round.maxPeak, 200);

  const other = new C.PeakStore(50);
  other.add(100, chunk(150, 9), null, null, null); // 2..5s
  s.merge(other);
  assert.equal(s.coverage(10), 0.7);
  assert.equal(s.gaps(10).length, 1);
});

test('bandColor favours red for bass and blue for highs', () => {
  const bass = C.bandColor(200, 10, 5);
  const highs = C.bandColor(5, 10, 200);
  assert.ok(bass[0] > bass[2]);
  assert.ok(highs[2] > highs[0]);
  for (const c of [...bass, ...highs]) assert.ok(c >= 0 && c <= 255);
});

test('computePeaks: loud and quiet parts land in the right bins', () => {
  const sr = 16000;
  const n = sr * 2;
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = (i < sr ? 0.9 : 0.1) * Math.sin((2 * Math.PI * 440 * i) / sr);
  const r = P.computePeaks([ch], sr, 4); // chunk starts at 4 s
  assert.equal(r.startBin, 200);
  assert.equal(r.peak.length, 100);
  assert.ok(r.peak[10] > 220, 'first second is loud');
  assert.ok(r.peak[80] < 40, 'second second is quiet');
  assert.ok(r.mid[10] > r.low[10], '440 Hz counts as mids');
});

test('EBML vint parsing', () => {
  assert.deepEqual(plain(P.readId(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0)), { id: 0x1a45dfa3, len: 4 });
  assert.deepEqual(plain(P.readSize(new Uint8Array([0x81]), 0)), { value: 1, len: 1, unknown: false });
  assert.equal(P.readSize(new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0).unknown, true);
  assert.deepEqual(plain(P.readSize(new Uint8Array([0x40, 0x02]), 0)), { value: 2, len: 2, unknown: false });
});

test('WebM: find clusters, timecode scale and cluster times', { skip: !hasFixtures && 'run node tools/make-fixtures.js' }, () => {
  const m = JSON.parse(fs.readFileSync(path.join(FX, 'manifest.json'), 'utf8'));
  const init = read(m.audio.init);
  assert.equal(P.webmFindCluster(init), -1, 'init has no cluster');
  assert.equal(P.webmTimecodeScale(init), 1e6);
  const seg5 = read(m.audio.segs[4].url);
  const both = new Uint8Array(init.length + seg5.length);
  both.set(init);
  both.set(seg5, init.length);
  assert.equal(P.webmFindCluster(both), init.length, 'init+media splits at the cluster');
  for (const s of m.audio.segs.slice(0, 10)) {
    const t = P.webmClusterTime(read(s.url), 1e6);
    assert.ok(Math.abs(t - s.start) < 0.03, `${s.url}: ${t} vs ${s.start}`);
  }
  assert.equal(P.webmClusterTime(init, 1e6), null);
});

test('MP4: init meta, fragment times and ADTS that ffmpeg can decode', { skip: !hasFixtures && 'run node tools/make-fixtures.js' }, () => {
  const m = JSON.parse(fs.readFileSync(path.join(FX, 'manifest.json'), 'utf8'));
  const init = read(m.mp4.init);
  assert.equal(P.mp4FindMediaStart(init), -1);
  const meta = P.mp4InitMeta(init);
  assert.ok(meta.timescale > 0);
  assert.equal(meta.asc.objType, 2, 'AAC-LC');
  assert.equal(meta.asc.channels, 1);
  const seg = read(m.mp4.segs[4].url);
  assert.equal(P.mp4FindMediaStart(seg) >= 0, true);
  const fr = P.mp4Fragments(seg, meta.timescale);
  assert.ok(Math.abs(fr.time - m.mp4.segs[4].start) < 0.05, `time ${fr.time}`);
  assert.ok(fr.samples.length > 50);
  const adts = P.toAdts(fr.samples, meta.asc);
  const tmp = path.join(os.tmpdir(), `ytl-${process.pid}.aac`);
  fs.writeFileSync(tmp, adts);
  try {
    const outp = execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', tmp, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 1 << 26 });
    const secs = outp.length / 4 / 16000;
    assert.ok(Math.abs(secs - (m.mp4.segs[4].end - m.mp4.segs[4].start)) < 0.1, `decoded ${secs}s`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
