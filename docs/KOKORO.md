# Kokoro: the local neural voice

Kokoro-82M (Apache-2.0, hexgrad) runs in a worker thread of the Electron main process through
`onnxruntime-node`, with espeak-ng (WebAssembly, the `phonemizer` package, in the same worker) for
grapheme-to-phoneme. The model's own duration
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
sha1(model version, voice, speed, text), capped at 300 MB (LRU by mtime), plus a 96-entry memory LRU.
Long texts are cached per clause segment (see "Smooth playback" below).

## Speed (scripts/kokoro-bench.mjs)

Measured on this Linux CI box, a 4-vCPU Intel Xeon @ 2.8 GHz (AVX-512, no turbo, noisy neighbours), Node 22,
onnxruntime-node 1.30.0, voice bf_emma, three sentences of 5–8 s each:

| Model | Threads | RTF (synthesis s / audio s) | Notes |
| --- | --- | --- | --- |
| fp16 | 4 | 0.35–0.40 (2.5–2.9x real time) | one outlier at 0.66 |
| fp16 | 3 | 0.41–0.47 | the app default on a 4-core machine (cores − 1) |
| fp32 | 4 | 0.38–0.53 | same as fp16 |
| int8 | 4 | 2.1–2.7 | slower than real time: do not ship |

Model load: 1.7–2.5 s (fp16; up to 25 s on a cold disk), warm-up inference 0.5 s. First-sentence latency after load: ~2.1 s for a
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
   Then `speechRange` trims by energy: Kokoro gives the pause after a sentence or clause to its last phoneme
   (about 22 frames, 0.55 s), so the durations alone left ~0.6 s of silence at the end of every clip (15% of all
   audio). Speech = 10 ms RMS frames above max(−58 dBFS, peak − 45 dB) (not higher: the "f" of "wife." runs
   ~150 ms at −41 to −48 dBFS); 30 ms are kept before the first such frame and 80 ms after the last, plus a 15 ms
   linear fade-out. Word times are clamped to the kept audio. The result names the text's end punctuation
   (`endPunct`), and the renderer adds that pause before the next segment (`SEGMENT_PAUSE_MS`: , 180 ms; ; : — 280 ms;
   . ? ! 350 ms; `joinResults` does the same for a whole text). The cache key carries `AUDIO_FORMAT` (`trim2`), so
   WAVs made before are not reused (they age out under the 300 MB limit).
5. `ipc.ts` returns a WAV (16-bit) plus timings; the renderer's `AudioTtsEngine` plays it and fires `onWord`.

## Smooth playback (no silence between sentences)

The learner (4-core Intel MacBook Pro) heard "a few sentences, then a few seconds of silence, then it goes on".
Causes found, and what fixed them:

1. **Inference blocked the Electron main process.** onnxruntime-node's `session.run()` and
   `InferenceSession.create()` are synchronous native calls (the JS wrapper only defers them with
   `setImmediate`), so each sentence froze the main thread for its whole synthesis (2.5–3.7 s for a normal
   sentence, 10 s for a long one, 2–25 s at model load). Every IPC reply waited behind it, including the reply
   for a sentence that was already synthesized and cached. Fix: the ONNX session and espeak run in a worker
   thread (`WORKER_SOURCE` in `engine.ts`, plain CommonJS evaluated from a string so no extra bundle entry is
   needed). Worst main-thread stall during reading: 13 s → 40 ms. If the worker cannot start (e.g. a packaged
   build where the worker cannot load onnxruntime-node from the asar), the engine logs it and falls back to the
   old inline mode; `KOKORO_INFERENCE=inline` forces it.
