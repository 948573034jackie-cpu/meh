import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { Tensor as OrtTensor, InferenceSession } from 'onnxruntime-node';
import { downloadModel, presentVariant, DEFAULT_VARIANT, MODEL_FILES, VOICES_FILE, MODEL_VERSION, type ModelVariant, type DownloadProgress } from './download';
import { textToChunks, defaultPhonemizer, espeakLang, MAX_TOKENS, PAD_TOKEN, type Phonemizer } from './phonemes';
import { wordTimes, trimRange, speechRange, type WordTime } from './align';
import { encodeWav, decodeWav, concatWav } from './wav';
import { readVoicesNpz } from './npz';
import { DEFAULT_VOICE, isKnownVoice } from './voices';
import { synthesisSegments, endPunctOf, pauseAfter, PRIORITY, type EndPunct } from '@core/tts/segments';
import { RecentLog } from '@core/perf';
import type { KokoroPerf, KokoroSegmentStat } from '@shared/api';

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
  /**
   * the punctuation the text ends with: the audio is trimmed to the speech (speechRange), so the renderer adds the
   * pause it calls for before the next segment of the same sentence (SEGMENT_PAUSE_MS)
   */
  endPunct?: EndPunct;
}

/**
 * Part of every cache key: bumped when the audio made for the same text changes, so older files are not reused
 * (they are left to pruneDisk's size limit). trim2 = silence trimmed by energy (speechRange), pauses added on purpose;
 * trim3 = the start found by energy too (trim2 cut 25-90 ms of a word's first consonant).
 */
export const AUDIO_FORMAT = 'trim3';
/**
 * Kokoro's first sound comes up to about 100-125 ms before the end of the leading pad its durations predict: the start
 * is looked for by energy from this long before trimRange's start (which trusts the durations).
 */
const ONSET_SEARCH_SEC = 0.15;
/** a short fade-in where the kept audio starts (no click when it starts inside a sound) */
const FADE_IN_SEC = 0.005;

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
  /** ORT intra-op threads; default: defaultThreads() (physical cores, at most 4), or KOKORO_THREADS */
  threads?: number;
  /** ORT intra-op spinning: undefined = onnxruntime's default (on); default: KOKORO_SPIN ('0' off, '1' on) */
  spin?: '0' | '1';
  /**
   * where the ONNX inference runs: 'worker' (default) is a worker thread, so the Electron main process keeps
   * answering IPC while a sentence is synthesized (onnxruntime-node's session.run and session creation are
   * synchronous and block their thread for seconds); 'inline' runs on the calling thread (KOKORO_INFERENCE=inline).
   * When the worker cannot start, the engine falls back to 'inline'.
   */
  inference?: 'worker' | 'inline';
  /** tests: replaces model loading + inference for one piece of text (the queue, caches and segments stay real) */
  synth?: (text: string, voice: string, speed: number) => Promise<SynthesisResult>;
  phonemizer?: Phonemizer;
  /** sentences kept in memory */
  memoryEntries?: number;
  /** disk cache size cap in bytes (oldest files pruned); default 300 MB */
  diskBytes?: number;
  /** write/read the disk cache (default true); false keeps results in memory only */
  persist?: boolean;
  /** run a short warm-up inference after loading so the first real sentence is not the slow cold one (default true) */
  warmUp?: boolean;
  log?: (msg: string) => void;
}

export interface PrepareItem { text: string; voice?: string; speed?: number; priority?: number }

interface Job {
  key: string; text: string; voice: string; speed: number;
  priority: number;
  /** order among equal priorities (FIFO) */
  seq: number;
  /** synthesize() callers waiting for this result: such a job is never dropped, only demoted */
  waiters: number;
  /** a prepare(..., { wait }) caller is told when it is ready: a read-ahead list does not lower its priority */
  held: boolean;
  /** performance.now() when it was requested at the highest priority asked for (its queue wait, for Diagnostics) */
  queuedAt: number;
  promise: Promise<SynthesisResult>;
  resolve: (r: SynthesisResult) => void; reject: (e: Error) => void;
}

/** onnxruntime-node inference, wherever it runs */
interface Inference {
  run(ids: BigInt64Array, style: Float32Array, speed: number): Promise<{ waveform: Float32Array; duration: BigInt64Array }>;
  release(): Promise<void>;
  readonly where: 'worker' | 'inline';
  /** espeak running next to the model (the worker), so phonemizing does not block the main thread either */
  phonemizer?: Phonemizer;
}

