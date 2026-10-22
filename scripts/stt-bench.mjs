// Benchmarks the local speech-to-text engine (src/main/stt) outside Electron: bundles the STT and Kokoro
// engines with esbuild, downloads the models if missing (STT_MODEL_DIR, default ~/.cache/readalong/stt;
// KOKORO_MODEL_DIR, default ~/.cache/readalong/kokoro), synthesises three sentences and the three voice
// commands with Kokoro, streams them (padded with silence, 20 ms Int16 frames at 16 kHz) through
// SttEngine.pushAudio so the VAD, the partials and the finals are all exercised, and prints word error rate,
// latency (final transcript after the last speech frame, decode time) and the command classification.
//   node scripts/stt-bench.mjs [--variant moonshine-base|moonshine-tiny|parakeet-v3] [--threads N] [--voice bf_emma] [--speed 1]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const variant = arg('variant', process.env.STT_VARIANT || 'moonshine-base');
const threads = Number(arg('threads', Math.max(2, Math.min(4, os.cpus().length - 1))));
const voice = arg('voice', 'bf_emma');
const speed = Number(arg('speed', 1));
const sttDir = process.env.STT_MODEL_DIR || path.join(os.homedir(), '.cache', 'readalong', 'stt');
const kokoroDir = process.env.KOKORO_MODEL_DIR || path.join(os.homedir(), '.cache', 'readalong', 'kokoro');
const bundle = path.join(root, 'dist', 'stt-bench.cjs');

fs.mkdirSync(path.dirname(bundle), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export { SttEngine } from './src/main/stt/engine'; export { KokoroEngine } from './src/main/kokoro/engine'; export { resampleLinear, float32ToInt16 } from './src/core/voice/audio'; export { detectCommand, normalize } from './src/core/voice/commands';`,
    resolveDir: root, loader: 'ts',
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['onnxruntime-node', 'sherpa-onnx-node', 'phonemizer', 'jszip'], logLevel: 'warning',
  alias: { '@core': path.join(root, 'src/core'), '@shared': path.join(root, 'src/shared') },
});
const { SttEngine, KokoroEngine, resampleLinear, float32ToInt16, detectCommand, normalize } = await import(pathToFileURL(bundle).href);

console.log(`CPU: ${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length} (${os.arch()}, ${os.platform()}), Node ${process.version}`);
console.log(`stt: ${variant}, threads ${threads}, model dir ${sttDir}; kokoro voice ${voice} speed ${speed}, model dir ${kokoroDir}`);

function progressLogger(label) {
  let last = -1;
  return (s) => {
    if (s.state !== 'downloading' || !s.progress) return;
    const p = s.progress;
    const pct = p.phase === 'extract' ? Math.floor((p.received / p.total) * 100) : Math.floor((p.overallReceived / Math.max(1, p.overallTotal)) * 100);
    if (pct !== last) { last = pct; process.stdout.write(`\r${label} ${p.phase ?? 'download'} ${p.file} ${pct}%   `); }
  };
}

const kokoro = new KokoroEngine({ modelDir: kokoroDir, cacheDir: path.join(os.tmpdir(), 'stt-bench-tts'), persist: false, warmUp: false, log: () => undefined });
kokoro.onStatus = progressLogger('kokoro');
const stt = new SttEngine({ modelDir: sttDir, variant, threads, log: (m) => process.env.STT_BENCH_VERBOSE && console.log(m) });
stt.on('status', progressLogger('stt'));
try {
  await kokoro.download();
  await stt.download();
} catch (e) { console.error(`\nDOWNLOAD FAILED: ${e.message}`); process.exit(2); }
console.log('');
let t = Date.now();
await stt.ensureReady(false);
console.log(`stt model load: ${Date.now() - t} ms, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
t = Date.now();
await kokoro.ensureReady(false);
console.log(`kokoro model load: ${Date.now() - t} ms`);

const sentences = [
  'The quick brown fox jumps over the lazy dog, while the farmer sleeps soundly in his barn.',
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.',
  'Could you explain what the word reluctant means in this sentence?',
];
const commands = [['I know', 'know'], ["I don't know", 'dont_know'], ['Bye bye', 'bye']];

const words = (s) => normalize(s).split(' ').filter(Boolean);
function wer(ref, hyp) {
  const r = words(ref), h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => { const row = new Array(h.length + 1).fill(0); row[0] = i; return row; });
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], words: r.length };
}

