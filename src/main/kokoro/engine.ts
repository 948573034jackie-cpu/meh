import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { InferenceSession as OrtSession, Tensor as OrtTensor } from 'onnxruntime-node';
import { downloadModel, presentVariant, DEFAULT_VARIANT, MODEL_FILES, VOICES_FILE, MODEL_VERSION, type ModelVariant, type DownloadProgress } from './download';
import { textToChunks, defaultPhonemizer, espeakLang, MAX_TOKENS, PAD_TOKEN, type Phonemizer } from './phonemes';
import { wordTimes, trimRange, type WordTime } from './align';
import { encodeWav, decodeWav } from './wav';
import { readVoicesNpz } from './npz';
import { DEFAULT_VOICE, isKnownVoice } from './voices';

export const SAMPLE_RATE = 24000;

export interface SynthesizeOptions { voice?: string; speed?: number }

export interface SynthesisResult {
  pcm: Float32Array | Int16Array;
  sampleRate: 24000;
  /** per-word times in seconds, with offsets into the text given to synthesize() */
  words: WordTime[];
  durationSec: number;
  /** the same audio as a WAV file (16-bit PCM), ready to send to the renderer or write to disk */
  wav: Buffer;
  phonemes: string;
  fromCache: boolean;
}

export type EngineState = 'missing' | 'downloading' | 'loading' | 'ready' | 'error';

export interface EngineStatus {
  state: EngineState;
  variant: ModelVariant;
  modelDir: string;
  /** bytes to download for the configured variant (model + voices) */
  downloadBytes: number;
  progress: DownloadProgress | null;
  error: string | null;
  /** how many sentences are waiting in the prefetch queue */
  queued: number;
  version: string;
}

export interface KokoroEngineOptions {
  modelDir: string;
  cacheDir: string;
  variant?: ModelVariant;
  /** ORT intra-op threads; default: cores - 1, between 2 and 4 */
  threads?: number;
  phonemizer?: Phonemizer;
  /** sentences kept in memory */
  memoryEntries?: number;
  /** disk cache size cap in bytes (oldest files pruned); default 300 MB */
  diskBytes?: number;
  log?: (msg: string) => void;
}

interface Job { key: string; text: string; voice: string; speed: number; priority: number; resolve: (r: SynthesisResult) => void; reject: (e: Error) => void }

/**
 * Kokoro-82M running in-process through onnxruntime-node, sentence by sentence, with word timings taken from
 * the model's own duration predictor. Results are cached in memory (LRU) and on disk as WAV + JSON, keyed by
 * sha1(text, voice, speed, model version). `prepare()` queues sentences to synthesize ahead of time; a
 * `synthesize()` call always jumps the queue. Only one inference runs at a time (ORT uses its own thread pool).
 */
export class KokoroEngine {
  readonly modelDir: string;
  readonly cacheDir: string;
  readonly variant: ModelVariant;
  private threads: number;
  private phonemizer: Phonemizer | null;
  private session: OrtSession | null = null;
  private ort: typeof import('onnxruntime-node') | null = null;
  private voices: Map<string, Float32Array> | null = null;
  private readyPromise: Promise<void> | null = null;
  private downloadPromise: Promise<void> | null = null;
  private downloadAbort: AbortController | null = null;
  private progress: DownloadProgress | null = null;
  private lastError: string | null = null;
  private memory = new Map<string, SynthesisResult>();
  private memoryEntries: number;
  private diskBytes: number;
  private queue: Job[] = [];
  private inflight = new Map<string, Promise<SynthesisResult>>();
  private running = false;
  private seq = 0;
  private log: (msg: string) => void;
  /** notified on every status change (download progress, state changes) */
  onStatus: ((s: EngineStatus) => void) | null = null;

  constructor(opts: KokoroEngineOptions) {
    this.modelDir = opts.modelDir;
    this.cacheDir = opts.cacheDir;
    this.variant = opts.variant ?? (process.env.KOKORO_VARIANT as ModelVariant) ?? DEFAULT_VARIANT;
    this.threads = opts.threads ?? Math.max(2, Math.min(4, os.cpus().length - 1));
    this.phonemizer = opts.phonemizer ?? null;
    this.memoryEntries = opts.memoryEntries ?? 48;
    this.diskBytes = opts.diskBytes ?? 300 * 1024 * 1024;
    this.log = opts.log ?? (() => undefined);
  }

  /** The variant actually on disk (the configured one, or any complete one), else null. */
  get installedVariant(): ModelVariant | null { return presentVariant(this.modelDir, this.variant); }

  status(): EngineStatus {
    const installed = this.installedVariant;
    const state: EngineState = this.downloadPromise ? 'downloading' : this.lastError ? 'error' : this.session ? 'ready' : this.readyPromise ? 'loading' : installed ? 'ready' : 'missing';
    return {
      state, variant: installed ?? this.variant, modelDir: this.modelDir,
      downloadBytes: MODEL_FILES[this.variant].size + VOICES_FILE.size,
      progress: this.progress, error: this.lastError, queued: this.queue.length, version: MODEL_VERSION,
    };
  }