/**
 * ORT intra-op threads: physical cores minus one, at least 2, at most 4. Intel Macs report two logical CPUs per
 * core (Hyper-Threading): a 4-core i5/i7 reports 8, which the old "cores - 1, at most 4" turned into 4 threads on
 * 4 physical cores, leaving nothing for the renderer and the main process. Apple Silicon reports real cores.
 */
export function defaultThreads(cpus = os.cpus().length, arch: string = process.arch, platform: string = process.platform): number {
  const env = Number(process.env.KOKORO_THREADS);
  if (Number.isInteger(env) && env > 0) return env;
  const physical = arch === 'x64' && platform === 'darwin' && cpus >= 4 ? Math.floor(cpus / 2) : cpus;
  // one core is left for the app (renderer, audio, the main process); measured on a 4-vCPU Xeon: 4 threads were not
  // reliably faster than 3 (0.84-1.04 of the time) and 17-40% slower with one other core busy
  const n = physical >= 8 ? 4 : physical - 1;
  return Math.max(2, Math.min(4, n));
}

/**
 * ORT session options for the Kokoro model. `spin` '0' (KOKORO_SPIN=0) turns intra-op spinning off: the pool's threads
 * sleep between operators instead of busy-waiting. Measured on a 4-vCPU Xeon at 3 threads: 13-25% less CPU but 4-16%
 * slower, so it stays on; the switch is for an A/B on the learner's Mac (thermal throttling, a busy 2-core model).
 * `extra` is a plain object, so it survives the structured clone into the worker.
 */
export function kokoroSessionOptions(threads: number, spin?: string): InferenceSession.SessionOptions {
  const base: InferenceSession.SessionOptions = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1, logSeverityLevel: 3 };
  return spin === '0' || spin === '1' ? { ...base, extra: { session: { intra_op: { allow_spinning: spin } } } } : base;
}

/** KOKORO_SPIN as a session option value ('0' / '1'), else undefined (onnxruntime's default: spinning) */
function spinFromEnv(v = process.env.KOKORO_SPIN): '0' | '1' | undefined { return v === '0' || v === '1' ? v : undefined; }

/** synthesized segments kept for Diagnostics (KokoroEngine.perf) */
const PERF_SEGMENTS = 100;

/** removed from the queue by prepare(..., { replace }) / clearReadAhead() / dropTexts() before it ran */
export class DroppedError extends Error { constructor() { super('dropped from the read-ahead queue'); this.name = 'DroppedError'; } }

/**
 * ms a background job (below PRIORITY.next) waits before it starts: a speak() that arrives one IPC message after a
 * read-ahead list (the renderer sends both for the same sentence) is then not stuck behind a job that cannot be
 * interrupted. It costs nothing for what the learner waits for.
 */
const SETTLE_MS = 10;

/**
 * Kokoro-82M through onnxruntime-node (in a worker thread), sentence by sentence, with word timings taken from
 * the model's own duration predictor. Results are cached in memory (LRU) and on disk as WAV + JSON, keyed by
 * sha1(text, voice, speed, model version).
 *
 * Scheduling: one inference runs at a time (ORT has its own thread pool, two at once only slow both down), so the
 * queue order decides what the learner waits for. Every request has a priority (src/core/tts/segments PRIORITY):
 * synthesize() is 'now' (someone is waiting to play it) and always goes before 'next' (the sentence after the one
 * playing) and the read-ahead ('ahead - distance'); equal priorities run in request order. The same text is never
 * synthesized twice: a second request joins the first one and raises its priority. Long texts are split into
 * clause segments (synthesisSegments) that are queued as separate jobs: a running job is never interrupted, so
 * small jobs bound how long a 'now' request can wait behind read-ahead work, and the renderer can start the first
 * segment of a long sentence while the rest is synthesized. prepare(items, { replace: true }) replaces the
 * read-ahead: queued jobs nobody waits for that are not in the new list are dropped (a seek, a pause). That includes
 * the 'soon' jobs of an explanation prepared ahead (prepare(..., { wait })): a Listening stop sends no replace while
 * it runs, and anything that must survive a replace has to be in the same call. Background jobs (below 'next') wait
 * SETTLE_MS before they start, so a 'now' request one IPC message behind them goes first.
 */
