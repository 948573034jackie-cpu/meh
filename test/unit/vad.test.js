'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vad } = require('../../src/vad');

const FRAME = 20;
// Feed a list of [dB, durationMs] segments; returns recorded events.
function run(segments, opts = {}, sensitivity) {
  const events = [];
  const vad = new Vad(opts, (e) => events.push(e));
  if (sensitivity) vad.setSensitivity(sensitivity);
  let t = 1000;
  for (const [db, ms] of segments) {
    for (let i = 0; i < ms / FRAME; i++) { vad.process(db, t); t += FRAME; }
  }
  return { events, vad, end: t };
}
const starts = (r) => r.events.filter((e) => e.type === 'start');

const QUIET = -70, SPEECH = -25;

test('silence never triggers', () => {
  assert.equal(starts(run([[QUIET, 10000]])).length, 0);
});

test('speech triggers exactly once, at the very beginning of the first word', () => {
  const r = run([[QUIET, 2000], [SPEECH, 3000], [QUIET, 2000]]);
  const s = starts(r);
  assert.equal(s.length, 1);
  // speech began at t=3000; must fire within 3 frames (60ms) of that
  const latency = s[0].ts - 3000;
  assert.ok(latency >= 0 && latency <= 80, `latency ${latency}ms`);
});

test('fires long before the sentence is over', () => {
  const r = run([[QUIET, 2000], [SPEECH, 5000]]); // still talking, never stopped
  assert.equal(starts(r).length, 1);
  assert.ok(starts(r)[0].ts < 3200);
});

test('a short pause inside a sentence does not re-trigger', () => {
  const r = run([[QUIET, 2000], [SPEECH, 1000], [QUIET, 500], [SPEECH, 1000], [QUIET, 2000]]);
  assert.equal(starts(r).length, 1);
});

test('a new sentence after a real silence triggers again', () => {
  const r = run([[QUIET, 2000], [SPEECH, 1000], [QUIET, 4000], [SPEECH, 1000], [QUIET, 2000]], { minIntervalMs: 2500 });
  assert.equal(starts(r).length, 2);
});

test('default: one screenshot, then wait a full minute even if I keep talking', () => {
  // 5 separate sentences, 5s apart, all inside the first minute => only the first fires
  const seg = [[QUIET, 2000]];
  for (let i = 0; i < 5; i++) seg.push([SPEECH, 1000], [QUIET, 4000]);
  const r = run(seg);
  assert.equal(starts(r).length, 1);
  assert.equal(r.events.filter((e) => e.type === 'suppressed').length, 4);
});

test('after the minute is up, the next time I speak takes another screenshot', () => {
  const r = run([[QUIET, 2000], [SPEECH, 1000], [QUIET, 30000], [SPEECH, 1000], [QUIET, 31000], [SPEECH, 1000], [QUIET, 2000]]);
  // t=3000 fires; t=36000 is only 33s later => suppressed; t=68000 is 65s later => fires
  const s = starts(r);
  assert.equal(s.length, 2);
  assert.ok(s[1].ts - s[0].ts >= 60000);
});

test('no speech = no screenshots, even over many minutes', () => {
  assert.equal(starts(run([[QUIET, 300000]])).length, 0);
});

test('interval is adjustable', () => {
  const vad = new Vad({}, () => {});
  vad.setMinInterval(30000);
  assert.equal(vad.opts.minIntervalMs, 30000);
  assert.throws(() => vad.setMinInterval(-1));
});

test('a single click / pop (20-40ms) is ignored', () => {
  assert.equal(starts(run([[QUIET, 2000], [SPEECH, 40], [QUIET, 2000]])).length, 0);
});

test('start-up pop during warm-up is ignored', () => {
  assert.equal(starts(run([[SPEECH, 300], [QUIET, 3000]])).length, 0);
});

test('constant background noise (fan) adapts and does not trigger repeatedly', () => {
  const r = run([[QUIET, 2000], [-55, 60000]]);
  assert.ok(starts(r).length <= 1, `got ${starts(r).length}`);
  // and after adapting, real speech on top of the fan still triggers
  const r2 = run([[QUIET, 2000], [-55, 60000], [-25, 1500], [-55, 2000]]);
  assert.ok(starts(r2).length >= 1);
});

test('never-ending loud sound is eventually treated as noise, not speech', () => {
  const r = run([[QUIET, 2000], [-30, 60000]]);
  assert.equal(starts(r).length, 1);
  assert.ok(r.events.some((e) => e.type === 'end' && e.reason === 'noise'));
});

test('sensitivity presets change what counts as speech', () => {
  const soft = -45;
  assert.equal(starts(run([[QUIET, 2000], [soft, 1000], [QUIET, 2000]], {}, 'low')).length, 0);
  assert.equal(starts(run([[QUIET, 2000], [soft, 1000], [QUIET, 2000]], {}, 'high')).length, 1);
});

test('digital silence / NaN / -Infinity levels do not break it', () => {
  const vad = new Vad({}, () => {});
  for (let i = 0; i < 100; i++) vad.process(i % 2 ? -Infinity : NaN, 1000 + i * 20);
  assert.ok(Number.isFinite(vad.floorDb));
});

test('unknown sensitivity is rejected', () => {
  assert.throws(() => new Vad().setSensitivity('extreme'));
});
