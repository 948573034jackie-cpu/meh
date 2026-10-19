# Kokoro: the local neural voice

Kokoro-82M (Apache-2.0, hexgrad) runs inside the Electron main process through `onnxruntime-node`, with
espeak-ng (WebAssembly, the `phonemizer` package) for grapheme-to-phoneme. The model's own duration
predictor gives one frame count per phoneme token, which we turn into per-word start/end times for the
karaoke highlight. Code: `src/main/kokoro/` (engine, download, G2P, alignment, IPC), `src/core/tts/kokoro.ts`
(renderer engine, plays the WAV through the same path as the cloud voices).

## Files and where they come from

| File | Size | Source |
| --- | --- | --- |
| `kokoro-v1.0.fp16.onnx` (default) | 164 MB | github.com/thewh1teagle/kokoro-onnx release `model-files-v1.1` |
| `voices-v1.0.bin` (54 voices, NumPy .npz) | 28 MB | same release |
| `kokoro-v1.0.onnx` (fp32, optional) | 326 MB | same release |
| `kokoro-v1.0.int8.onnx` (optional, see below) | 114 MB | same release |

Total first-run download for the default: **192 MB**, into `<userData>/models/kokoro/`, resumable
(HTTP Range on a `.part` file), sha256-verified (hashes in `src/main/kokoro/download.ts`), with progress
broadcast on the `kokoro:progress` channel. The files are pinned to one release tag so the hashes stay valid.
Only this kokoro-onnx export has the `duration` output; the onnx-community Hugging Face exports used by
kokoro-js output the waveform only (kokoro-js 1.2.1 does not expose timings at all).

Why not int8: the kokoro-onnx int8 file uses dynamic quantization (`ConvInteger`/`MatMulInteger`). It needs
onnxruntime >= 1.30 to load at all (1.23 has no int8 `ConvInteger` kernel) and it ran about **6x slower**
than fp32 on a 4-core x86 (RTF 2.1 vs 0.36). fp16 is the same speed as fp32 on the CPU provider (weights
are cast to fp32 at load) at half the download, so it is the default. `KOKORO_VARIANT=fp32|int8` overrides.

Synthesized sentences are cached as WAV + JSON (word times) under `<userData>/cache/tts/`, keyed by
sha1(model version, voice, speed, text), capped at 300 MB (LRU by mtime), plus a 48-entry memory LRU.

## Speed (scripts/kokoro-bench.mjs)

Measured on this Linux CI box, a 4-vCPU Intel Xeon @ 2.8 GHz (AVX-512, no turbo, noisy neighbours), Node 22,
onnxruntime-node 1.30.0, voice bf_emma, three sentences of 5–8 s each:

| Model | Threads | RTF (synthesis s / audio s) | Notes |
| --- | --- | --- | --- |
| fp16 | 4 | 0.35–0.40 (2.5–2.9x real time) | one outlier at 0.66 |
| fp16 | 3 | 0.41–0.47 | the app default on a 4-core machine (cores − 1) |
| fp32 | 4 | 0.38–0.53 | same as fp16 |
| int8 | 4 | 2.1–2.7 | slower than real time: do not ship |

Model load: 1.7–2.5 s (fp16), warm-up inference 0.5 s. First-sentence latency after load: ~2.1 s for a
5.4 s sentence when warmed up, 5.7 s cold (the first ORT run and the espeak WASM start are slow), which is
why the engine runs a warm-up at load and why the renderer should call `prepare()` for the next sentences.

Expected on Macs: a 4-core Intel Mac (2018–2020 i5/i7, AVX2, turbo) should land near this box or a bit
better, RTF ~0.3–0.5, i.e. a 6 s sentence takes 2–3 s to synthesize; with prefetch of the following
sentences, playback is continuous after the first one. Apple Silicon is several times faster (community
numbers for kokoro-onnx on M1 are "near real time" for the Python fp32 path with ORT's CPU provider; expect
RTF ~0.1–0.2). The CoreML execution provider is available in onnxruntime-node on macOS but was not tried
(dynamic shapes in Kokoro usually fall back to CPU anyway).

## Packaging (electron-builder)

`onnxruntime-node` is a native addon: `dist/main/index.js` keeps it as an external `require` (see
`scripts/build.mjs`), so it must be shipped from `node_modules` and must not live inside the asar:

```jsonc
"build": {
  "files": [
    "dist/**/*", "package.json",
    // onnxruntime-node ships binaries for every platform (~290 MB); keep only the one being built
    "!node_modules/onnxruntime-node/bin/napi-v6/{linux,win32}/**",
    "!node_modules/onnxruntime-node/bin/napi-v6/darwin/!(${arch})/**"
  ],
  "asarUnpack": ["node_modules/onnxruntime-node/**"]
}
```