export class KokoroEngine {
  readonly modelDir: string;
  readonly cacheDir: string;
  readonly variant: ModelVariant;
  private threads: number;
  private spin: '0' | '1' | undefined;
  private phonemizer: Phonemizer | null;
  private injectedPhonemizer: Phonemizer | null;
  private loaded = false;
  private voices: Map<string, Float32Array> | null = null;
  private readyPromise: Promise<void> | null = null;
  private downloadPromise: Promise<void> | null = null;
  private downloadAbort: AbortController | null = null;
  private progress: DownloadProgress | null = null;
  private lastError: string | null = null;
  private memory = new Map<string, SynthesisResult>();
  private memoryEntries: number;
  private diskBytes: number;
  private persist: boolean;
  private warmUp: boolean;
  private queue: Job[] = [];
  /** queued and running jobs by cache key (dedupe) */
  private jobs = new Map<string, Job>();
  private running: Job | null = null;
  private pumping = false;
  private seq = 0;
  private jobSeq = 0;
  private inferenceMode: 'worker' | 'inline';
  private inference: Inference | null = null;
  private synthOverride: KokoroEngineOptions['synth'] | null;
  private log: (msg: string) => void;
  /** the last synthesized segments, their load and warm-up times (Diagnostics) */
  private perfLog = new RecentLog<KokoroSegmentStat>(PERF_SEGMENTS);
  private loadMs: number | null = null;
  private warmUpMs: number | null = null;
  /** notified on every status change (download progress, state changes) */
  onStatus: ((s: EngineStatus) => void) | null = null;

  constructor(opts: KokoroEngineOptions) {
    this.modelDir = opts.modelDir;
    this.cacheDir = opts.cacheDir;
    this.variant = opts.variant ?? (process.env.KOKORO_VARIANT as ModelVariant) ?? DEFAULT_VARIANT;
    this.threads = opts.threads ?? defaultThreads();
    this.spin = 'spin' in opts ? opts.spin : spinFromEnv();
    this.inferenceMode = opts.inference ?? (process.env.KOKORO_INFERENCE === 'inline' ? 'inline' : 'worker');
    this.synthOverride = opts.synth ?? null;
    this.phonemizer = opts.phonemizer ?? null;
    this.injectedPhonemizer = opts.phonemizer ?? null;
    this.memoryEntries = opts.memoryEntries ?? 96;
    this.diskBytes = opts.diskBytes ?? 300 * 1024 * 1024;
    this.persist = opts.persist ?? true;
    this.warmUp = opts.warmUp ?? true;
    this.log = opts.log ?? (() => undefined);
  }

  /** The variant actually on disk (the configured one, or any complete one), else null. */
  get installedVariant(): ModelVariant | null { return presentVariant(this.modelDir, this.variant); }

