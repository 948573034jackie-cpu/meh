# DJ Wave Looper: notes for Claude (read first in every new session)

## Who it's for and how to work with them
- The owner is a singer and musician practising songs from YouTube (singing, drums, timing). Writes casual English, sometimes Chinese. Answer in short, plain English.
- Main version: **Chrome extension on a MacBook Pro** (trackpad). Second: **iPhone/iPad script** in Safari via the free *Userscripts* app.
- Always **test everything before sending**, then send files directly with SendUserFile: the zip `dist/dj-wave-looper.zip` (Mac) and `userscript/wave-looper.user.js` (iPhone). Say plainly what was and wasn't tested.
- Prefers few, deep, well-tested changes. Ask for a song link + time + screenshot when something "feels wrong" on real songs (tests here only use simulated YouTube).

## Layout
- `src/inject.js`: page world. Hooks MSE `appendBuffer`, decodes audio (16 kHz) into 50 bins/s: peak, low/mid/high, att/atv (sharpest attack, 0.1 ms), sub/lmid/air (drum bands). Keeps WebM clusters per video by time (zero-gap loop audio, downloads).
- `src/content.js`: the panel (shadow DOM), waveform, loops, trainer, lyrics/chords, practice, beat grid UI, Follow, Grid row, drum chart, downloads.
- `src/core.js`: pure logic (unit-tested): PeakStore, beatGrid (tempo path + beats on drum attacks + one straight grid or constant-tempo regions like Mixxx), drumHits (kick/snare/tom/hat/cym/perc), lyrics/chords helpers.
- `src/stems.js`: pure stem maths (torch-compatible STFT/iSTFT, radix-2/3 FFT, UVR-style chunking, sinc resample, SDR); used by the page and the offscreen page.
- `src/offscreen.js` + `offscreen.html`: ONNX Runtime Web (wasm, `src/vendor/ort/`, 4+ threads via COEP credentialless / COOP) runs the MDX-Net models (`kuielab_a_{vocals,drums,bass}.onnx`, ~30 MB each, from the UVR GitHub release, cached in Cache API `ytl-stem-models-1`). content → SW (`ytl-stems`) → offscreen (`ytl-stems-job`) → back (`ytl-stems-out`); audio as base64 int16.
- Stems in content.js: `ST` state, `stemsTick` asks inject for 9-s parts (+1-s margins) at the stream's native rate (48 kHz Opus), the loop's parts first; stems kept as Int16 per song (`ST.song`, "other" = part − vocals − drums − bass of the same decode, `song.mix` too); `stemsAlign` lines each part up with its neighbours, `stemLoopBufs` lines the loop's own decode up with them (±10 ms search), then 4 `AudioBufferSourceNode`s + gains replace the loop's single source (`slSwitchToStems`). Shadowing: `half` (0 with / 1 without) on trainer / lineLoop, gains scheduled at the exact wrap time (`applyStemGains`).
- `src/panel-css.js` styles; `tools/` build scripts (`get-models.js` fetches the models for tests); `test/` tests; `test/music.js` synthesised test songs with known beats and a formant `sing()` voice.

## Commands
- Unit tests: `npm test` (38). Fixtures: `node tools/make-fixtures.js` (needs ffmpeg); models for the stem tests: `npm run fixtures:models` (git-ignored, 85 MB). Real models offline: `npm run test:stems` (~20 s).
- Chrome e2e: `node test/e2e.mjs` (57 steps, ~20 min; `ONLY=regex` for some steps, `DEBUG=1` for dumps; the stems step prints SDR per stem and writes `/tmp/ytl-shots/stems-dump.json`). Stems subset: `DEBUG=1 ONLY='^page loads|player button opens|DJ deck is on|auto scan|^stems:|^shadowing' node test/e2e.mjs`.
- iPhone / iPad e2e: `node tools/build-userscript.js && node test/e2e-mobile.mjs` (23), `IPAD=1 ...` (23).
- Release: bump `manifest.json` version, `npm run zip` (also rebuilds the userscript), copy to the scratchpad, send.
- Git: work on branch `claude/admiring-mccarthy-60ce4w`, commit + push; no PRs unless asked.

## Facts learned the hard way
- Chrome's player plays Opus 7.8 ms after the source time; our decoded timeline matches the player within ~1 ms (tests use `PLAYER_DELAY = 0.0078`).
- YouTube sends overlapping audio pieces and re-sends the init header after jumps: keep audio as clusters keyed by time (`chunksFor`), compare headers by bytes.
- The AudioContext needs a user gesture: any key/click on the page starts it (zero-gap loops need it).
- AAC (mp4) audio can't be tested here (Chromium has no AAC); Chrome on Mac gets Opus.
- Two decodes of the same Opus audio are sample-exact only at the native rate (48 kHz): Chrome's per-decode 48→44.1 k resampling makes offsets sub-sample. Decode at the native rate, resample ourselves (`toCtxBuffer`). Each decode still sits a whole-ms step off (WebM times are ms): line parts up by cross-correlation (the stems then add up to the loop at ~65 dB).
- The MDX vocals model only "hears" a voice with pitch motion: vibrato ~half a semitone, scoops into notes. A plain sawtooth+formants gets 1 dB; with vibrato/glides 13 dB (`test/music.js sing()`).
- Through Opus 128k the waveform match to the truth is only ~10 dB (codec noise), so e2e stem thresholds are vocals 7 / drums 6 / bass 7 dB; offline (no codec) vocals ~14, drums ~10, bass ~14.
- The model download URL redirects to release-assets.githubusercontent.com (no CORS): host permissions for github.com + release-assets/objects.githubusercontent.com; the offscreen page fetches with credentials omit. Verified from the real extension's offscreen page in Chromium (through the sandbox proxy: 200, 29.7 MB, crossOriginIsolated, 4 threads); the e2e tests serve the models from a local http server via `dataset.ytlModelBase`.

## State (v2.4.0) and ideas next
- Done: exact beat grid + tempo changes, Q 1/4 1/8 1/16 / bar, grid by hand, hot cues, beat loops, zero-gap loops with a status light, Follow button, pinch at the mouse, drum chart, WAV/original download, trainer 10/30/50/70, lyrics + chords + Practice, AI stems (vocals/drums/bass/other on/off, solo) + Shadowing (with / without the stem, 30→100%, nonstop) in Trainer, line practice and Practice. Chrome only (Safari has no offscreen page / threads).
- Stems memory: ~18 bytes per sample per channel-pair → ~500 MB for a 10-min song at 48 kHz (`STEM_MAX_DUR` 600 s). Separation speed in the sandbox: 9 s of audio ≈ 45 s with 4 wasm threads; a MacBook should be several times faster. WebGPU backend would be the next speed-up.
- Limits: hi-hats under a snare/crash hidden; ride shows on the hi-hat row; snares masked by piano can be missed; reggae one-drop may lock off-beat (use "1 here").
- Wait for real-song feedback from the owner before big new changes.
