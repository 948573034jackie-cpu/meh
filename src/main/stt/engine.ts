import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OfflineRecognizer, OfflineRecognizerConfig, OfflineRecognizerResult } from 'sherpa-onnx-node';
import { Emitter } from '@core/voice/turns';
import { SpeechSegmenter, type SegmenterOptions } from '@core/voice/vad';
import { RingBuffer, Resampler, int16ToFloat32 } from '@core/voice/audio';
import type { SttEngineEvent } from '@core/voice/session';
import { SileroModel, SileroState, VAD_SAMPLE_RATE, VAD_WINDOW } from './silero';
import { downloadModel, presentVariant, downloadBytes, isVariant, MODELS, VAD_FILE, DEFAULT_VARIANT, MODEL_VERSION, type SttVariant, type DownloadProgress } from './download';

export type { SttEngineEvent } from '@core/voice/session';
export type { SttVariant, DownloadProgress } from './download';

export type EngineState = 'missing' | 'downloading' | 'loading' | 'ready' | 'error';

export interface EngineStatus {
  state: EngineState;
  variant: SttVariant;
  modelDir: string;
  /** bytes still to download for the configured variant (archive + VAD; 0 when installed) */
  downloadBytes: number;
  progress: DownloadProgress | null;
  error: string | null;
  /** open mic sessions */
  sessions: number;
  version: string;
  /** whether the recogniser reports per-utterance confidence (Parakeet yes, Moonshine no) */
  confidence: boolean;
}

export interface SttEngineOptions {
  modelDir: string;
  variant?: SttVariant;
  /** sherpa-onnx intra-op threads for the recogniser; default: cores - 1, between 2 and 4 */
  threads?: number;
  /** VAD segmentation (see SpeechSegmenter); defaults: 600 ms silence, 15 s max, 300 ms pad */
  vad?: SegmenterOptions;
  /** how often (ms of audio) a partial transcript of the segment in progress is decoded; 0 disables (default 900) */
  partialEveryMs?: number;
  /** a segment must be at least this long before partials start (default 1200) */
  partialMinMs?: number;
  /** seconds of audio kept per session for slicing segments (default 25) */
  bufferSeconds?: number;
  /** download the model when start() finds it missing (default true) */
  autoDownload?: boolean;
  log?: (msg: string) => void;
}

export interface StartOptions { sampleRate?: number }

export interface RecognizeResult { text: string; confidence?: number; durationSec: number; decodeMs: number }

export interface SttEngineEvents {
  /** transcripts, speech start/end and errors, per session */
  event: (e: SttEngineEvent) => void;
  /** every status change (download progress, state changes) */
  status: (s: EngineStatus) => void;
}

interface Session {
  id: string;
  sampleRate: number;
  resampler: Resampler | null;
  /** samples waiting for a full VAD window */
  carry: Float32Array;
  ring: RingBuffer;
  segmenter: SpeechSegmenter;
  vadState: SileroState;
  /** serialises the async VAD runs so windows are processed in order */
  chain: Promise<void>;
  /** sample position of the last partial decode */
  lastPartialAt: number;
  lastPartialText: string;
  /** a partial decode queued or running for the current segment */
  partialQueued: boolean;
  stopped: boolean;
}

interface DecodeJob { session: Session; segmentId: number; kind: 'partial' | 'final'; samples: Float32Array }

/**
 * Free, local, offline speech-to-text for the voice tutor: Silero VAD (onnxruntime-node) cuts the 16 kHz
 * mic stream into utterances, sherpa-onnx (Moonshine v2 base int8 by default, or Parakeet TDT 0.6B v3)
 * recognises each one. Moonshine is an offline model, so "partials" are decodes of the segment so far,
 * every `partialEveryMs` of audio once it is `partialMinMs` long; the final comes ~600 ms (the end-of-speech
 * silence) + decode time after the learner stops talking. Only one decode runs at a time (sherpa's worker
 * thread); a final always takes precedence over partials and a newer partial replaces an older queued one.
 */
export class SttEngine extends Emitter<SttEngineEvents> {
  readonly modelDir: string;
  readonly variant: SttVariant;
  private readonly threads: number;
  private readonly vadOptions: SegmenterOptions;
  private readonly partialEvery: number;
  private readonly partialMin: number;
  private readonly bufferSeconds: number;
  private readonly autoDownload: boolean;
  private readonly log: (msg: string) => void;
  private sherpa: typeof import('sherpa-onnx-node') | null = null;
  private recognizer: OfflineRecognizer | null = null;
  private vad: SileroModel | null = null;
  private loadedVariant: SttVariant | null = null;
  private readyPromise: Promise<void> | null = null;
  private downloadPromise: Promise<void> | null = null;
  private downloadAbort: AbortController | null = null;
  private progress: DownloadProgress | null = null;
  private lastError: string | null = null;
  private sessions = new Map<string, Session>();
  private queue: DecodeJob[] = [];
  private decoding = false;
  private decodeIdle: Promise<void> = Promise.resolve();
  private decodeDone: (() => void) | null = null;