  status(): EngineStatus {
    const installed = this.installedVariant;
    const state: EngineState = this.downloadPromise ? 'downloading' : this.lastError ? 'error' : this.loaded ? 'ready' : this.readyPromise ? 'loading' : installed ? 'ready' : 'missing';
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

  /** Loads the ONNX session (in the worker), voices and espeak (downloading first when `autoDownload`), then warms up. */
  ensureReady(autoDownload = true): Promise<void> {
    if (this.loaded) return Promise.resolve();
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
      const modelPath = path.join(this.modelDir, MODEL_FILES[variant].name);
      const [inference, voices, phonemizer] = await Promise.all([
        this.loadInference(modelPath),
        fs.promises.readFile(path.join(this.modelDir, VOICES_FILE.name)).then(readVoicesNpz),
        this.phonemizer ? Promise.resolve(this.phonemizer) : this.inferenceMode === 'worker' ? Promise.resolve(null) : defaultPhonemizer(),
      ]);
      this.inference = inference; this.voices = voices;
      this.phonemizer = phonemizer ?? inference.phonemizer ?? (await defaultPhonemizer());
      this.lastError = null;
      this.loadMs = Date.now() - t0;
      this.log(`kokoro: ${variant} model loaded in ${this.loadMs} ms (${this.threads} threads${this.spin === '0' ? ', spinning off' : ''}, inference in ${inference.where === 'worker' ? 'a worker thread' : 'the main thread'}, ${voices.size} voices)`);
      if (this.warmUp) { const t1 = Date.now(); await this.run('Hello.', DEFAULT_VOICE, 1); this.warmUpMs = Date.now() - t1; this.log(`kokoro: warm-up in ${this.warmUpMs} ms`); }
      this.loaded = true;
      this.emit();
    })().catch((e) => { this.lastError = (e as Error).message; this.readyPromise = null; this.emit(); throw e; });
    return this.readyPromise;
  }

  /** true once the model is loaded and warmed up (the next sentence will not pay the start-up cost) */
  get isLoaded(): boolean { return this.loaded; }

  /** Where inference runs ('worker' unless the worker could not start). */
  get inferenceWhere(): 'worker' | 'inline' { return this.inference?.where ?? this.inferenceMode; }

  /** How the voice runs and its last synthesized segments (Diagnostics; the renderer computes the medians). */
  perf(): KokoroPerf {
    return {
      state: this.status().state, variant: this.installedVariant ?? this.variant, threads: this.threads, spinning: this.spin !== '0',
      inference: this.inferenceWhere, loadMs: this.loadMs, warmUpMs: this.warmUpMs, segments: this.perfLog.toArray(),
    };
  }

  private async loadInference(modelPath: string): Promise<Inference> {
    const sessionOptions = kokoroSessionOptions(this.threads, this.spin);
    if (this.inferenceMode === 'worker') {
      try {
        return await startWorkerInference(modelPath, sessionOptions, () => {
          // the worker died (out of memory, a native crash): load again on the next request
          this.log('kokoro: inference worker exited; it is restarted on the next sentence');
          this.inference = null; this.loaded = false; this.readyPromise = null; this.phonemizer = this.injectedPhonemizer;
        });
      } catch (e) {
        this.log(`kokoro: no inference worker (${(e as Error).message}); running inference on the main thread`);
        this.inferenceMode = 'inline';
      }
    }
    const ort = await import('onnxruntime-node');
    const session = await ort.InferenceSession.create(modelPath, { ...sessionOptions, executionProviders: ['cpu'] });
    checkModel(session.inputNames, session.outputNames);
    return {
      where: 'inline',
      async run(ids, style, speed) {
        const feeds: Record<string, OrtTensor> = {
          input_ids: new ort.Tensor('int64', ids, [1, ids.length]),
          style: new ort.Tensor('float32', style, [1, 256]),
          speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
        };
        const out = await session.run(feeds);
        return { waveform: out.waveform.data as Float32Array, duration: out.duration.data as BigInt64Array };
      },
      release: () => session.release(),
    };
  }

  async release(): Promise<void> {
    const inf = this.inference;
    this.inference = null; this.loaded = false; this.readyPromise = null; this.phonemizer = this.injectedPhonemizer;
    await inf?.release();
  }

  cacheKey(text: string, voice: string, speed: number): string {
    return crypto.createHash('sha1').update(`${MODEL_VERSION}/${AUDIO_FORMAT}\0${voice}\0${speed.toFixed(2)}\0${text}`).digest('hex');
  }

  /** Path of the cached WAV for a sentence (exists only after synthesis). */
  wavPath(text: string, voice: string, speed: number): string { return path.join(this.cacheDir, `${this.cacheKey(text, voice, speed)}.wav`); }

  /**
   * Synthesizes one sentence (or any text); returns the cached result when available. Someone is waiting for it,
   * so it goes before everything queued by prepare(). A long text is synthesized in segments and joined.
   */
  synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesisResult> {
    const { voice, speed } = this.normalize(opts);
    const t = text.trim();
    const segs = synthesisSegments(t);
    if (segs.length === 1) return this.enqueue(segs[0].text, voice, speed, PRIORITY.now, true);
    const key = this.cacheKey(t, voice, speed);
    const hit = this.memoryHit(key);
    if (hit) return Promise.resolve(hit);
    return Promise.all(segs.map((s) => this.enqueue(s.text, voice, speed, PRIORITY.now, true))).then((parts) => {
      const res = joinResults(parts, segs.map((s) => s.start));
      this.remember(key, res);
      if (this.persist) this.writeDisk(key, res).catch((e) => this.log(`kokoro: cache write failed: ${(e as Error).message}`));
      return res;
    });
  }

  /**
   * Queues texts to synthesize in the background (long ones as segments), highest `priority` first, then in
   * order; later synthesize() calls hit the cache. With `replace`, this list replaces the previous read-ahead:
   * queued jobs that no synthesize() call waits for and that are not in this list are dropped (their prepare
   * promises reject with DroppedError). Resolves when every item is synthesized. With `wait`, the caller wants to
   * know when they are ready: later read-ahead lists keep their priority (but may still drop them).
   */
  prepare(items: PrepareItem[], opts: { replace?: boolean; wait?: boolean } = {}): Promise<void> {
    const keys = new Set<string>();
    const all: Promise<SynthesisResult>[] = [];
    for (const it of items) {
      if (!it.text?.trim()) continue;
      const { voice, speed } = this.normalize(it);
      const priority = Math.min(PRIORITY.now - 1, it.priority ?? PRIORITY.background);
      for (const seg of synthesisSegments(it.text)) {
        keys.add(this.cacheKey(seg.text, voice, speed));
        all.push(this.enqueue(seg.text, voice, speed, priority, false, opts.replace, opts.wait));
      }
    }
    if (opts.replace) this.dropExcept(keys);
    this.emit();
    const done = Promise.all(all).then(() => undefined);
    done.catch((e) => { if (!(e instanceof DroppedError)) this.log(`kokoro: prefetch failed: ${(e as Error).message}`); });
    return done;
  }

  /** Drops every queued job no synthesize() call waits for (playback paused or stopped). */
  clearReadAhead(): void { this.dropExcept(new Set()); this.emit(); }

  /**
   * The renderer no longer needs these texts (an explanation prepared at 'soon' priority was dropped): their queued
   * jobs (every segment) that no synthesize() call waits for are removed, held or not, and their prepare promises
   * reject with DroppedError. A job already running finishes (its result is kept in the cache).
   */
  dropTexts(texts: string[], opts: SynthesizeOptions = {}): void {
    const { voice, speed } = this.normalize(opts);
    const keys = new Set<string>();
    for (const t of texts) if (typeof t === 'string' && t.trim()) for (const seg of synthesisSegments(t)) keys.add(this.cacheKey(seg.text, voice, speed));
    if (!keys.size) return;
    const kept: Job[] = [];
    for (const j of this.queue) {
      if (!keys.has(j.key) || j.waiters > 0) { kept.push(j); continue; }
      this.jobs.delete(j.key);
      j.reject(new DroppedError());
    }
    if (kept.length === this.queue.length) return;
    this.queue = kept;
    this.emit();
  }

  /**
   * The renderer stopped waiting for what it asked for (it cancelled its speech: a pause, a seek, an explanation
   * that was interrupted): queued synthesize() requests become ordinary read-ahead, so they no longer go before
   * the requests that follow, and the next replace/clear may drop them.
   */
  releaseWaiters(): void {
    for (const j of this.queue) if (j.waiters > 0 || j.priority >= PRIORITY.now) { j.waiters = 0; j.held = false; j.priority = Math.min(j.priority, PRIORITY.background); }
    this.sortQueue();
  }

  /** what is queued, best first (tests and diagnostics) */
  queuedTexts(): { text: string; priority: number }[] { return this.queue.map((j) => ({ text: j.text, priority: j.priority })); }

  private normalize(opts: SynthesizeOptions): { voice: string; speed: number } {
    const voice = opts.voice && isKnownVoice(opts.voice) ? opts.voice : DEFAULT_VOICE;
    const speed = Math.min(2, Math.max(0.5, opts.speed ?? 1));
    return { voice, speed };
  }

  private memoryHit(key: string): SynthesisResult | null {
    const hit = this.memory.get(key);
    if (!hit) return null;
    this.memory.delete(key); this.memory.set(key, hit);
    return hit;
  }

  private enqueue(text: string, voice: string, speed: number, priority: number, waiter: boolean, rerank = false, hold = false): Promise<SynthesisResult> {
    const key = this.cacheKey(text, voice, speed);
    const hit = this.memoryHit(key);
    if (hit) return Promise.resolve(hit);
    const job = this.jobs.get(key);
    if (job) {
      if (waiter) job.waiters++;
      if (hold) job.held = true;
      if (job !== this.running) {
        // a request at a higher level joins at the back of that level; a read-ahead list re-ranks what nobody waits for
        if (priority > job.priority) { job.priority = priority; job.seq = ++this.jobSeq; job.queuedAt = performance.now(); }
        else if (rerank && job.waiters === 0 && !job.held && priority !== job.priority) { job.priority = priority; job.seq = ++this.jobSeq; }
        this.sortQueue();
      }
      return job.promise;
    }
    let resolve!: (r: SynthesisResult) => void; let reject!: (e: Error) => void;
    const promise = new Promise<SynthesisResult>((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => undefined); // a dropped read-ahead job may have no listener
    const j: Job = { key, text, voice, speed, priority, seq: ++this.jobSeq, waiters: waiter ? 1 : 0, held: hold, queuedAt: performance.now(), promise, resolve, reject };
    this.jobs.set(key, j);
    this.queue.push(j);
    this.sortQueue();
    void this.pump();
    return promise;
  }

  private dropExcept(keep: Set<string>): void {
    const kept: Job[] = [];
    for (const j of this.queue) {
      if (j.waiters > 0 || keep.has(j.key)) { kept.push(j); continue; }
      this.jobs.delete(j.key);
      j.reject(new DroppedError());
    }
    this.queue = kept;
  }

  private sortQueue(): void { this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq); }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // let the requests that arrive together (an IPC burst) be queued before the first pick
      await new Promise<void>((r) => setImmediate(r));
      while (this.queue.length) {
        if (this.queue[0].priority < PRIORITY.next) {
          // background work: let a request that is one IPC message behind it go first (SETTLE_MS)
          await new Promise<void>((r) => setTimeout(r, SETTLE_MS));
          this.sortQueue();
          if (!this.queue.length) break;
        }
        const job = this.queue.shift()!;
        this.running = job;
        try { job.resolve(await this.produce(job)); } catch (e) { job.reject(e as Error); }
        finally { this.jobs.delete(job.key); this.running = null; }
        this.emit();
        await new Promise<void>((r) => setImmediate(r));
      }
    } finally { this.pumping = false; }
  }

  /** Forgets every synthesized sentence held in memory (the disk cache stays). */
  clearMemory(): void { this.memory.clear(); }

  private async produce(job: Job): Promise<SynthesisResult> {
    const started = performance.now();
    const disk = this.persist ? await this.readDisk(job.key) : null;
    if (disk) { this.remember(job.key, disk); return disk; }
    let res: SynthesisResult;
    let t0: number;
    if (this.synthOverride) { t0 = performance.now(); res = await this.synthOverride(job.text, job.voice, job.speed); }
    else { await this.ensureReady(); t0 = performance.now(); res = await this.run(job.text, job.voice, job.speed); }
    this.recordSegment(job, started, performance.now() - t0, res.durationSec);
    if (res.endPunct === undefined) res = { ...res, endPunct: endPunctOf(job.text) };
    this.remember(job.key, res);
    if (this.persist) this.writeDisk(job.key, res).catch((e) => this.log(`kokoro: cache write failed: ${(e as Error).message}`));
    return res;
  }

  /** one synthesized segment for Diagnostics: its synthesis time (not the model loading before it) and queue wait */
  private recordSegment(job: Job, started: number, ms: number, audioSec: number): void {
    if (!(audioSec > 0)) return;
    this.perfLog.push({
      at: Date.now(), chars: job.text.length, ms: Math.round(ms), audioSec: Math.round(audioSec * 100) / 100,
      rtf: Math.round((ms / 1000 / audioSec) * 1000) / 1000, queueWaitMs: Math.round(started - job.queuedAt), priority: job.priority,
    });
  }

  private remember(key: string, res: SynthesisResult): void {
    this.memory.set(key, res);
    while (this.memory.size > this.memoryEntries) this.memory.delete(this.memory.keys().next().value as string);
  }

  private async run(text: string, voice: string, speed: number): Promise<SynthesisResult> {
    const inference = this.inference;
    if (!inference) throw new Error('The Kokoro model is not loaded.');
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
      const ids = BigInt64Array.from([PAD_TOKEN, ...chunk.tokens.slice(0, n), PAD_TOKEN], (v) => BigInt(v));
      const row = Math.min(n, MAX_TOKENS) - 1;
      const out = await inference.run(ids, style.slice(row * 256, row * 256 + 256), speed);
      if (parts.length) {
        // a long text cut at a sentence end: the pause the trimmed audio no longer has
        const gap = new Float32Array(Math.round((pauseAfter(endPunctOf(phonemes)) / 1000) * SAMPLE_RATE));
        parts.push(gap); total += gap.length;
      }
      const piece = trimChunk(out.waveform, out.duration, chunk.tokens, chunk.owner, chunk.words, total);
      words.push(...piece.words);
      parts.push(piece.pcm);
      total += piece.pcm.length;
      phonemes += (phonemes ? ' ' : '') + chunk.phonemes;
    }
    const pcm = new Float32Array(total);
    let off = 0;
    for (const p of parts) { pcm.set(p, off); off += p.length; }
    return { pcm, sampleRate: SAMPLE_RATE, words, durationSec: total / SAMPLE_RATE, wav: encodeWav(pcm, SAMPLE_RATE), phonemes, fromCache: false, endPunct: endPunctOf(text) };
  }

  private async readDisk(key: string): Promise<SynthesisResult | null> {
    const wavFile = path.join(this.cacheDir, `${key}.wav`);
    const jsonFile = path.join(this.cacheDir, `${key}.json`);
    try {
      const [wav, meta] = await Promise.all([fs.promises.readFile(wavFile), fs.promises.readFile(jsonFile, 'utf8')]);
      const info = JSON.parse(meta) as { version: string; words: WordTime[]; durationSec: number; phonemes: string; endPunct?: EndPunct };
      if (info.version !== MODEL_VERSION) return null;
      const { pcm } = decodeWav(wav);
      const now = new Date();
      fs.utimes(wavFile, now, now, () => undefined);
      return { pcm, sampleRate: SAMPLE_RATE, words: info.words, durationSec: info.durationSec, wav, phonemes: info.phonemes, fromCache: true, endPunct: info.endPunct ?? null };
    } catch { return null; }
  }

  private async writeDisk(key: string, res: SynthesisResult): Promise<void> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    const tmp = path.join(this.cacheDir, `${key}.${process.pid}.tmp`);
    await fs.promises.writeFile(tmp, res.wav);
    await fs.promises.rename(tmp, path.join(this.cacheDir, `${key}.wav`));
    await fs.promises.writeFile(path.join(this.cacheDir, `${key}.json`), JSON.stringify({ version: MODEL_VERSION, words: res.words, durationSec: res.durationSec, phonemes: res.phonemes, endPunct: res.endPunct ?? null }));
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