/** Streams one utterance through a fresh session; returns the events and timings. */
async function run(text, id) {
  const tts = await kokoro.synthesize(text, { voice, speed });
  const pcm16k = resampleLinear(tts.pcm instanceof Float32Array ? tts.pcm : Float32Array.from(tts.pcm, (v) => v / 32768), tts.sampleRate, 16000);
  const lead = 8000, tail = 16000; // 0.5 s of silence before, 1 s after
  const audio = new Float32Array(lead + pcm16k.length + tail);
  audio.set(pcm16k, lead);
  const int16 = float32ToInt16(audio);
  const events = [];
  const t0 = Date.now();
  let speechPushedAt = null, firstPartialAt = null, finalAt = null;
  const off = stt.on('event', (e) => { if (e.sessionId !== id) return; const at = Date.now(); events.push({ ...e, at }); if (e.type === 'partial' && firstPartialAt === null) firstPartialAt = at; if (e.type === 'final') finalAt = at; });
  await stt.start(id, { sampleRate: 16000 });
  const frame = 320; // 20 ms
  const speechEnd = lead + pcm16k.length;
  for (let i = 0; i < int16.length; i += frame) {
    await stt.pushAudio(id, int16.subarray(i, Math.min(i + frame, int16.length)));
    if (i < speechEnd) speechPushedAt = Date.now();
  }
  const pushMs = Date.now() - t0;
  await stt.stop(id);
  off();
  const finals = events.filter((e) => e.type === 'final');
  const one = await stt.recognizeSamples(pcm16k, 16000);
  return { text, audioSec: pcm16k.length / 16000, pushMs, finals: finals.map((f) => f.text), partials: events.filter((e) => e.type === 'partial').length,
    starts: events.filter((e) => e.type === 'speechStart').length, firstPartialMs: firstPartialAt === null ? null : firstPartialAt - t0,
    finalAfterSpeechMs: finalAt === null || speechPushedAt === null ? null : finalAt - speechPushedAt, decodeMs: one.decodeMs, oneShot: one.text, confidence: one.confidence };
}

const rows = [];
let totalErr = 0, totalWords = 0;
for (const [i, s] of sentences.entries()) {
  const r = await run(s, `sent${i}`);
  const hyp = r.finals.join(' ');
  const w = wer(s, hyp);
  totalErr += w.errors; totalWords += w.words;
  rows.push({ sentence: i + 1, audioSec: +r.audioSec.toFixed(2), segments: r.starts, partials: r.partials, wordErrors: `${w.errors}/${w.words}`, finalAfterSpeechMs: r.finalAfterSpeechMs, decodeMs: r.decodeMs, conf: r.confidence === undefined ? '-' : r.confidence.toFixed(2) });
  console.log(`\n[${i + 1}] ref: ${s}\n    vad: ${JSON.stringify(hyp)}\n    one-shot: ${JSON.stringify(r.oneShot)}`);
}
console.table(rows);
console.log(`WER over ${totalWords} words: ${((100 * totalErr) / totalWords).toFixed(1)}%`);
console.log('(finalAfterSpeechMs = time from pushing the last speech frame to the final event when streaming as fast as possible: VAD tail (600 ms of silence) is consumed in ~0 ms here, so this is mostly decode time + queueing; in real time add the 600 ms silence wait)');

console.log('\ncommands:');
const crow = [];
for (const [i, [phrase, intent]] of commands.entries()) {
  const r = await run(phrase, `cmd${i}`);
  const hyp = r.finals.join(' ');
  const det = detectCommand(hyp, { confidence: r.confidence });
  crow.push({ phrase, heard: hyp, intent: det.intent, ok: det.intent === intent, score: +det.score.toFixed(2), audioSec: +r.audioSec.toFixed(2), finalAfterSpeechMs: r.finalAfterSpeechMs, decodeMs: r.decodeMs });
}
console.table(crow);
console.log(`commands detected: ${crow.filter((c) => c.ok).length}/${crow.length}; rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
await stt.release();
await kokoro.release();