  constructor(opts: SttEngineOptions) {
    super();
    this.modelDir = opts.modelDir;
    const env = process.env.STT_VARIANT;
    this.variant = opts.variant ?? (isVariant(env) ? env : DEFAULT_VARIANT);
    this.threads = opts.threads ?? Math.max(2, Math.min(4, os.cpus().length - 1));
    this.vadOptions = { sampleRate: VAD_SAMPLE_RATE, windowSamples: VAD_WINDOW, minSilenceMs: 600, maxSpeechMs: 15000, padMs: 300, ...opts.vad };
    this.partialEvery = Math.round(((opts.partialEveryMs ?? 900) / 1000) * VAD_SAMPLE_RATE);
    this.partialMin = Math.round(((opts.partialMinMs ?? 1200) / 1000) * VAD_SAMPLE_RATE);
    this.bufferSeconds = opts.bufferSeconds ?? 25;
    this.autoDownload = opts.autoDownload ?? true;
    this.log = opts.log ?? (() => undefined);
  }

  /** The variant on disk (the configured one, or any complete one), else null. */
  get installedVariant(): SttVariant | null { return presentVariant(this.modelDir, this.variant); }

  status(): EngineStatus {
    const installed = this.installedVariant;
    const state: EngineState = this.downloadPromise ? 'downloading' : this.lastError ? 'error' : this.recognizer ? 'ready' : this.readyPromise ? 'loading' : installed ? 'ready' : 'missing';
    const variant = this.loadedVariant ?? installed ?? this.variant;
    return {
      state, variant, modelDir: this.modelDir, downloadBytes: downloadBytes(this.modelDir, this.variant),
      progress: this.progress, error: this.lastError, sessions: this.sessions.size, version: MODEL_VERSION,
      confidence: MODELS[variant].kind === 'nemo_transducer',
    };
  }

  private emitStatus(): void { this.emit('status', this.status()); }

  /** Downloads the VAD and recogniser files if missing. Safe to call repeatedly; resumes partial files. */
  download(): Promise<void> {
    if (this.installedVariant === this.variant) return Promise.resolve();
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadAbort = new AbortController();
    this.lastError = null;
    this.downloadPromise = downloadModel(this.modelDir, this.variant, (p) => { this.progress = p; this.emitStatus(); }, this.downloadAbort.signal)
      .catch((e) => { this.lastError = (e as Error).message; throw e; })
      .finally(() => { this.downloadPromise = null; this.downloadAbort = null; this.progress = null; this.emitStatus(); });
    this.emitStatus();
    return this.downloadPromise;
  }

  cancelDownload(): void { this.downloadAbort?.abort(); }