function checkModel(inputNames: readonly string[], outputNames: readonly string[]): void {
  if (!inputNames.includes('input_ids') || !outputNames.includes('duration')) throw new Error('Kokoro model has no duration output; word timing needs the kokoro-onnx model-files-v1.1 export.');
}

/**
 * Joins segment results: audio back to back with the pause each segment's end punctuation calls for (the renderer
 * plays segments the same way), word times shifted by the audio before, char offsets by the segment start.
 */
export function joinResults(parts: SynthesisResult[], starts: number[]): SynthesisResult {
  const words: WordTime[] = [];
  const wavs: Buffer[] = [];
  let samples = 0;
  parts.forEach((p, i) => {
    if (i > 0) {
      const gap = Math.round((pauseAfter(parts[i - 1].endPunct) / 1000) * SAMPLE_RATE);
      if (gap > 0) { wavs.push(encodeWav(new Float32Array(gap), SAMPLE_RATE)); samples += gap; }
    }
    const t = samples / SAMPLE_RATE;
    for (const w of p.words) words.push({ charIndex: w.charIndex + starts[i], charLength: w.charLength, start: w.start + t, end: w.end + t });
    wavs.push(p.wav);
    samples += Math.round(p.durationSec * SAMPLE_RATE);
  });
  const { wav, pcm } = concatWav(wavs, SAMPLE_RATE);
  return { pcm, sampleRate: SAMPLE_RATE, words, durationSec: pcm.length / SAMPLE_RATE, wav, phonemes: parts.map((p) => p.phonemes).join(' '), fromCache: parts.every((p) => p.fromCache), endPunct: parts[parts.length - 1]?.endPunct ?? null };
}

