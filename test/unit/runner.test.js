'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunner } = require('../../src/voice/runner');

// deterministic audio: "speech" = loud tone, "silence" = faint noise
let seed = 5;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const chunk = (speech) => Float32Array.from({ length: 320 }, (_, i) => speech ? 0.3 * Math.sin(i * 0.4 + rnd()) : 0.002 * rnd());
const feed = (r, sec, speech) => { for (let i = 0; i < Math.round(sec * 50); i++) r.push(chunk(speech)); };
const tick = () => new Promise((res) => setImmediate(res));

function make() {
  const out = [];
  const embeds = [];
  const fake = async () => ({ embed: async (pcm) => { embeds.push(pcm.length); return new Float32Array(192).fill(0.07); } });
  const r = createRunner({ ort: {}, wasmPaths: '', send: (m) => out.push(m), createEmbedder: fake });
  return { r, out, embeds };
}

test('model must be loaded first; then it reports ready', async () => {
  const { r, out } = make();
  assert.equal(r.ready, false);
  await r.handle({ cmd: 'voice-model', bytes: new ArrayBuffer(8) });
  assert.deepEqual(out, [{ ready: true }]);
  assert.equal(r.ready, true);
});

test('a check asked while the model is not loaded answers "model-not-ready" (never hangs)', async () => {
  const { r, out } = make();
  feed(r, 1, true);
  await r.handle({ cmd: 'verify', id: 1, sec: 2 });
  feed(r, 2.1, true);
  await tick();
  assert.deepEqual(out, [{ id: 1, error: 'model-not-ready' }]);
});

test('verify: waits ~2 s after the first word, then returns ONE voiceprint of the speech', async () => {
  const { r, out, embeds } = make();
  await r.handle({ cmd: 'voice-model', bytes: new ArrayBuffer(8) });
  out.length = 0;
  feed(r, 3, false); // quiet room
  await r.handle({ cmd: 'verify', id: 7, sec: 2 }); // app noticed speech starting
  feed(r, 1.5, true);
  await tick();
  assert.equal(out.length, 0, 'not ready before the 2 s window is complete');
  feed(r, 0.6, true);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 7);
  assert.equal(out[0].emb.length, 192);
  assert.ok(out[0].speechSec > 1.5);
  assert.equal(embeds.length, 1);
});

test('verify: a very short "yes" is reported as too short instead of guessing', async () => {
  const { r, out } = make();
  await r.handle({ cmd: 'voice-model', bytes: new ArrayBuffer(8) });
  out.length = 0;
  feed(r, 2, false);
  await r.handle({ cmd: 'verify', id: 3, sec: 2 });
  feed(r, 0.3, true);
  feed(r, 2, false);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(out[0].error, 'too-short');
});

test('enrollment: reports progress, finishes when enough speech, returns 2 s voiceprints', async () => {
  const { r, out } = make();
  await r.handle({ cmd: 'voice-model', bytes: new ArrayBuffer(8) });
  out.length = 0;
  await r.handle({ cmd: 'enroll', id: 9, targetSec: 8, maxSec: 40 });
  for (let i = 0; i < 6; i++) { feed(r, 2, true); feed(r, 0.5, false); }
  await new Promise((res) => setTimeout(res, 30));
  const progress = out.filter((m) => m.progress !== undefined);
  assert.ok(progress.length >= 3 && progress[progress.length - 1].progress > progress[0].progress);
  const done = out.find((m) => m.embs);
  assert.ok(done, 'enrollment finished');
  assert.equal(done.id, 9);
  assert.equal(done.reason, 'enough');
  assert.ok(done.embs.length >= 3 && done.embs.every((e) => e.length === 192));
});

test('enrollment stops at the time limit even if nobody speaks', async () => {
  const { r, out } = make();
  await r.handle({ cmd: 'voice-model', bytes: new ArrayBuffer(8) });
  out.length = 0;
  await r.handle({ cmd: 'enroll', id: 4, targetSec: 10, maxSec: 6 });
  feed(r, 7, false);
  await new Promise((res) => setTimeout(res, 30));
  const done = out.find((m) => m.id === 4 && (m.embs || m.error));
  assert.ok(done && done.reason === 'timeout');
  assert.equal(done.embs.length, 0);
});

test('enrollment can be cancelled', async () => {
  const { r, out } = make();
  await r.handle({ cmd: 'enroll', id: 2 });
  await r.handle({ cmd: 'enroll-cancel' });
  assert.deepEqual(out.pop(), { id: 2, error: 'cancelled' });
});
