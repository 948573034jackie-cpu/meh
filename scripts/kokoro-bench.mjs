// Benchmarks the local Kokoro voice (src/main/kokoro) outside Electron: bundles the engine with esbuild,
// downloads the model into KOKORO_MODEL_DIR (default ~/.cache/readalong/kokoro) if missing, synthesizes three
// sentences and prints the real-time factor (synthesis seconds / audio seconds), first-sentence latency and
// the word timings of the first sentence. WAV files are written to KOKORO_BENCH_OUT (default: the model dir).
//   node scripts/kokoro-bench.mjs [--variant fp16|fp32|int8] [--threads N] [--voice bf_emma] [--runs 2] [--warm-up]
// (--warm-up runs the engine's warm-up inference after loading, as the app does; without it the first
//  sentence shows the cold-start cost)
//
// Playback simulation (what the learner hears):
//   node scripts/kokoro-bench.mjs --sim [--policy app|legacy] [--inline]
// reads 10 consecutive sentences of Pride and Prejudice "in real time": every sentence plays for its audio
// duration plus the 250 ms pause between sentences, and the requests are issued the way the app issues them.
//   legacy: what the app did before (Playback asks for sentence n and prefetches n+1, n+2 through
//           tts:synthesize when sentence n starts, ReaderView prepares n+1..n+5, one inference at a time on
//           the main thread, whole sentences)
//   app:    the current renderer + engine behaviour (long sentences in clause segments, the next sentence
//           fetched as soon as the current one is ready, a priority read-ahead of ~60 s / 8 sentences that
//           replaces itself at every sentence, inference in a worker thread)
// It reports time to first audio, every gap > 300 ms (silence beyond the configured pause) and the worst
// main-thread stall (the Electron main process answers IPC on this thread: a stall delays every reply).
//   --long: time to first audio for one long sentence (whole sentence vs first segment).
//   --inline: run inference on the calling thread (the pre-worker behaviour) instead of the worker.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const flag = (name) => process.argv.includes(`--${name}`);
const variant = arg('variant', process.env.KOKORO_VARIANT || 'fp16');
const threadsArg = arg('threads', null);
const voice = arg('voice', 'bf_emma');
const runs = Number(arg('runs', 2));
const policy = arg('policy', 'app');
const modelDir = process.env.KOKORO_MODEL_DIR || path.join(os.homedir(), '.cache', 'readalong', 'kokoro');
const outDir = process.env.KOKORO_BENCH_OUT || modelDir;
const bundle = path.join(root, 'dist', 'kokoro-bench.cjs');