/**
 * One model output -> the audio kept and its word times: trimRange (the pad tokens), then speechRange (by energy: the
 * first sound, which may come before the pad's predicted end, and the silence Kokoro gives the last phoneme, faded
 * out); a 5 ms fade-in; word times start at `offset` samples and are clamped to the kept audio. Exported for tests.
 */
export function trimChunk(wave: Float32Array, durations: ArrayLike<number | bigint>, tokens: number[], owner: number[], chunkWords: { charIndex: number; charLength: number }[], offset: number): { pcm: Float32Array; words: WordTime[] } {
  const [s0, e0] = trimRange(durations, tokens, wave.length, SAMPLE_RATE);
  const [s, e] = speechRange(wave, Math.max(0, s0 - Math.round(ONSET_SEARCH_SEC * SAMPLE_RATE)), e0, SAMPLE_RATE);
  const fadeIn = Math.min(e - s, Math.round(FADE_IN_SEC * SAMPLE_RATE));
  for (let i = 0; i < fadeIn; i++) wave[s + i] *= (i + 1) / (fadeIn + 1);
  const lo = offset / SAMPLE_RATE;
  const hi = (offset + e - s) / SAMPLE_RATE;
  const words = wordTimes(durations, owner, chunkWords, wave.length, SAMPLE_RATE, offset - s);
  for (const w of words) { w.start = Math.max(lo, Math.min(w.start, hi)); w.end = Math.max(w.start, Math.min(w.end, hi)); }
  return { pcm: wave.subarray(s, e), words };
}

