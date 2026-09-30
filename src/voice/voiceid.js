(function () {
'use strict';
// "Only react to my voice": the decision logic (no audio libraries, easy to test).
//
//  * Enrollment: you read a few sentences; the speech is cut into 2-second pieces, each becomes a
//    voiceprint, and their average is your profile.
//  * Checking: when you start speaking, the next ~2 seconds of speech become a voiceprint and are
//    compared with your profile (cosine similarity, 1.0 = identical). Above the threshold = you.
//
// Measured with the model on test voices (2 s of speech): your voice near the mic scores 0.75-0.9,
// other people near the mic almost always < 0.6, and any voice coming out of a speaker and across
// the room (e.g. Claude's voice) scored < 0.4.

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 ms
const THRESHOLDS = { relaxed: 0.52, normal: 0.6, strict: 0.66 };
const MIN_SPEECH_SEC = 1.0; // less than this is too little to recognise a voice
const CHUNK_SEC = 2.0;

function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

function meanVector(vs) {
  const out = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] += v[i];
  let n = 0;
  for (const v of out) n += v * v;
  n = Math.sqrt(n) || 1;
  return out.map((v) => v / n);
}

// Keeps only the parts of a recording where someone is speaking (drops silence between words,
// before and after). Returns a Float32Array of the speech samples joined together.
function speechOnly(pcm) {
  const frames = Math.floor(pcm.length / FRAME);
  if (frames < 5) return new Float32Array(0);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = 0; i < FRAME; i++) { const v = pcm[f * FRAME + i]; s += v * v; }
    db[f] = 10 * Math.log10(s / FRAME + 1e-12);
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[Math.floor(sorted.length * 0.95)];
  if (peak - floor < 8) return new Float32Array(0); // nothing louder than the room noise
  const thr = Math.max(floor + 8, peak - 25);
  const keep = [];
  for (let f = 0; f < frames; f++) if (db[f] >= thr) keep.push(f);
  const out = new Float32Array(keep.length * FRAME);
  keep.forEach((f, k) => out.set(pcm.subarray(f * FRAME, (f + 1) * FRAME), k * FRAME));
  return out;
}

// Enrollment audio -> list of 2 s speech pieces (a last piece of >= 1 s is kept).
function enrollmentChunks(pcm) {
  const sp = speechOnly(pcm);
  const n = Math.round(CHUNK_SEC * SAMPLE_RATE);
  const out = [];
  for (let s = 0; s + n <= sp.length; s += n) out.push(sp.subarray(s, s + n));
  const rest = sp.length % n;
  if (rest >= MIN_SPEECH_SEC * SAMPLE_RATE && sp.length >= n) out.push(sp.subarray(sp.length - n)); // last piece, overlapping
  return out;
}

// embeddings of the enrollment pieces -> { vec, selfMean, selfMin, count } or throws 'inconsistent'
function buildProfile(embs) {
  if (embs.length < 3) throw new Error('not-enough-speech');
  const sims = embs.map((e, i) => cosine(e, meanVector(embs.filter((_, j) => j !== i))));
  const selfMean = sims.reduce((a, b) => a + b, 0) / sims.length;
  if (selfMean < 0.6) throw new Error('inconsistent'); // noisy or more than one person
  return { vec: Array.from(meanVector(embs)), selfMean, selfMin: Math.min(...sims), count: embs.length };
}

function decide(profile, emb, strictness = 'normal') {
  const threshold = THRESHOLDS[strictness] ?? THRESHOLDS.normal;
  const score = cosine(Float32Array.from(profile.vec), emb);
  return { ok: score >= threshold, score, threshold };
}

const api = { cosine, meanVector, speechOnly, enrollmentChunks, buildProfile, decide, THRESHOLDS, MIN_SPEECH_SEC, CHUNK_SEC, SAMPLE_RATE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else (globalThis.CEVoice = globalThis.CEVoice || {}).voiceid = api;
})();
