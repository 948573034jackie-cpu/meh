# Voice input: local speech-to-text (v2 step 6)

Free, local, offline speech-to-text so the learner can talk to the tutor and say "I know" / "I don't know" /
"bye bye". Nothing leaves the machine. Works on macOS 13+ on Intel and Apple Silicon (and on Linux/Windows
for development). Research and alternatives: `docs/research/research-voice.md`.

## What was chosen and why

| Piece | Choice | Why |
|---|---|---|
| Runtime | [`sherpa-onnx-node`](https://www.npmjs.com/package/sherpa-onnx-node) 1.13.8 (N-API addon; prebuilt `sherpa-onnx-darwin-x64` / `-darwin-arm64` / `-linux-x64` / `-win-x64` optional deps) | One dependency covers Moonshine, Parakeet, Zipformer, Whisper, keyword spotting; no Electron ABI rebuild (N-API); loads with no env vars once unpacked from asar. |
| Recogniser (default) | **Moonshine v2 base, int8** (`sherpa-onnx-moonshine-base-en-quantized-2026-02-27`) | 111 MB download, 135 MB on disk, ~300 MB RSS, real-time factor **0.06** on a 4-core Intel Xeon (a 6 s sentence decodes in ~0.35 s). English only; designed for short utterances, which is exactly our case. Perfect transcripts on the Kokoro bench sentences. |
| Recogniser (optional) | **Parakeet TDT 0.6B v3 int8** (`parakeet-v3` variant, `STT_VARIANT=parakeet-v3`) | Best accuracy on accented English and the only one that gives per-token log-probs (→ `confidence`). But 487 MB download / 641 MB on disk / ~930 MB RSS and RTF **0.3** on the 4-core Intel (1.7–2.2 s per sentence): fine on Apple Silicon, too slow for the command path on older Intel Macs. |
| Recogniser (optional) | Moonshine v2 tiny (`moonshine-tiny`) | 30 MB; RTF 0.04; weaker on accents. For very old machines. |
| VAD | **Silero VAD** (`silero_vad.onnx` from the same release, 644 KB) run through **onnxruntime-node** (already shipped for Kokoro) | ~0.5 ms per 32 ms window. Running it ourselves (instead of sherpa's built-in VAD) gives frame probabilities to a pure, unit-tested segmenter and exact segment start positions for partial decodes. |

Not chosen: whisper.cpp (`whisper-cpp-node` is arm64-only, tiny/base weak on accents), Vosk (ffi-napi, Kaldi-era
accuracy), Apple `SFSpeechRecognizer` (needs a signed Swift helper, no custom vocabulary), Web Speech API
(does not work in Electron). Streaming Zipformer (310 MB) was not needed: Moonshine decodes a whole utterance
faster than a streaming model would produce its partials, so "partials" are re-decodes of the segment so far.

Models are GitHub release assets of `k2-fsa/sherpa-onnx` (tag `asr-models`), pinned by size + sha256 in
`src/main/stt/download.ts`. Hugging Face is not used. Archives are `.tar.bz2`; Node has no bzip2, so
`unbzip2-stream` (pure JS, ~4 MB/s) + a 100-line tar reader (`src/main/stt/tar.ts`) extract them: ~35 s once
for the default model, ~3 min for Parakeet. Only the runtime files + LICENSE are kept; the archive is deleted.

## Pipeline

```
mic (renderer) ──getUserMedia──▶ AudioWorklet: mono, downsample to 16 kHz, Int16 frames of 20–40 ms
     │ stt:push(sessionId, ArrayBuffer)                                            (IPC, main process)
     ▼
SttEngine.pushAudio ─▶ Resampler (if not 16 kHz) ─▶ RingBuffer (25 s) ─▶ Silero VAD per 512-sample window
     ─▶ SpeechSegmenter (speech ≥ 200 ms starts; 600 ms silence ends; 15 s max; 300 ms pad)
     ─▶ events: speechStart (barge-in) … partial (every 900 ms of audio, once ≥ 1.2 s) … speechEnd … final
     ─▶ sherpa-onnx OfflineRecognizer.decodeAsync (one at a time; finals before partials)
     │ stt:event
     ▼
VoiceSession (renderer, pure TS) ─▶ CommandListener ─▶ 'command' (know / dont_know / bye) | 'question' (text for the AI)
```

Expected latency on a 4-core Intel: final transcript ≈ **600 ms (end-of-speech silence) + 50–350 ms decode**
after the learner stops talking; the first partial of a longer sentence arrives after ~1.2 s of speech.

## Main-process API

`src/main/stt/engine.ts`

```ts
const stt = new SttEngine({ modelDir, variant?: 'moonshine-base' | 'moonshine-tiny' | 'parakeet-v3', threads?, vad?, partialEveryMs?, autoDownload? });
stt.status()                                   // { state: 'missing'|'downloading'|'loading'|'ready'|'error', variant, downloadBytes, progress, error, sessions, confidence }
await stt.download()                           // resumable, sha256-verified; progress via stt.on('status')
await stt.start(sessionId, { sampleRate: 16000 })
await stt.pushAudio(sessionId, Int16Array | Float32Array)
await stt.stop(sessionId)                      // resolves after the last final was emitted
stt.on('event', (e: SttEngineEvent) => …)      // see below
await stt.recognizeFile(wavPath)               // one-shot, any sample rate (tests, bench)
await stt.recognizeSamples(float32, 16000)
```

`SttEngineEvent` (type in `src/core/voice/session.ts`):

```ts
{ type: 'partial' | 'final'; text; confidence?; segmentId; sessionId }   // confidence only with parakeet-v3
{ type: 'speechStart' | 'speechEnd'; sessionId; segmentId }             // speechStart = interrupt the tutor's TTS
{ type: 'error'; sessionId; message }
```

`segmentId` is `${sessionId}:${n}`; a command fires at most once per segment (CommandListener).

## IPC (`src/main/stt/ipc.ts`, registered by `registerSttIpc()` in `src/main/index.ts`)

Renderer → main (`ipcRenderer.invoke`):

| Channel | Args | Returns |
|---|---|---|
| `stt:status` | – | `EngineStatus` |
| `stt:download` | – | `EngineStatus` when the files are on disk |
| `stt:cancelDownload` | – | – |
| `stt:start` | `sessionId: string`, `{ sampleRate?: number }` | `EngineStatus` (loads / downloads the model first) |
| `stt:push` | `sessionId`, `ArrayBuffer` of Int16 mono PCM at the session rate | – (resolves when the VAD consumed it) |
| `stt:stop` | `sessionId` | – after the last final |
| `stt:recognizeFile` | `path` | `{ text, confidence?, durationSec, decodeMs }` |

Main → renderer (every window): `stt:event` (`SttEngineEvent`), `stt:progress` (`EngineStatus`).

## Renderer side (to add)

Preload (`src/preload/index.ts`) and `src/shared/api.ts` need:

```ts
stt: {
  status: () => ipcRenderer.invoke('stt:status'),
  download: () => ipcRenderer.invoke('stt:download'),
  start: (id: string, opts?: { sampleRate?: number }) => ipcRenderer.invoke('stt:start', id, opts),
  push: (id: string, pcm: ArrayBuffer) => ipcRenderer.invoke('stt:push', id, pcm),
  stop: (id: string) => ipcRenderer.invoke('stt:stop', id),
  onEvent: (fn: (e: SttEngineEvent) => void) => { const h = (_: unknown, e: SttEngineEvent) => fn(e); ipcRenderer.on('stt:event', h); return () => ipcRenderer.off('stt:event', h); },
  onProgress: (fn: (s: EngineStatus) => void) => …,
}
```

Capture (renderer):

```ts
const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
const ctx = new AudioContext();                      // the device rate (44.1/48 kHz); do not force 16 kHz on macOS
await ctx.audioWorklet.addModule('pcm-worklet.js');  // served from the app:// scheme next to the renderer bundle
const node = new AudioWorkletNode(ctx, 'pcm16k');
node.port.onmessage = (e) => window.api.stt.push(sessionId, e.data);   // ArrayBuffer, transferable
ctx.createMediaStreamSource(stream).connect(node);
```

`pcm-worklet.js` (AudioWorkletProcessor): take `inputs[0][0]` (128-sample Float32 frames at the context
rate), low-pass + linearly resample to 16 kHz (or copy `src/core/voice/audio.ts` `Resampler`), convert to
Int16, and `port.postMessage(buffer, [buffer])` every 320–640 samples (20–40 ms). Keep frames ≤ 40 ms so the
VAD lag stays small; batching bigger than ~100 ms only adds latency. `echoCancellation: true` matters: the
tutor's own TTS plays through the speakers while the mic is open, and the AEC in Chromium keeps most of it out
of the VAD (barge-in still works because the learner's voice is louder at the mic).

Wiring (renderer, pure TS, `src/core/voice/session.ts`):

```ts
const voice = new VoiceSession({ mode: 'off', sessionId });
voice.attach(window.api.stt.onEvent);
voice.on('speechStart', () => tts.stop());                  // barge-in
voice.on('command', (c) => c.intent === 'know' ? next() : c.intent === 'dont_know' ? explainAgain() : endSession());
voice.on('question', (q) => askTutor(q.text));
voice.on('partial', (p) => showLiveTranscript(p.text));
voice.setMode('commands');      // during the 7 s pause after an explanation
voice.setMode('conversation');  // while talking with the tutor ("I know" is then an answer, not a command)
```

Rules: in `commands` mode the three commands fire (two agreeing partials or a final) and any other final
becomes a `question`; in `conversation` mode only "bye bye" is a command, everything else is a `question`;
"bye bye" switches the mode to `off`; `speechStart` is emitted in both active modes.

## Packaging (electron-builder, `package.json`)

- `asarUnpack`: `node_modules/sherpa-onnx-node/**` and `node_modules/sherpa-onnx-darwin-*/**` (the addon
  `require`s `../sherpa-onnx-darwin-<arch>/sherpa-onnx.node`; Electron redirects that into `app.asar.unpacked`).
  The `.node` links `@rpath/libsherpa-onnx-c-api.dylib` and `@rpath/libonnxruntime.dylib` with
  `@loader_path` as rpath, so the dylibs load from the same unpacked folder; **no `DYLD_LIBRARY_PATH`** is
  needed (the addon's error message suggesting it only applies when the binary could not be found at all).
- `files` excludes `node_modules/sherpa-onnx-{linux,win}-*/**`.
- Sizes: darwin-arm64 package 34 MB unpacked (`libonnxruntime.dylib` 29 MB, `libsherpa-onnx-c-api.dylib`
  4.3 MB, `sherpa-onnx.node` 0.6 MB); darwin-x64 37 MB. Only the package for the build's arch is needed, but
  `npm install` installs only the one matching the dev machine: before `dist:mac` for both arches run
  `npm install --no-save --os=darwin --cpu=x64 sherpa-onnx-darwin-x64@1.13.8` (and `--cpu=arm64 …-arm64`) so
  both are present, or build each arch on its own machine. Unused arch packages are harmless (asar-unpacked
  bytes only); add `!node_modules/sherpa-onnx-darwin-x64/**` to `files` for an arm64-only build if size matters.
- sherpa's `libonnxruntime.dylib` (1.28) and onnxruntime-node's (1.30) coexist in one process (macOS
  two-level namespace; verified on Linux too).
- Notarization: the dylibs and the `.node` inside `app.asar.unpacked` are signed by electron-builder like the
  onnxruntime-node ones; hardened runtime needs no extra entitlement for them.
- Models are not in the app: downloaded on first use into `<userData>/models/stt/` (`STT_MODEL_DIR`
  overrides): `silero_vad.onnx` + `sherpa-onnx-moonshine-base-en-quantized-2026-02-27/` (135 MB).
- Info.plist already has `NSMicrophoneUsageDescription`.

## Bench

`node scripts/stt-bench.mjs [--variant …] [--threads N]` synthesises three sentences and the three commands
with Kokoro, streams them through the engine (VAD + partials + finals) and prints WER, latency and command
detection. Numbers from the 4-core Intel Xeon sandbox (sherpa-onnx 1.13.8, 3 threads) are in the engine
report; on Apple Silicon expect 3–5x faster decodes.

## Tests

`test/unit/stt-vad.test.ts` (segmenter, resampler, ring buffer), `test/unit/stt-session.test.ts`
(VoiceSession with fake events), `test/unit/stt-tar.test.ts` (tar reader, download bookkeeping, confidence).
`voice-commands` / `voice-turns` cover the classifier and the CommandListener.

## Remaining

- Preload bridge + `api.ts` types, the AudioWorklet and the mic UI (permission prompt, level meter, the
  "download 111 MB" consent card using `stt:progress`).
- Parakeet hotwords (`modified_beam_search` + `bpeVocab` derived from `tokens.txt`) to bias "I know" /
  "I don't know" / "bye bye"; not enabled because greedy search is 2x faster and Moonshine has no hotwords.
- Real accented-speech evaluation (the bench uses Kokoro's British voice; Mandarin-L1 recordings would decide
  between Moonshine base and Parakeet on Apple Silicon).
- Optional: the sherpa keyword spotter as an audio-level confirmation of the three commands.