  /** Loads the recogniser and the VAD (downloading first when `autoDownload`). */
  ensureReady(autoDownload = this.autoDownload): Promise<void> {
    if (this.recognizer && this.vad) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      if (!this.installedVariant) {
        if (!autoDownload) throw new Error('The speech recognition model has not been downloaded yet.');
        await this.download();
      }
      const variant = this.installedVariant;
      if (!variant) throw new Error('Speech model files are missing.');
      this.emitStatus();
      const t0 = Date.now();
      const sherpa = await loadSherpa();
      this.sherpa = sherpa;
      const [recognizer, vad] = await Promise.all([
        sherpa.OfflineRecognizer.createAsync(this.recognizerConfig(variant)),
        SileroModel.load(path.join(this.modelDir, VAD_FILE.name)),
      ]);
      this.recognizer = recognizer; this.vad = vad; this.loadedVariant = variant;
      this.lastError = null;
      this.log(`stt: ${variant} loaded in ${Date.now() - t0} ms (sherpa-onnx ${sherpa.version}, ${this.threads} threads)`);
      this.emitStatus();
    })().catch((e) => { this.lastError = (e as Error).message; this.readyPromise = null; this.emitStatus(); throw e; });
    return this.readyPromise;
  }

  private recognizerConfig(variant: SttVariant): OfflineRecognizerConfig {
    const spec = MODELS[variant];
    const dir = path.join(this.modelDir, spec.dir);
    const base = { tokens: path.join(dir, 'tokens.txt'), numThreads: this.threads, provider: 'cpu', debug: 0 };
    if (spec.kind === 'moonshine') {
      return { featConfig: { sampleRate: VAD_SAMPLE_RATE, featureDim: 80 }, modelConfig: { ...base, moonshine: { encoder: path.join(dir, 'encoder_model.ort'), mergedDecoder: path.join(dir, 'decoder_model_merged.ort') } }, decodingMethod: 'greedy_search' };
    }
    return {
      featConfig: { sampleRate: VAD_SAMPLE_RATE, featureDim: 80 },
      modelConfig: { ...base, modelType: 'nemo_transducer', transducer: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), joiner: path.join(dir, 'joiner.int8.onnx') } },
      decodingMethod: 'greedy_search',
    };
  }

  async release(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.stop(id);
    await this.vad?.release();
    this.vad = null; this.recognizer = null; this.loadedVariant = null; this.readyPromise = null;
  }

  // ---- sessions -------------------------------------------------------------------------------------------

  /** Opens a mic session. Audio pushed later is mono PCM at `sampleRate` (default 16000; others are resampled). */
  async start(sessionId: string, opts: StartOptions = {}): Promise<void> {
    if (this.sessions.has(sessionId)) throw new Error(`stt: session "${sessionId}" is already open`);
    await this.ensureReady();
    const sampleRate = opts.sampleRate ?? VAD_SAMPLE_RATE;
    if (!(sampleRate >= 8000 && sampleRate <= 192000)) throw new Error(`stt: unsupported sample rate ${sampleRate}`);
    const s: Session = {
      id: sessionId, sampleRate,
      resampler: sampleRate === VAD_SAMPLE_RATE ? null : new Resampler(sampleRate, VAD_SAMPLE_RATE),
      carry: new Float32Array(0),
      ring: new RingBuffer(this.bufferSeconds * VAD_SAMPLE_RATE),
      segmenter: new SpeechSegmenter(this.vadOptions),
      vadState: new SileroState(),
      chain: Promise.resolve(),
      lastPartialAt: 0, lastPartialText: '', partialQueued: false, stopped: false,
    };
    this.sessions.set(sessionId, s);
    this.emitStatus();
  }

  /** Feeds audio (Float32 -1..1 or Int16) to an open session. Returns once the VAD has consumed it. */
  pushAudio(sessionId: string, data: Float32Array | Int16Array): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.stopped) return Promise.reject(new Error(`stt: session "${sessionId}" is not open`));
    let pcm = data instanceof Int16Array ? int16ToFloat32(data) : data;
    if (s.resampler) pcm = s.resampler.process(pcm);
    const buf = s.carry.length ? concat(s.carry, pcm) : pcm;
    const whole = buf.length - (buf.length % VAD_WINDOW);
    s.carry = buf.subarray(whole).slice();
    const windows = buf.subarray(0, whole);
    if (!windows.length) return s.chain;
    s.ring.write(windows);
    s.chain = s.chain.then(() => this.runVad(s, windows)).catch((e) => this.fail(s, e as Error));
    return s.chain;
  }

  /** Closes a session: an utterance still open is finalised; resolves after its final transcript was emitted. */
  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.stopped = true;
    await s.chain.catch(() => undefined);
    if (s.resampler) { const tail = s.resampler.flush(); if (tail.length) s.ring.write(tail); }
    for (const ev of s.segmenter.flush()) this.onSegmentEvent(s, ev);
    this.sessions.delete(sessionId);
    await this.decodeIdle;
    this.emitStatus();
  }

  private async runVad(s: Session, windows: Float32Array): Promise<void> {
    const vad = this.vad;
    if (!vad) return;
    for (let i = 0; i + VAD_WINDOW <= windows.length; i += VAD_WINDOW) {
      if (s.stopped) return;
      const prob = await vad.process(windows.subarray(i, i + VAD_WINDOW), s.vadState);
      for (const ev of s.segmenter.push(prob)) this.onSegmentEvent(s, ev);
      const active = s.segmenter.active;
      if (active && this.partialEvery > 0) {
        const pos = s.segmenter.position;
        if (pos - active.start >= this.partialMin && pos - s.lastPartialAt >= this.partialEvery && !s.partialQueued) {
          s.lastPartialAt = pos;
          s.partialQueued = true;
          this.enqueue({ session: s, segmentId: active.segmentId, kind: 'partial', samples: s.ring.slice(active.start, pos) });
        }
      }
    }
  }

  private onSegmentEvent(s: Session, ev: ReturnType<SpeechSegmenter['push']>[number]): void {
    const segmentId = `${s.id}:${ev.segmentId}`;
    if (ev.type === 'speechStart') {
      s.lastPartialAt = ev.start; s.lastPartialText = '';
      this.emit('event', { type: 'speechStart', sessionId: s.id, segmentId });
      return;
    }
    this.emit('event', { type: 'speechEnd', sessionId: s.id, segmentId });
    // a final supersedes any partial still queued for this segment
    this.queue = this.queue.filter((j) => !(j.session === s && j.segmentId === ev.segmentId && j.kind === 'partial'));
    s.partialQueued = false;
    this.enqueue({ session: s, segmentId: ev.segmentId, kind: 'final', samples: s.ring.slice(ev.start, ev.end) });
  }

  private enqueue(job: DecodeJob): void {
    this.queue.push(job);
    if (!this.decoding) {
      this.decoding = true;
      this.decodeIdle = new Promise<void>((r) => { this.decodeDone = r; });
      void this.pump();
    }
  }

  private async pump(): Promise<void> {
    try {
      while (this.queue.length) {
        // finals first, then the newest partial
        const fi = this.queue.findIndex((j) => j.kind === 'final');
        const job = fi >= 0 ? this.queue.splice(fi, 1)[0] : this.queue.shift()!;
        const s = job.session;
        const segmentId = `${s.id}:${job.segmentId}`;
        try {
          const t0 = Date.now();
          const r = await this.decodeSamples(job.samples);
          const text = r.text.trim();
          if (job.kind === 'final') {
            this.log(`stt: final [${segmentId}] ${(job.samples.length / VAD_SAMPLE_RATE).toFixed(2)} s in ${Date.now() - t0} ms: ${JSON.stringify(text)}`);
            this.emit('event', { type: 'final', text, confidence: r.confidence, segmentId, sessionId: s.id });
          } else {
            s.partialQueued = false;
            if (text && text !== s.lastPartialText && s.segmenter.active?.segmentId === job.segmentId) {
              s.lastPartialText = text;
              this.emit('event', { type: 'partial', text, confidence: r.confidence, segmentId, sessionId: s.id });
            }
          }
        } catch (e) {
          if (job.kind === 'partial') s.partialQueued = false;
          this.fail(s, e as Error);
        }
      }
    } finally {
      this.decoding = false;
      this.decodeDone?.();
      this.decodeDone = null;
    }
  }

  private async decodeSamples(samples: Float32Array, sampleRate = VAD_SAMPLE_RATE): Promise<{ text: string; confidence?: number }> {
    const rec = this.recognizer;
    if (!rec) throw new Error('stt: recogniser not loaded');
    const stream = rec.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    const r = await rec.decodeAsync(stream);
    return { text: r.text, confidence: confidenceOf(r) };
  }

  private fail(s: Session, e: Error): void {
    this.log(`stt: session ${s.id}: ${e.message}`);
    this.emit('event', { type: 'error', sessionId: s.id, message: e.message });
  }

  // ---- one-shot recognition (tests, bench) -------------------------------------------------------------------

  /** Recognises a whole WAV file (any sample rate; sherpa resamples) in one go, without VAD. */
  async recognizeFile(file: string): Promise<RecognizeResult> {
    await this.ensureReady();
    if (!fs.existsSync(file)) throw new Error(`stt: no such file ${file}`);
    const wave = this.sherpa!.readWave(file);
    return this.recognizeSamples(wave.samples, wave.sampleRate);
  }

  /** Recognises a buffer of mono PCM in one go, without VAD. */
  async recognizeSamples(samples: Float32Array, sampleRate = VAD_SAMPLE_RATE): Promise<RecognizeResult> {
    await this.ensureReady();
    const t0 = Date.now();
    const r = await this.decodeSamples(samples, sampleRate);
    return { text: r.text.trim(), confidence: r.confidence, durationSec: samples.length / sampleRate, decodeMs: Date.now() - t0 };
  }
}

type Sherpa = typeof import('sherpa-onnx-node');

/**
 * sherpa-onnx-node is CommonJS (`module.exports = { OfflineRecognizer : ... }`); Node's named-export detection
 * misses that shape, so a dynamic import yields only `default`. Accept both.
 */
async function loadSherpa(): Promise<Sherpa> {
  const mod = (await import('sherpa-onnx-node')) as unknown as Sherpa & { default?: Sherpa };
  return typeof mod.OfflineRecognizer === 'function' ? mod : mod.default!;
}

/** Mean token probability (exp of the mean log-prob) for transducer models; undefined when the model gives none. */
export function confidenceOf(r: Pick<OfflineRecognizerResult, 'ys_log_probs'>): number | undefined {
  const lp = r.ys_log_probs;
  if (!lp || !lp.length) return undefined;
  let s = 0;
  for (const v of lp) s += v;
  return Math.max(0, Math.min(1, Math.exp(s / lp.length)));
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
