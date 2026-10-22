import type { InferenceSession as OrtSession, Tensor as OrtTensor } from 'onnxruntime-node';

/**
 * Silero VAD (the `silero_vad.onnx` sherpa-onnx redistributes: inputs x[1,512], h[2,1,64], c[2,1,64];
 * outputs prob, new_h, new_c; 16 kHz only) run through onnxruntime-node, the runtime the app already ships
 * for Kokoro. One SileroModel (ORT session) is shared; each audio stream owns a SileroState (the LSTM
 * state), so several mic sessions can run on the same model. ~0.5 ms per 32 ms window on a 4-core x86.
 */
export const VAD_SAMPLE_RATE = 16000;
export const VAD_WINDOW = 512;

type Ort = typeof import('onnxruntime-node');

export class SileroState {
  h = new Float32Array(2 * 64);
  c = new Float32Array(2 * 64);
  reset(): void { this.h.fill(0); this.c.fill(0); }
}

export class SileroModel {
  private constructor(private readonly ort: Ort, private readonly session: OrtSession) {}

  static async load(modelPath: string, ort?: Ort): Promise<SileroModel> {
    const rt = ort ?? (await import('onnxruntime-node'));
    const session = await rt.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 1, interOpNumThreads: 1, logSeverityLevel: 3 });
    for (const n of ['x', 'h', 'c']) if (!session.inputNames.includes(n)) throw new Error(`silero_vad.onnx: unexpected inputs ${session.inputNames.join(',')}`);
    return new SileroModel(rt, session);
  }

  /** Speech probability (0..1) of one 512-sample window at 16 kHz; updates `state`. */
  async process(window: Float32Array, state: SileroState): Promise<number> {
    if (window.length !== VAD_WINDOW) throw new Error(`silero: window must be ${VAD_WINDOW} samples, got ${window.length}`);
    const { Tensor } = this.ort;
    const feeds: Record<string, OrtTensor> = {
      x: new Tensor('float32', window, [1, VAD_WINDOW]),
      h: new Tensor('float32', state.h, [2, 1, 64]),
      c: new Tensor('float32', state.c, [2, 1, 64]),
    };
    const out = await this.session.run(feeds);
    state.h = new Float32Array(out.new_h.data as Float32Array);
    state.c = new Float32Array(out.new_c.data as Float32Array);
    return (out.prob.data as Float32Array)[0];
  }

  async release(): Promise<void> { await this.session.release(); }
}