/**
 * The worker thread that owns the ONNX session. Plain CommonJS evaluated from a string, so it needs no extra
 * bundle entry; it loads onnxruntime-node from the path the main process resolved (inside app.asar or its
 * unpacked twin when packaged).
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let ort = null; let session = null; let lastErr = null;
for (const p of workerData.ortPaths) { try { ort = require(p); break; } catch (e) { lastErr = e; } }
let phon = null;
for (const p of workerData.phonemizerPaths) { try { phon = require(p); break; } catch {} }
const ready = (async () => {
  if (!ort) throw lastErr || new Error('onnxruntime-node not found');
  session = await ort.InferenceSession.create(workerData.modelPath, workerData.sessionOptions);
  return { inputNames: session.inputNames, outputNames: session.outputNames };
})();
ready.then((info) => parentPort.postMessage({ type: 'ready', inputNames: info.inputNames, outputNames: info.outputNames, phonemizer: !!phon }),
  (e) => parentPort.postMessage({ type: 'fatal', error: String((e && e.message) || e) }));
parentPort.on('message', async (m) => {
  if (m.type === 'release') { try { if (session) await session.release(); } catch {} parentPort.postMessage({ type: 'released' }); return; }
  if (m.type === 'phonemize') {
    try { parentPort.postMessage({ type: 'result', id: m.id, phonemes: await phon.phonemize(m.text, m.lang) }); }
    catch (e) { parentPort.postMessage({ type: 'result', id: m.id, error: String((e && e.message) || e) }); }
    return;
  }
  if (m.type !== 'run') return;
  try {
    await ready;
    const out = await session.run({
      input_ids: new ort.Tensor('int64', m.ids, [1, m.ids.length]),
      style: new ort.Tensor('float32', m.style, [1, 256]),
      speed: new ort.Tensor('float32', new Float32Array([m.speed]), [1]),
    });
    const waveform = new Float32Array(out.waveform.data);
    const duration = new BigInt64Array(out.duration.data);
    parentPort.postMessage({ type: 'result', id: m.id, waveform, duration }, [waveform.buffer, duration.buffer]);
  } catch (e) { parentPort.postMessage({ type: 'result', id: m.id, error: String((e && e.message) || e) }); }
});
`;

/** Absolute paths the worker tries for a package (the CommonJS entry; inside app.asar, then its unpacked twin). */
function modulePaths(name: string, cjsFile?: string): string[] {
  let resolved: string;
  try {
    const req = typeof require === 'function' ? require : createRequire(path.join(process.cwd(), 'index.js'));
    resolved = cjsFile ? path.join(path.dirname(req.resolve(`${name}/package.json`)), cjsFile) : req.resolve(name);
  } catch { resolved = name; }
  const out = [resolved];
  if (resolved.includes(`app.asar${path.sep}`)) out.push(resolved.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
  return out;
}

function startWorkerInference(modelPath: string, sessionOptions: object, onExit: () => void): Promise<Inference> {
  return new Promise((resolveStart, rejectStart) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { ortPaths: modulePaths('onnxruntime-node'), phonemizerPaths: modulePaths('phonemizer', 'dist/phonemizer.cjs'), modelPath, sessionOptions } });
    type Reply = { waveform?: Float32Array; duration?: BigInt64Array; phonemes?: string[] };
    const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
    const call = (msg: object, transfer?: ArrayBuffer[]): Promise<Reply> => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer);
    });
    let nextId = 0; let started = false; let released = false;
    const failAll = (e: Error) => { for (const p of pending.values()) p.reject(e); pending.clear(); };
    worker.on('message', (m: { type: string; id?: number; error?: string; waveform?: Float32Array; duration?: BigInt64Array; phonemes?: string[]; inputNames?: string[]; outputNames?: string[]; phonemizer?: boolean }) => {
      if (m.type === 'ready') {
        try { checkModel(m.inputNames ?? [], m.outputNames ?? []); } catch (e) { void worker.terminate(); rejectStart(e as Error); return; }
        started = true;
        resolveStart({
          where: 'worker',
          async run(ids, style, speed) {
            const r = await call({ type: 'run', ids, style, speed }, [ids.buffer as ArrayBuffer, style.buffer as ArrayBuffer]);
            return { waveform: r.waveform!, duration: r.duration! };
          },
          phonemizer: m.phonemizer ? async (text: string, lang: string) => (await call({ type: 'phonemize', text, lang })).phonemes ?? [] : undefined,
          async release() { released = true; await worker.terminate(); },
        });
      } else if (m.type === 'fatal') { void worker.terminate(); rejectStart(new Error(m.error)); }
      else if (m.type === 'result' && m.id !== undefined) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (!p) return;
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
      }
    });
    worker.on('error', (e) => { failAll(e); if (!started) rejectStart(e); });
    worker.on('exit', () => {
      failAll(new Error('the Kokoro worker stopped'));
      if (!started) rejectStart(new Error('the Kokoro worker stopped before loading the model'));
      else if (!released) onExit();
    });
  });
}
