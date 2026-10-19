/**
 * The parts of sherpa-onnx-node (N-API addon, prebuilt for darwin-x64/arm64, linux, win) that the STT engine
 * uses. The package ships JSDoc typedefs only; this keeps our use of it type-checked.
 */
declare module 'sherpa-onnx-node' {
  export interface Waveform { samples: Float32Array; sampleRate: number }

  export interface OfflineMoonshineModelConfig {
    /** Moonshine v2 (2026-02): encoder_model.ort */
    encoder?: string;
    /** Moonshine v2: decoder_model_merged.ort */
    mergedDecoder?: string;
    /** Moonshine v1 files */
    preprocessor?: string;
    uncachedDecoder?: string;
    cachedDecoder?: string;
  }
  export interface OfflineTransducerModelConfig { encoder?: string; decoder?: string; joiner?: string }
  export interface OfflineModelConfig {
    moonshine?: OfflineMoonshineModelConfig;
    transducer?: OfflineTransducerModelConfig;
    tokens?: string;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
    /** 'nemo_transducer' for Parakeet */
    modelType?: string;
    modelingUnit?: string;
    bpeVocab?: string;
  }
  export interface OfflineRecognizerConfig {
    featConfig?: { sampleRate?: number; featureDim?: number };
    modelConfig: OfflineModelConfig;
    decodingMethod?: 'greedy_search' | 'modified_beam_search';
    maxActivePaths?: number;
    hotwordsFile?: string;
    hotwordsScore?: number;
    ruleFsts?: string;
    ruleFars?: string;
  }
  export interface OfflineRecognizerResult {
    lang: string;
    emotion: string;
    event: string;
    text: string;
    timestamps: number[];
    durations: number[];
    tokens: string[];
    /** per-token log-probabilities (transducer models only; empty for Moonshine) */
    ys_log_probs: number[];
    words: number[];
  }
  export class OfflineStream {
    acceptWaveform(w: Waveform): void;
    setOption(key: string, value: string): void;
  }
  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    config: OfflineRecognizerConfig;
    createStream(hotwords?: string): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }
  export function readWave(filename: string, enableExternalBuffer?: boolean): Waveform;
  export function readWaveFromBinary(data: Uint8Array, enableExternalBuffer?: boolean): Waveform;
  export function writeWave(filename: string, w: Waveform): boolean;
  export const version: string;
  export const onnxruntimeVersion: string;
}
