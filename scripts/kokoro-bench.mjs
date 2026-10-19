// Benchmarks the local Kokoro voice (src/main/kokoro) outside Electron: bundles the engine with esbuild,
// downloads the model into KOKORO_MODEL_DIR (default ~/.cache/readalong/kokoro) if missing, synthesizes three
// sentences and prints the real-time factor (synthesis seconds / audio seconds), first-sentence latency and
// the word timings of the first sentence. WAV files are written to KOKORO_BENCH_OUT (default: the model dir).
//   node scripts/kokoro-bench.mjs [--variant fp16|fp32|int8] [--threads N] [--voice bf_emma] [--runs 2]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const variant = arg('variant', process.env.KOKORO_VARIANT || 'fp16');
const threads = Number(arg('threads', Math.max(2, Math.min(4, os.cpus().length - 1))));
const voice = arg('voice', 'bf_emma');
const runs = Number(arg('runs', 2));
const modelDir = process.env.KOKORO_MODEL_DIR || path.join(os.homedir(), '.cache', 'readalong', 'kokoro');
const outDir = process.env.KOKORO_BENCH_OUT || modelDir;
const bundle = path.join(root, 'dist', 'kokoro-bench.cjs');

fs.mkdirSync(path.dirname(bundle), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/main/kokoro/engine.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['onnxruntime-node', 'phonemizer', 'jszip'], logLevel: 'warning',
  alias: { '@core': path.join(root, 'src/core'), '@shared': path.join(root, 'src/shared') },
});
const { KokoroEngine } = await import(pathToFileURL(bundle).href);

const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
console.log(`CPU: ${cpu} x${os.cpus().length} (${os.arch()}, ${os.platform()}), Node ${process.version}`);
console.log(`model: ${variant}, threads: ${threads}, voice: ${voice}, model dir: ${modelDir}`);

const engine = new KokoroEngine({ modelDir, cacheDir: path.join(os.tmpdir(), 'kokoro-bench-cache'), variant, threads, log: (m) => console.log(m) });
fs.rmSync(path.join(os.tmpdir(), 'kokoro-bench-cache'), { recursive: true, force: true });
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
let t = Date.now();
await engine.ensureReady(false);
const loadMs = Date.now() - t;
console.log(`model load: ${loadMs} ms`);

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
    if (res.fromCache) { fs.rmSync(path.join(os.tmpdir(), 'kokoro-bench-cache'), { recursive: true, force: true }); r--; break; }
    if (first === null) first = ms;
    rows.push({ run: r + 1, sentence: i + 1, words: res.words.length, audioSec: +res.durationSec.toFixed(2), synthMs: ms, rtf: +(ms / 1000 / res.durationSec).toFixed(3) });
    if (r === 0) fs.writeFileSync(path.join(outDir, `bench-${i + 1}-${voice}.wav`), res.wav);
    if (r === 0 && i === 0) console.log('words:', res.words.map((w) => `${text.slice(w.charIndex, w.charIndex + w.charLength)}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(' '));
    if (r === 0 && i === 2) console.log('phonemes (3):', res.phonemes);
    // fresh synthesis every time: forget the memory and disk cache entry
    engine['memory'].clear();
    fs.rmSync(path.join(os.tmpdir(), 'kokoro-bench-cache'), { recursive: true, force: true });
  }
}
console.table(rows);
const best = rows.slice(-sentences.length);
const rtf = best.reduce((s, r) => s + r.synthMs, 0) / 1000 / best.reduce((s, r) => s + r.audioSec, 0);
console.log(`first-sentence latency (after load, cold ORT): ${first} ms; model load ${loadMs} ms`);
console.log(`overall RTF (last run): ${rtf.toFixed(3)}  (${rtf < 1 ? (1 / rtf).toFixed(1) + 'x faster than real time' : 'SLOWER than real time'})`);
await engine.release();