  private emit(): void { try { this.onStatus?.(this.status()); } catch { /* listener errors are not ours */ } }

  /** Downloads the model files if they are missing. Safe to call repeatedly; resumes partial files. */
  download(): Promise<void> {
    if (this.installedVariant) return Promise.resolve();
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadAbort = new AbortController();
    this.lastError = null;
    this.downloadPromise = downloadModel(this.modelDir, this.variant, (p) => { this.progress = p; this.emit(); }, this.downloadAbort.signal)
      .catch((e) => { this.lastError = (e as Error).message; throw e; })
      .finally(() => { this.downloadPromise = null; this.downloadAbort = null; this.progress = null; this.emit(); });
    this.emit();
    return this.downloadPromise;
  }

  cancelDownload(): void { this.downloadAbort?.abort(); }

  /** Loads the ONNX session, voices and espeak (downloading first when `autoDownload`). */
  ensureReady(autoDownload = true): Promise<void> {
    if (this.session) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      if (!this.installedVariant) {
        if (!autoDownload) throw new Error('The Kokoro voice model has not been downloaded yet.');
        await this.download();
      }
      const variant = this.installedVariant;
      if (!variant) throw new Error('Kokoro model files are missing.');
      this.emit();
      const t0 = Date.now();
      const ort = await import('onnxruntime-node');
      this.ort = ort;
      const modelPath = path.join(this.modelDir, MODEL_FILES[variant].name);
      const [session, voices, phonemizer] = await Promise.all([
        ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: this.threads, interOpNumThreads: 1, logSeverityLevel: 3 }),
        fs.promises.readFile(path.join(this.modelDir, VOICES_FILE.name)).then(readVoicesNpz),
        this.phonemizer ? Promise.resolve(this.phonemizer) : defaultPhonemizer(),
      ]);
      if (!session.inputNames.includes('input_ids') || !session.outputNames.includes('duration')) throw new Error('Kokoro model has no duration output; word timing needs the kokoro-onnx model-files-v1.1 export.');
      this.session = session; this.voices = voices; this.phonemizer = phonemizer;
      this.lastError = null;
      this.log(`kokoro: ${variant} model loaded in ${Date.now() - t0} ms (${this.threads} threads, ${voices.size} voices)`);
      this.emit();
    })().catch((e) => { this.lastError = (e as Error).message; this.readyPromise = null; this.emit(); throw e; });
    return this.readyPromise;
  }

  async release(): Promise<void> { await this.session?.release(); this.session = null; this.readyPromise = null; }

  cacheKey(text: string, voice: string, speed: number): string {
    return crypto.createHash('sha1').update(`${MODEL_VERSION}\0${voice}\0${speed.toFixed(2)}\0${text}`).digest('hex');
  }

  /** Path of the cached WAV for a sentence (exists only after synthesis). */
  wavPath(text: string, voice: string, speed: number): string { return path.join(this.cacheDir, `${this.cacheKey(text, voice, speed)}.wav`); }

  /** Synthesizes one sentence (or short text); returns the cached result when available. */
  synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesisResult> {
    return this.enqueue(text, opts, 1);
  }

  /** Queues sentences to synthesize in the background, in order; later synthesize() calls hit the cache. */
  prepare(items: { text: string; voice?: string; speed?: number }[]): void {
    for (const it of items) this.enqueue(it.text, it, 0).catch((e) => this.log(`kokoro: prefetch failed: ${(e as Error).message}`));
    this.emit();
  }

  private enqueue(rawText: string, opts: SynthesizeOptions, priority: number): Promise<SynthesisResult> {
    const text = rawText.trim();
    const voice = opts.voice && isKnownVoice(opts.voice) ? opts.voice : DEFAULT_VOICE;
    const speed = Math.min(2, Math.max(0.5, opts.speed ?? 1));
    const key = this.cacheKey(text, voice, speed);
    const hit = this.memory.get(key);
    if (hit) { this.memory.delete(key); this.memory.set(key, hit); return Promise.resolve(hit); }
    const flying = this.inflight.get(key);
    if (flying) {
      if (priority > 0) { const j = this.queue.find((q) => q.key === key); if (j) j.priority = priority; this.sortQueue(); }
      return flying;
    }
    const p = new Promise<SynthesisResult>((resolve, reject) => {
      this.queue.push({ key, text, voice, speed, priority, resolve, reject });
      this.sortQueue();
      void this.pump();
    });
    this.inflight.set(key, p);
    p.finally(() => this.inflight.delete(key)).catch(() => undefined);
    return p;
  }

  private sortQueue(): void { this.queue.sort((a, b) => b.priority - a.priority); }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try { job.resolve(await this.produce(job)); } catch (e) { job.reject(e as Error); }
        this.emit();
      }
    } finally { this.running = false; }
  }

  private async produce(job: Job): Promise<SynthesisResult> {
    const disk = await this.readDisk(job.key);
    if (disk) { this.remember(job.key, disk); return disk; }
    await this.ensureReady();
    const res = await this.run(job.text, job.voice, job.speed);
    this.remember(job.key, res);
    this.writeDisk(job.key, res).catch((e) => this.log(`kokoro: cache write failed: ${(e as Error).message}`));
    return res;
  }

  private remember(key: string, res: SynthesisResult): void {
    this.memory.set(key, res);
    while (this.memory.size > this.memoryEntries) this.memory.delete(this.memory.keys().next().value as string);
  }

  private async run(text: string, voice: string, speed: number): Promise<SynthesisResult> {
    const ort = this.ort!; const session = this.session!;
    const style = this.voices!.get(voice) ?? this.voices!.get(DEFAULT_VOICE);
    if (!style) throw new Error(`Kokoro voice "${voice}" is not in the voices file.`);
    const chunks = await textToChunks(text, espeakLang(voice), this.phonemizer!);
    const parts: Float32Array[] = [];
    const words: WordTime[] = [];
    let total = 0;
    let phonemes = '';
    for (const chunk of chunks) {
      if (!chunk.tokens.length) continue;
      const n = Math.min(chunk.tokens.length, MAX_TOKENS);
      const ids = [PAD_TOKEN, ...chunk.tokens.slice(0, n), PAD_TOKEN];
      const row = Math.min(n, MAX_TOKENS) - 1;
      const feeds: Record<string, OrtTensor> = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
        style: new ort.Tensor('float32', style.slice(row * 256, row * 256 + 256), [1, 256]),
        speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
      };
      const out = await session.run(feeds);
      const wave = out.waveform.data as Float32Array;
      const durations = out.duration.data as BigInt64Array;
      const [s, e] = trimRange(durations, chunk.tokens, wave.length, SAMPLE_RATE);
      words.push(...wordTimes(durations, chunk.owner, chunk.words, wave.length, SAMPLE_RATE, total - s));
      parts.push(wave.subarray(s, e));
      total += e - s;
      phonemes += (phonemes ? ' ' : '') + chunk.phonemes;
    }
    const pcm = new Float32Array(total);
    let off = 0;
    for (const p of parts) { pcm.set(p, off); off += p.length; }
    for (const w of words) { w.start = Math.max(0, Math.min(w.start, total / SAMPLE_RATE)); w.end = Math.max(w.start, Math.min(w.end, total / SAMPLE_RATE)); }
    return { pcm, sampleRate: SAMPLE_RATE, words, durationSec: total / SAMPLE_RATE, wav: encodeWav(pcm, SAMPLE_RATE), phonemes, fromCache: false };
  }

  private async readDisk(key: string): Promise<SynthesisResult | null> {
    const wavFile = path.join(this.cacheDir, `${key}.wav`);
    const jsonFile = path.join(this.cacheDir, `${key}.json`);
    try {
      const [wav, meta] = await Promise.all([fs.promises.readFile(wavFile), fs.promises.readFile(jsonFile, 'utf8')]);
      const info = JSON.parse(meta) as { version: string; words: WordTime[]; durationSec: number; phonemes: string };
      if (info.version !== MODEL_VERSION) return null;
      const { pcm } = decodeWav(wav);
      const now = new Date();
      fs.utimes(wavFile, now, now, () => undefined);
      return { pcm, sampleRate: SAMPLE_RATE, words: info.words, durationSec: info.durationSec, wav, phonemes: info.phonemes, fromCache: true };
    } catch { return null; }
  }

  private async writeDisk(key: string, res: SynthesisResult): Promise<void> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    const tmp = path.join(this.cacheDir, `${key}.${process.pid}.tmp`);
    await fs.promises.writeFile(tmp, res.wav);
    await fs.promises.rename(tmp, path.join(this.cacheDir, `${key}.wav`));
    await fs.promises.writeFile(path.join(this.cacheDir, `${key}.json`), JSON.stringify({ version: MODEL_VERSION, words: res.words, durationSec: res.durationSec, phonemes: res.phonemes }));
    if (++this.seq % 25 === 0) this.pruneDisk().catch(() => undefined);
  }

  /** Keeps the disk cache under `diskBytes` by removing the least recently used sentences. */
  async pruneDisk(): Promise<void> {
    const names = await fs.promises.readdir(this.cacheDir).catch(() => [] as string[]);
    const wavs = await Promise.all(names.filter((n) => n.endsWith('.wav')).map(async (n) => { const st = await fs.promises.stat(path.join(this.cacheDir, n)); return { n, size: st.size, at: st.mtimeMs }; }));
    let total = wavs.reduce((s, w) => s + w.size, 0);
    wavs.sort((a, b) => a.at - b.at);
    for (const w of wavs) {
      if (total <= this.diskBytes) break;
      await fs.promises.rm(path.join(this.cacheDir, w.n), { force: true });
      await fs.promises.rm(path.join(this.cacheDir, w.n.replace(/\.wav$/, '.json')), { force: true });
      total -= w.size;
    }
  }
}