- electron-builder 26 collects production dependencies from the package manager tree on its own, so the
  `files` list does not have to name `node_modules`; the negations above only trim it. Per-platform
  binaries: `bin/napi-v6/darwin/arm64` (36 MB) and `darwin/x64` (40 MB): `onnxruntime_binding.node` plus
  `libonnxruntime.1.30.0.dylib`. They are loaded by path next to the binding, hence `asarUnpack` for the
  whole package (electron-builder also auto-unpacks `.node`/`.dylib` files it detects, but an explicit
  pattern keeps `dist/` and the package's `package.json` together with them).
- The postinstall of onnxruntime-node downloads CUDA providers on Linux/Windows only; it does nothing on
  macOS. In CI set `ONNXRUNTIME_NODE_INSTALL=skip` to avoid the 384 MB fetch.
- Code signing: the dylib and `.node` inside `app.asar.unpacked` get signed with the app (hardened runtime
  is fine; no extra entitlements are needed for CPU inference).
- `phonemizer` (espeak-ng WASM, 1.3 MB with the data embedded) and `jszip` are bundled into
  `dist/main/index.js` by esbuild; nothing to unpack.
- Model files: first-run download (default). To ship them instead, add
  `{ "from": "models/kokoro", "to": "models/kokoro" }` to `extraResources` and point `KOKORO_MODEL_DIR`
  (or `kokoroEngine()` in `src/main/kokoro/ipc.ts`) at `process.resourcesPath/models/kokoro`; that adds
  192 MB to the zip for each architecture.
- Minimum macOS: onnxruntime-node's prebuilt macOS binaries target macOS 13.3+ (the app already requires 13).

## How the pipeline works

1. `text.ts` splits the sentence into word and punctuation pieces with original offsets, normalising words
   (Mr./Dr., £5.50, 3.14, 1999, 10:30, acronyms) the way kokoro-js does.
2. `phonemes.ts` sends each run of words between punctuation marks to espeak-ng (`en` = British for
   `b*` voices, `en-us` otherwise), applies the kokoro-js symbol fixes (r→ɹ, x→k, …), tokenizes with the
   Kokoro v1.0 vocabulary and records which word owns each token. espeak merges some function words
   ("was the" → `wʌzðə`) and expands numbers; when the phoneme groups do not match the words 1:1, tokens
   are attributed proportionally to each word's stand-alone phoneme length.
3. `engine.ts` runs the model per chunk (≤ 510 tokens; long texts are cut at sentence ends) with inputs
   `input_ids [1, n+2]` (pad 0 at both ends), `style [1, 256]` (row n−1 of the voice's 510×256 table), and
   `speed [1]`. Outputs: `waveform [samples]` at 24 kHz and `duration [n+2]` frames (600 samples per frame
   in these exports; the code scales frame sums to the real sample count rather than assuming it).
4. `align.ts` turns cumulative durations into sample edges, trims the ~0.3 s of pad silence at the start
   (keeping 50 ms) and the tail (keeping 120 ms), and emits `{charIndex, charLength, start, end}` per word.
5. `ipc.ts` returns a WAV (16-bit) plus timings; the renderer's `AudioTtsEngine` plays it and fires `onWord`.

## IPC

`kokoro:status`, `kokoro:download`, `kokoro:cancelDownload`, `kokoro:voices`,
`kokoro:synthesize(text, voice, speed, {asFile?})`, `kokoro:prepare(items)`; events on `kokoro:progress`.
The existing `tts:synthesize` / `tts:voices` channels accept engine `'kokoro'` as well, which is what the
renderer engine uses today. The preload bridge (`src/preload/index.ts`) and `ReadAlongApi`
(`src/shared/api.ts`) still need entries for the `kokoro:*` channels before Settings can show download
progress and the reader can call `prepare()`.

## Voices

British: bf_emma (default, grade B-), bm_george, bf_isabella, bm_fable, bm_lewis, bf_alice, bf_lily,
bm_daniel. American: af_heart (A), af_bella (A-), af_nicole, am_michael, am_fenrir, … (grades from the
Kokoro model card). All 54 vectors are in `voices-v1.0.bin`; `src/main/kokoro/voices.ts` lists the English ones.

## onnxruntime-node version (important)
onnxruntime-node is pinned to **1.23.2**: it is the newest release that ships macOS **x64** (Intel) binaries;
1.30 ships darwin/arm64 only, so Kokoro and the Silero VAD would fail on Intel Macs. The fp16/fp32 models load
and run on 1.23.2 (bench on a 4-core x86: RTF ≈ 0.48); the int8 file does not load on 1.23 (and is slower anyway).
