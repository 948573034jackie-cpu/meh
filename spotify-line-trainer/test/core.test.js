const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/core.js');

const L = (ms, words, end = '0') => ({ startTimeMs: String(ms), words, endTimeMs: end });

test('parseLyrics: basic synced lines, ends at next line', () => {
  const r = core.parseLyrics({ lyrics: { syncType: 'LINE_SYNCED', lines: [L(1000, 'one'), L(3000, 'two'), L(6000, 'three')] } }, 10);
  assert.ok(r.synced);
  assert.deepStrictEqual(r.lines.map(l => [l.start, l.end, l.text]), [[1, 3, 'one'], [3, 6, 'two'], [6, 10, 'three']]);
});

test('parseLyrics: ♪ and empty lines are skipped but act as boundaries', () => {
  const r = core.parseLyrics({ lyrics: { syncType: 'LINE_SYNCED', lines: [L(1000, 'a'), L(2500, '♪'), L(9000, ''), L(10000, 'b')] } }, 20);
  assert.deepStrictEqual(r.lines.map(l => [l.start, l.end]), [[1, 2.5], [10, 20]]);
});

test('parseLyrics: long gap capped at MAX_LINE', () => {
  const r = core.parseLyrics({ lyrics: { syncType: 'LINE_SYNCED', lines: [L(0, 'intro line'), L(60000, 'later')] } }, 120);
  assert.strictEqual(r.lines[0].end, core.MAX_LINE);
  assert.strictEqual(r.lines[1].end, 60 + core.MAX_LINE);
});

test('parseLyrics: unsynced / garbage / missing', () => {
  assert.strictEqual(core.parseLyrics({ lyrics: { syncType: 'UNSYNCED', lines: [L(0, 'x'), L(0, 'y')] } }, 10).synced, false);
  assert.strictEqual(core.parseLyrics({ lyrics: { lines: [L(0, 'x'), L(0, 'y')] } }, 10).synced, false);
  assert.strictEqual(core.parseLyrics(null).synced, false);
  assert.strictEqual(core.parseLyrics({}).synced, false);
  assert.strictEqual(core.parseLyrics({ lyrics: { syncType: 'LINE_SYNCED', lines: [] } }).synced, false);
});

test('parseLyrics: unsorted input, duplicate times merged, tiny lines padded, beyond-duration dropped', () => {
  const r = core.parseLyrics({ lyrics: { syncType: 'LINE_SYNCED', lines: [L(5000, 'c'), L(1000, 'a'), L(1000, 'a2'), L(1100, 'b'), L(99000, 'late')] } }, 10);
  assert.deepStrictEqual(r.lines.map(l => l.text), ['a / a2', 'b', 'c']);
  assert.ok(r.lines[1].end - r.lines[1].start >= core.MIN_LINE - 1e-9);
  assert.ok(r.lines.every(l => l.end <= 10 && l.end > l.start));
});

test('parseLyrics: works without known duration (last line capped)', () => {
  const r = core.parseLyrics({ lyrics: { syncType: 'LINE_SYNCED', lines: [L(1000, 'a'), L(2000, 'b')] } }, NaN);
  assert.strictEqual(r.lines[1].end, 2 + core.MAX_LINE);
});

test('normalizeSettings sanitises bad values', () => {
  const s = core.normalizeSettings({ mode: 'x', reps: 4, speed: 2, trainingSpeeds: [1, 0.3, 'bad', 0.3], trainingReps: '7' });
  assert.deepStrictEqual(s, { mode: 'repeat', reps: 5, speed: 1, trainingReps: 7, trainingSpeeds: [0.3, 1], startFrom: 'first', autoNext: false, playFullAfter: true });
  assert.deepStrictEqual(core.normalizeSettings({ trainingSpeeds: [] }).trainingSpeeds, [0.3, 0.5, 0.75, 1]);
});

function walk(lineCount, settings) {
  const p = core.plan(settings);
  const out = [];
  let pos = { line: 0, stage: 0, rep: 0 };
  while (!pos.done) { out.push([pos.line, p.stages[pos.stage], pos.rep]); pos = core.advance(pos, lineCount, p); }
  return out;
}

test('repeat mode: every line N times at one speed, in order', () => {
  const seq = walk(3, { mode: 'repeat', reps: 7, speed: 0.5 });
  assert.strictEqual(seq.length, 21);
  assert.ok(seq.every(s => s[1] === 0.5));
  assert.deepStrictEqual(seq.map(s => s[0]), [0,0,0,0,0,0,0,1,1,1,1,1,1,1,2,2,2,2,2,2,2]);
});

test('training mode: 30→50→75→100, 5× each, then next line', () => {
  const seq = walk(2, { mode: 'training', trainingReps: 5 });
  assert.strictEqual(seq.length, 40);
  const line0 = seq.filter(s => s[0] === 0).map(s => s[1]);
  assert.deepStrictEqual(line0, [0.3,0.3,0.3,0.3,0.3,0.5,0.5,0.5,0.5,0.5,0.75,0.75,0.75,0.75,0.75,1,1,1,1,1]);
  assert.ok(seq.slice(0, 20).every(s => s[0] === 0) && seq.slice(20).every(s => s[0] === 1));
});

test('findLineAt', () => {
  const lines = [{ start: 2 }, { start: 5 }, { start: 9 }];
  assert.strictEqual(core.findLineAt(lines, 0), 0);
  assert.strictEqual(core.findLineAt(lines, 4.9), 0);
  assert.strictEqual(core.findLineAt(lines, 5), 1);
  assert.strictEqual(core.findLineAt(lines, 100), 2);
});
