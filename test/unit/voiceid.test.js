'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../../src/voice/voiceid');

// deterministic pseudo-random helpers
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return Float32Array.from(v.map((x) => x / n)); };
const randVec = () => unit(Array.from({ length: 192 }, rnd));
const near = (base, noise) => unit(Array.from(base, (x) => x + noise * rnd()));

test('cosine: identical = 1, opposite = -1, unrelated ~ 0, zero vector is safe', () => {
  const a = randVec();
  assert.ok(Math.abs(V.cosine(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(V.cosine(a, a.map((x) => -x)) + 1) < 1e-6);
  assert.ok(Math.abs(V.cosine(a, randVec())) < 0.3);
  assert.equal(V.cosine(new Float32Array(192), a), 0);
});

test('profile is the normalised average of the enrollment pieces', () => {
  const me = randVec();
  const embs = Array.from({ length: 6 }, () => near(me, 0.05));
  const p = V.buildProfile(embs);
  assert.equal(p.vec.length, 192);
  assert.ok(Math.abs(Math.sqrt(p.vec.reduce((s, x) => s + x * x, 0)) - 1) < 1e-4);
  assert.ok(V.cosine(Float32Array.from(p.vec), me) > 0.97);
  assert.ok(p.selfMean > 0.9 && p.selfMin <= p.selfMean);
});

test('enrollment is refused when there is too little speech or the pieces disagree', () => {
  assert.throws(() => V.buildProfile([randVec(), randVec()]), /not-enough-speech/);
  assert.throws(() => V.buildProfile(Array.from({ length: 6 }, randVec)), /inconsistent/); // 6 different "voices"
});

test('decision: my voice passes, another voice fails, strictness moves the bar', () => {
  const me = randVec();
  const profile = V.buildProfile(Array.from({ length: 6 }, () => near(me, 0.05)));
  const mine = near(me, 0.06);
  const other = randVec();
  assert.equal(V.decide(profile, mine).ok, true);
  assert.equal(V.decide(profile, other).ok, false);
  assert.ok(V.decide(profile, other).score < 0.4);
  // a borderline voice with similarity exactly 0.53: passes "relaxed" (0.52), fails "normal" and "strict"
  const p = Float32Array.from(profile.vec);
  const u = randVec();
  const d = V.cosine(p, u);
  const orth = unit(Array.from(u, (x, i) => x - d * p[i]));
  const borderline = Float32Array.from(p, (x, i) => 0.53 * x + Math.sqrt(1 - 0.53 ** 2) * orth[i]);
  assert.ok(Math.abs(V.cosine(p, borderline) - 0.53) < 1e-4);
  assert.equal(V.decide(profile, borderline, 'relaxed').ok, true);
  assert.equal(V.decide(profile, borderline, 'normal').ok, false);
  assert.equal(V.decide(profile, borderline, 'strict').ok, false);
  assert.equal(V.decide(profile, mine, 'unknown-setting').threshold, V.THRESHOLDS.normal);
});

// --- speech trimming ---
const tone = (sec, amp) => Float32Array.from({ length: Math.round(sec * 16000) }, (_, i) => amp * Math.sin(i * 0.3) * (0.6 + 0.4 * Math.sin(i * 0.002)));
const noise = (sec, amp) => Float32Array.from({ length: Math.round(sec * 16000) }, () => amp * rnd());
const cat = (...xs) => { const o = new Float32Array(xs.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of xs) { o.set(x, k); k += x.length; } return o; };

test('speechOnly drops silence and room noise but keeps the speech', () => {
  const rec = cat(noise(1.0, 0.002), tone(1.5, 0.3), noise(1.0, 0.002), tone(0.5, 0.3), noise(0.5, 0.002));
  const sp = V.speechOnly(rec);
  assert.ok(sp.length > 1.8 * 16000 && sp.length < 2.3 * 16000, `kept ${(sp.length / 16000).toFixed(2)} s of 4.5 s`);
});

test('speechOnly returns nothing for pure room noise or digital silence', () => {
  assert.equal(V.speechOnly(noise(3, 0.003)).length, 0);
  assert.equal(V.speechOnly(new Float32Array(48000)).length, 0);
  assert.equal(V.speechOnly(new Float32Array(100)).length, 0);
});

test('enrollmentChunks: 2-second speech pieces, ignores silence', () => {
  const rec = cat(noise(1, 0.002), tone(5, 0.3), noise(2, 0.002), tone(5, 0.3), noise(1, 0.002));
  const chunks = V.enrollmentChunks(rec);
  assert.ok(chunks.length >= 5 && chunks.length <= 6, `chunks=${chunks.length}`);
  assert.ok(chunks.every((c) => c.length === 32000));
  assert.equal(V.enrollmentChunks(cat(noise(2, 0.002), tone(1.2, 0.3))).length, 0); // < 2 s of speech in total
});