2. **The sentence needed now queued behind prefetches.** The renderer prefetched n+1 and n+2 through
   `tts:synthesize`, the same priority as the sentence to play, and *before* asking for it; the main queue was
   FIFO within a priority, so sentence n waited for n+1 and n+2 (first audio 12.9 s instead of ~3 s; after a
   seek or an explanation the same). Fix: one priority queue in the main process
   (`src/core/tts/segments.ts` `PRIORITY`): `now` (a speak() waiting: reading or an explanation) > `next` (the
   sentence after the one playing) > read-ahead (`ahead − distance`) > plain `prepare()`. Playback
   asks for the current sentence first; read-ahead goes through `kokoro:prepare` with priorities, and the next
   sentence is requested with `wait: true` (the call resolves when it is ready, then the renderer fetches it from
   the memory cache), so it never competes as `now` with an explanation. Requests are deduped (one job per cache
   key, every caller gets the result, a later request raises the priority).
3. **Long sentences took long to synthesize, and a running job cannot be interrupted.** Texts over 180 characters
   are split into clause segments of ≤ 150 characters (`synthesisSegments`: sentence ends, then ; : —, then
   commas; never after "Mr."). The renderer plays them back to back with word timings shifted to the sentence
   (one sentence for the highlighter); the main process uses the same split for `prepare()`/`synthesize()` of
   whole texts, so both share one cache entry per segment. A 398-character sentence: first audio 11.1 s → 3.0–3.4 s.
   Small jobs also bound how long a `now` request can wait behind read-ahead (one segment).
4. **Read-ahead was too short.** Two sentences (renderer) + five (ReaderView), only when a sentence started.
   Now Playback hands the engine up to 8 sentences / ~60 s of speech; the Kokoro engine queues all of them (each
   call replaces the previous list, so a seek drops stale work) and pause/stop clears the queue
   (`stopReadAhead`). Cloud voices still fetch only two ahead (they cost money). ReaderView's own background
   prepare of the next five was removed: sent before Playback's request for the sentence needed now, it made Play,
   resume and seek wait for the next sentence first (+0.8 to +2.7 s measured). Instead `Playback.prime()` asks for
   the start position (and the two after it) when a book opens and after a seek while paused.
5. **Decode/setup per sentence.** The next sentence's audio element is created and `load()`ed while the current
   one plays, so its start is just `play()` (`AudioTtsEngine.lastStartDelayMs` records it). HTMLAudio is kept
   rather than Web Audio buffers because `playbackRate` on an `AudioBufferSourceNode` changes the pitch.
6. **Threads.** The old default `min(4, cores − 1)` counted Hyper-Threading cores: 4 threads on a 4-core/8-thread
   Intel Mac, leaving nothing for the renderer and the main process. Now `defaultThreads()`: physical cores − 1,
   2..4 (3 on that Mac; `KOKORO_THREADS` overrides). On the 4-vCPU bench box (quiet): 1 thread RTF 0.78-0.85,
   2 → 0.49-0.51, 3 → 0.36-0.40, 4 → 0.33-0.37, but 4 was not reliably faster than 3 and 17-40% slower with one other
   core busy. Intra-op spinning stays on: off (`KOKORO_SPIN=0`) used 13-25% less CPU but was 4-16% slower at 3
   threads; the switch is for an A/B on the Mac. Speech recognition, which decodes in the 5-second windows while
   Kokoro synthesizes the explanation ahead, takes 1-2 threads on an Intel Mac (`defaultSttThreads`, `STT_THREADS`
   overrides).
   **Measuring on the Mac:** Settings → Diagnostics shows the threads, spinning, model load and warm-up times, the
   CPU (model, logical CPUs, physical cores from `sysctl -n hw.physicalcpu`), and the median and p90 real-time factor
   of the last 50 synthesized segments (the engine keeps the last 100 with their characters, synthesis ms, audio
   seconds, queue wait and priority; **Copy diagnostics** includes them all), plus the AI's median time to its first
   words per model (`ttftMs` / `totalMs` in the usage records).
7. **Model load at first play.** The model loads and warms up in the background 1.5 s after start-up when the
   Dream voice is chosen and on disk (`warmUpKokoro`, `src/main/tts.ts`), so the first sentence does not pay the
   ~3–6 s load.