fs.mkdirSync(path.dirname(bundle), { recursive: true });
const segmentsTs = path.join(root, 'src/core/tts/segments.ts');
await esbuild.build({
  stdin: {
    contents: `export * from './src/main/kokoro/engine';${fs.existsSync(segmentsTs) ? `\nexport { synthesisSegments } from './src/core/tts/segments';` : ''}`,
    resolveDir: root, loader: 'ts',
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['onnxruntime-node', 'phonemizer', 'jszip'], logLevel: 'warning',
  alias: { '@core': path.join(root, 'src/core'), '@shared': path.join(root, 'src/shared') },
});
const mod = await import(pathToFileURL(bundle).href);
const { KokoroEngine } = mod;
const synthesisSegments = mod.synthesisSegments ?? ((t) => [{ text: t, start: 0 }]);

const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
console.log(`CPU: ${cpu} x${os.cpus().length} (${os.arch()}, ${os.platform()}), Node ${process.version}`);

const engineOpts = { modelDir, cacheDir: path.join(os.tmpdir(), 'kokoro-bench-cache'), variant, persist: false, warmUp: flag('warm-up') || flag('sim') || flag('long'), log: (m) => console.log(m) };
if (threadsArg) engineOpts.threads = Number(threadsArg);
if (flag('inline')) engineOpts.inference = 'inline';
const engine = new KokoroEngine(engineOpts);
let lastPct = -1;
engine.onStatus = (s) => {
  if (s.state === 'downloading' && s.progress) {
    const pct = Math.floor((s.progress.overallReceived / s.progress.overallTotal) * 100);
    if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\rdownloading ${s.progress.file} ${pct}%   `); }
  }
};
if (!engine.installedVariant) { console.log(`downloading model files (${(engine.status().downloadBytes / 1e6).toFixed(0)} MB) ...`); }
try { await engine.download(); } catch (e) { console.error(`\nDOWNLOAD FAILED: ${e.message}`); process.exit(2); }
console.log('');

// ---- main-thread stall monitor: a 10 ms interval that records how late it fires ----
let maxLag = 0; let lagOver300 = 0;
let lastTick = performance.now();
const lagTimer = setInterval(() => { const now = performance.now(); const lag = now - lastTick - 10; if (lag > maxLag) maxLag = lag; if (lag > 300) lagOver300++; lastTick = now; }, 10);
lagTimer.unref();
const resetLag = () => { maxLag = 0; lagOver300 = 0; lastTick = performance.now(); };

let t = Date.now();
await engine.ensureReady(false);
const loadMs = Date.now() - t;
console.log(`model: ${variant}, voice: ${voice}, model load (incl. warm-up when on): ${loadMs} ms, main-thread stall during load: ${maxLag.toFixed(0)} ms`);

const PRIDE = [
  'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.',
  'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.',
  '“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”',
  'Mr. Bennet replied that he had not.',
  '“But it is,” returned she; “for Mrs. Long has just been here, and she told me all about it.”',
  'Mr. Bennet made no answer.',
  '“Do you not want to know who has taken it?” cried his wife impatiently.',
  '“You want to tell me, and I have no objection to hearing it.”',
  'This was invitation enough.',
  '“Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it, that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week.”',
];
const PAUSE_MS = 250;
const now = () => performance.now();
const sleepUntil = (at) => new Promise((r) => setTimeout(r, Math.max(0, at - now())));
/** an IPC reply reaches the renderer only when the main thread is free: model it with a macrotask hop */
const ipc = (p) => p.then((v) => new Promise((r) => setImmediate(() => r(v))));

if (flag('sim')) await simulate();
else if (flag('long')) await longSentence();
else await classic();
clearInterval(lagTimer);
await engine.release();
process.exit(0);

async function longSentence() {
  const text = PRIDE[9];
  const segs = synthesisSegments(text);
  console.log(`long sentence: ${text.length} chars, ${segs.length} segment(s): ${segs.map((s) => s.text.length).join(' + ')} chars`);
  for (let r = 0; r < runs; r++) {
    engine.clearMemory();
    resetLag();
    let t0 = now();
    const first = await engine.synthesize(segs[0].text, { voice, speed: 1 });
    const firstMs = now() - t0;
    t0 = now();
    engine.clearMemory();
    const whole = await engine.synthesize(text, { voice, speed: 1 });
    const wholeMs = now() - t0;
    console.log(`run ${r + 1}: time to first audio ${segs.length > 1 ? 'with segments' : '(one segment)'}: ${firstMs.toFixed(0)} ms (first segment ${first.durationSec.toFixed(1)} s of audio); whole sentence in one request: ${wholeMs.toFixed(0)} ms for ${whole.durationSec.toFixed(1)} s of audio; worst main-thread stall ${maxLag.toFixed(0)} ms`);
  }
}

async function simulate() {
  console.log(`simulated reading, policy: ${policy}, ${PRIDE.length} sentences, pause ${PAUSE_MS} ms`);
  engine.clearMemory();
  resetLag();
  const cache = new Map(); // the renderer's request cache (AudioTtsEngine)
  const fetch = (text) => { let p = cache.get(text); if (!p) { p = ipc(engine.synthesize(text, { voice, speed: 1 })); cache.set(text, p); } return p; };
  const gaps = [];
  let ttfa = 0;
  const tStart = now();
  let due = tStart; // when the next audio should start (previous end + pause)
  for (let n = 0; n < PRIDE.length; n++) {
    await sleepUntil(due - (n === 0 ? 0 : PAUSE_MS)); // Playback asks for sentence n when n-1 has ended
    const asked = now();
    // ReaderView.prepareAhead (unchanged): the next five sentences, low priority, appended
    engine.prepare(PRIDE.slice(n + 1, n + 6).map((text) => ({ text, voice, speed: 1 })));
    let segs;
    if (policy === 'legacy') {
      segs = [{ text: PRIDE[n] }];
      for (const s of PRIDE.slice(n + 1, n + 3)) void fetch(s).catch(() => undefined);
    } else {
      segs = synthesisSegments(PRIDE[n]);
      // Playback.prefetchAhead -> AudioTtsEngine.readAhead: the next sentence is fetched once this one is ready,
      // the rest (up to ~60 s / 8 sentences) goes to the main-process read-ahead queue by distance
      const ahead = [];
      let secs = 0;
      for (let d = 1; n + d < PRIDE.length && d <= 8 && secs < 60; d++) { ahead.push({ text: PRIDE[n + d], d }); secs += PRIDE[n + d].length / 15; }
      const segsOf = (text) => synthesisSegments(text).map((s) => s.text);
      const items = [];
      for (const a of ahead) for (const s of segsOf(a.text)) items.push({ text: s, voice, speed: 1, priority: 60 - a.d });
      engine.prepare(items, { replace: true });
      const nextText = ahead[0]?.text;
      const mine = Promise.all(segs.map((s) => fetch(s.text)));
      if (nextText) void mine.then(() => segsOf(nextText).forEach((s) => void fetch(s).catch(() => undefined)));
    }
    // play segment after segment; each one must be ready when the previous one ends
    for (let k = 0; k < segs.length; k++) {
      const res = await fetch(segs[k].text);
      const ready = now();
      const want = k === 0 ? (n === 0 ? asked : due) : due;
      const late = Math.max(0, ready - want);
      if (n === 0 && k === 0) ttfa = ready - asked;
      else if (late > 300) gaps.push({ sentence: n + 1, segment: k + 1, gapMs: Math.round(late) });
      const startAt = Math.max(ready, want);
      due = startAt + res.durationSec * 1000 + (k === segs.length - 1 ? PAUSE_MS : 0);
      if (k < segs.length - 1) await sleepUntil(due);
    }
  }
  await sleepUntil(due);
  const total = (now() - tStart) / 1000;
  console.log(`time to first audio: ${ttfa.toFixed(0)} ms`);
  console.log(gaps.length ? `gaps > 300 ms: ${gaps.map((g) => `sentence ${g.sentence}${g.segment > 1 ? ` (segment ${g.segment})` : ''}: ${g.gapMs} ms`).join(', ')}` : 'gaps > 300 ms: none');
  console.log(`total silence beyond the pauses: ${(gaps.reduce((s, g) => s + g.gapMs, 0) / 1000).toFixed(1)} s; listening took ${total.toFixed(1)} s; worst main-thread stall ${maxLag.toFixed(0)} ms (${lagOver300} stalls > 300 ms)`);
}

async function classic() {
  const sentences = [
    'The quick brown fox jumps over the lazy dog, while the farmer sleeps soundly in his barn.',
    'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.',
    'Mr. Darcy paid £5.50 for the newspaper in 1999, and read it until 10:30.',
  ];
  let first = null;
  const rows = [];
  for (let r = 0; r < runs; r++) {
    for (const [i, text] of sentences.entries()) {
      t = Date.now();
      const res = await engine.synthesize(text, { voice, speed: 1 });
      const ms = Date.now() - t;
      if (first === null) first = ms;
      rows.push({ run: r + 1, sentence: i + 1, words: res.words.length, audioSec: +res.durationSec.toFixed(2), synthMs: ms, rtf: +(ms / 1000 / res.durationSec).toFixed(3) });
      if (r === 0) fs.writeFileSync(path.join(outDir, `bench-${i + 1}-${voice}.wav`), res.wav);
      if (r === 0 && i === 0) console.log('words:', res.words.map((w) => `${text.slice(w.charIndex, w.charIndex + w.charLength)}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(' '));
      if (r === 0 && i === 2) console.log('phonemes (3):', res.phonemes);
      engine.clearMemory(); // fresh synthesis every time
    }
  }
  console.table(rows);
  const best = rows.slice(-sentences.length);
  const rtf = best.reduce((s, r) => s + r.synthMs, 0) / 1000 / best.reduce((s, r) => s + r.audioSec, 0);
  console.log(`first-sentence latency (after load${flag('warm-up') ? ', warmed up' : ', cold ORT'}): ${first} ms; model load ${loadMs} ms`);
  console.log(`overall RTF (last run): ${rtf.toFixed(3)}  (${rtf < 1 ? (1 / rtf).toFixed(1) + 'x faster than real time' : 'SLOWER than real time'}); worst main-thread stall ${maxLag.toFixed(0)} ms`);
}
