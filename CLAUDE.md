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
- `src/panel-css.js` styles; `tools/` build scripts; `test/` tests; `test/music.js` synthesised test songs with known beats.

## Commands
- Unit tests: `npm test` (34). Fixtures: `node tools/make-fixtures.js` (needs ffmpeg).
- Chrome e2e: `node test/e2e.mjs` (55 steps, ~15 min; `ONLY=regex` for some steps, `DEBUG=1` for dumps).
- iPhone / iPad e2e: `node tools/build-userscript.js && node test/e2e-mobile.mjs` (23), `IPAD=1 ...` (23).
- Release: bump `manifest.json` version, `npm run zip` (also rebuilds the userscript), copy to the scratchpad, send.
- Git: work on branch `claude/admiring-mccarthy-60ce4w`, commit + push; no PRs unless asked.

## Facts learned the hard way
- Chrome's player plays Opus 7.8 ms after the source time; our decoded timeline matches the player within ~1 ms (tests use `PLAYER_DELAY = 0.0078`).
- YouTube sends overlapping audio pieces and re-sends the init header after jumps: keep audio as clusters keyed by time (`chunksFor`), compare headers by bytes.
- The AudioContext needs a user gesture: any key/click on the page starts it (zero-gap loops need it).
- AAC (mp4) audio can't be tested here (Chromium has no AAC); Chrome on Mac gets Opus.

## State (v2.3.0) and ideas next
- Done: exact beat grid + tempo changes, Q 1/4 1/8 1/16 / bar, grid by hand, hot cues, beat loops, zero-gap loops with a status light, Follow button, pinch at the mouse, drum chart, WAV/original download, trainer 10/30/50/70, lyrics + chords + Practice.
- Limits: hi-hats under a snare/crash hidden; ride shows on the hi-hat row; snares masked by piano can be missed; reggae one-drop may lock off-beat (use "1 here").
- Wait for real-song feedback from the owner before big new changes.