The Mac voice path (`webspeech.ts`) had one way to go silent: when Chromium loses an utterance's `onend`, the
end watchdog only fires after twice the expected duration + 5 s. An idle check now ends the utterance 1.5 s
after the synthesizer reports nothing speaking or queued (and at least half the expected time has passed).
The pause between sentences is the `pauseBetweenSentencesMs` setting, intended: 350 ms by default since the clips
are trimmed (a stored 250, the old default, becomes 350 once). Measured on the bench box (45 clause segments and 12
sentence pairs of Pride and Prejudice, fp16): silence at a clip end 640 ms → 130 ms (median, −40 dBFS); at a sentence
boundary 860 ms → 510 ms (Kokoro reading both sentences in one call: 470 ms); dead air 15% → 3.7% of the audio.

Listening stops: the word a stop says 3 times goes to `kokoro:prepare` in the read-ahead call of the sentence before
(priority `nextWords`, after that sentence) and again, at `soon` with `wait`, in the call of its own sentence (a
separate call would be dropped by that call's `replace`); that call's read-ahead holds only the next sentence. Cut →
word ready, measured with the app's request pattern (3 threads): median 2.4 s (1.2–3.9 s) before; now 0 ms (0–0.3 s)
with the queue idle and 0 ms when a long read-ahead job is running as the sentence starts (it was 0.6–2.8 s).

### Measured (scripts/kokoro-bench.mjs, 4-vCPU Xeon @ 2.8 GHz, fp16, bf_emma)

`--sim` reads the first 10 sentences of Pride and Prejudice in real time (two long ones of 257 and 398
characters, three very short ones) with the app's request pattern, and reports silence beyond the 250 ms pauses.

| | before | after |
| --- | --- | --- |
| time to first audio (first sentence, model loaded) | 12.9 s | 3.2–3.6 s |
| gaps > 300 ms in 10 sentences | one of 7.2 s (sentence 6) | none |
| worst main-thread stall while reading | 13.2 s (11 stalls > 300 ms) | 40 ms |
| long sentence (398 chars), time to first audio | 11.1 s | 3.0–3.4 s |
| model load main-thread stall | 2–21 s | < 0.1 s |
| `--threads 1` (a much slower CPU): first audio / gaps | — | 6.8 s / none |

`--policy legacy` replays the old renderer request pattern on the new engine: first audio is still 12.1 s,
which isolates the renderer-side priority inversion (fixed in Playback/AudioTtsEngine).

## IPC

`kokoro:status`, `kokoro:download`, `kokoro:cancelDownload`, `kokoro:voices`,
`kokoro:synthesize(text, voice, speed, {asFile?})`, `kokoro:prepare(items)`; events on `kokoro:progress`.
The existing `tts:synthesize` / `tts:voices` channels accept engine `'kokoro'` as well; that is what
`speak()` uses (priority `now`). `kokoro:prepare` items may carry `priority` and `wait`, plus the control items
`{ text: '', replace: true }` (replace the read-ahead) and `{ text: '', release: true }` (the renderer cancelled
its speech: its waiting requests become ordinary read-ahead); see `src/main/kokoro/ipc.ts` and `ipc-prepare.ts`.

## Voices

British: bf_emma (default, grade B-), bm_george, bf_isabella, bm_fable, bm_lewis, bf_alice, bf_lily,
bm_daniel. American: af_heart (A), af_bella (A-), af_nicole, am_michael, am_fenrir, … (grades from the
Kokoro model card). All 54 vectors are in `voices-v1.0.bin`; `src/main/kokoro/voices.ts` lists the English ones.

## onnxruntime-node version (important)
onnxruntime-node is pinned to **1.23.2**: it is the newest release that ships macOS **x64** (Intel) binaries;
1.30 ships darwin/arm64 only, so Kokoro and the Silero VAD would fail on Intel Macs. The fp16/fp32 models load
and run on 1.23.2 (bench on a 4-core x86: RTF ≈ 0.48); the int8 file does not load on 1.23 (and is slower anyway).
