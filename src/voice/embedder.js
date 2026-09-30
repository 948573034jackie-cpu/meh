(function () {
'use strict';
// Turns speech into a "voiceprint" (192 numbers) with the TitaNet-small speaker model,
// running on this computer through ONNX Runtime (WebAssembly). Nothing leaves the machine.
const { extractFeatures, MELS } = typeof module !== 'undefined' && module.exports ? require('./fbank') : globalThis.CEVoice.fbank;

const MIN_SAMPLES = 16000 * 0.5;

// ort: the onnxruntime-web module; modelBytes: Uint8Array of nemo_en_titanet_small.onnx
async function createEmbedder(ort, modelBytes, { wasmPaths } = {}) {
  ort.env.wasm.numThreads = 1;
  if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
  return {
    // pcm: Float32Array, 16 kHz mono, [-1, 1]. Returns Float32Array(192), length-normalised.
    async embed(pcm) {
      if (pcm.length < MIN_SAMPLES) throw new Error('too-short');
      const { data, frames } = extractFeatures(pcm);
      const out = await session.run({
        audio_signal: new ort.Tensor('float32', data, [1, MELS, frames]),
        length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
      });
      const e = Float32Array.from(out.embs.data);
      let n = 0;
      for (const v of e) n += v * v;
      n = Math.sqrt(n) || 1;
      return e.map((v) => v / n);
    },
  };
}

const api = { createEmbedder, MIN_SAMPLES };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.CEVoice.embedder = api;
})();
