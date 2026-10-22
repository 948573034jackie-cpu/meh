/**
 * Microphone capture for voice chat: getUserMedia (echo cancellation on, so the tutor's own voice from the
 * speakers stays out) -> AudioWorklet -> 16 kHz mono Int16 frames of 512 samples (32 ms) -> `frame` listeners.
 * The worklet is an inline module loaded from a Blob URL; where that is refused (CSP) a ScriptProcessorNode
 * runs the same resampler on the main thread.
 */
import { Emitter } from '@core/voice/turns';

export const MIC_RATE = 16000;
export const FRAME_SAMPLES = 512; // 32 ms at 16 kHz

export const MIC_DENIED_MESSAGE = 'Dream Read needs the microphone: System Settings → Privacy & Security → Microphone';

export class MicError extends Error {
  constructor(public readonly code: 'denied' | 'unavailable' | 'other', message: string) { super(message); }
}

/**
 * Linear-interpolating downsampler with a two-pole low-pass in front (enough for speech recognition), Float32 at
 * the device rate in, Int16 frames at 16 kHz out. The AudioWorklet source below runs the same algorithm.
 */
export class Pcm16kResampler {
  private readonly ratio: number;
  private readonly a: number;
  private lp1 = 0; private lp2 = 0; private prev = 0; private t = 0;
  private buf: Int16Array; private n = 0; private sumSq = 0;

  constructor(inputRate: number, private readonly frame = FRAME_SAMPLES, private readonly onFrame: (pcm: Int16Array, rms: number) => void) {
    this.ratio = inputRate / MIC_RATE;
    // cut-off a little under 8 kHz (the new Nyquist); none when the input already is 16 kHz
    this.a = this.ratio <= 1 ? 1 : 1 - Math.exp((-2 * Math.PI * 7000) / inputRate);
    this.buf = new Int16Array(frame);
  }

  push(input: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      this.lp1 += this.a * (input[i] - this.lp1);
      this.lp2 += this.a * (this.lp1 - this.lp2);
      const cur = this.lp2;
      while (this.t <= 1) { this.emit(this.prev + (cur - this.prev) * this.t); this.t += this.ratio; }
      this.t -= 1;
      this.prev = cur;
    }
  }

  private emit(v: number): void {
    const c = v > 1 ? 1 : v < -1 ? -1 : v;
    this.buf[this.n++] = c < 0 ? c * 0x8000 : c * 0x7fff;
    this.sumSq += c * c;
    if (this.n === this.frame) {
      const out = this.buf;
      const rms = Math.sqrt(this.sumSq / this.frame);
      this.buf = new Int16Array(this.frame); this.n = 0; this.sumSq = 0;
      this.onFrame(out, rms);
    }
  }
}

const WORKLET_SOURCE = `
class Pcm16k extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / ${MIC_RATE};
    this.a = this.ratio <= 1 ? 1 : 1 - Math.exp((-2 * Math.PI * 7000) / sampleRate);
    this.frame = (options && options.processorOptions && options.processorOptions.frame) || ${FRAME_SAMPLES};
    this.lp1 = 0; this.lp2 = 0; this.prev = 0; this.t = 0;
    this.buf = new Int16Array(this.frame); this.n = 0; this.sumSq = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.lp1 += this.a * (input[i] - this.lp1);
      this.lp2 += this.a * (this.lp1 - this.lp2);
      const cur = this.lp2;
      while (this.t <= 1) {
        let v = this.prev + (cur - this.prev) * this.t;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.sumSq += v * v;
        if (this.n === this.frame) {
          const out = this.buf.buffer;
          this.port.postMessage({ pcm: out, rms: Math.sqrt(this.sumSq / this.frame) }, [out]);
          this.buf = new Int16Array(this.frame); this.n = 0; this.sumSq = 0;
        }
        this.t += this.ratio;
      }
      this.t -= 1;
      this.prev = cur;
    }
    return true;
  }
}
registerProcessor('pcm16k', Pcm16k);
`;

export interface MicEvents {
  /** 32 ms of 16 kHz mono Int16 PCM (the ArrayBuffer is the caller's to transfer) */
  frame: (pcm: ArrayBuffer) => void;
  /** input level 0..1 (about 30 per second), for the meter */
  level: (level: number) => void;
  /** the device went away (unplugged) */
  ended: () => void;
}

/** What VoiceChat needs from a microphone (the e2e build passes a fake). */
export interface MicLike {
  start(): Promise<void>;
  stop(): void;
  readonly active: boolean;
  on<K extends keyof MicEvents>(ev: K, fn: MicEvents[K]): () => void;
}

export class MicCapture extends Emitter<MicEvents> implements MicLike {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private starting: Promise<void> | null = null;

  get active(): boolean { return this.stream !== null; }

  start(): Promise<void> {
    if (this.stream) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async open(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unavailable', 'No microphone is available.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') throw new MicError('denied', MIC_DENIED_MESSAGE);
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') throw new MicError('unavailable', 'No microphone was found. Plug one in, or type your question.');
      throw new MicError('other', `The microphone could not be opened (${(e as Error).message}).`);
    }
    // the device rate (44.1 / 48 kHz): forcing 16 kHz is unreliable on macOS; the worklet downsamples
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const onFrame = (pcm: ArrayBuffer, rms: number) => { this.emit('frame', pcm); this.emit('level', Math.min(1, rms * 4)); };
    let node: AudioNode;
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      const w = new AudioWorkletNode(ctx, 'pcm16k', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', processorOptions: { frame: FRAME_SAMPLES } });
      w.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => onFrame(e.data.pcm, e.data.rms);
      node = w;
      // pulled through a silent gain so the graph keeps rendering it
      const mute = ctx.createGain(); mute.gain.value = 0;
      src.connect(w); w.connect(mute); mute.connect(ctx.destination);
      this.nodes.push(mute);
    } catch {
      // the worklet could not load: same resampler on the main thread
      const rs = new Pcm16kResampler(ctx.sampleRate, FRAME_SAMPLES, (pcm, rms) => onFrame(pcm.buffer as ArrayBuffer, rms));
      const sp = ctx.createScriptProcessor(1024, 1, 1);
      sp.onaudioprocess = (e) => rs.push(e.inputBuffer.getChannelData(0));
      const mute = ctx.createGain(); mute.gain.value = 0;
      src.connect(sp); sp.connect(mute); mute.connect(ctx.destination);
      node = sp; this.nodes.push(mute);
    }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => { if (this.stream === stream) { this.stop(); this.emit('ended'); } });
    this.stream = stream; this.ctx = ctx; this.nodes.push(src, node);
  }

  stop(): void {
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* already */ } }
    this.nodes = [];
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

/** A microphone that never hears anything (e2e tests; the transcript events are injected instead). */
export class SilentMic extends Emitter<MicEvents> implements MicLike {
  private on_ = false;
  get active(): boolean { return this.on_; }
  async start(): Promise<void> { this.on_ = true; }
  stop(): void { this.on_ = false; }
}
