# DJ Wave Looper for YouTube

A Chrome extension for practising music on YouTube. It's made for singers learning by ear and for instrument players.

![Wave Looper panel](docs/screenshot.png)

- **See the whole song as a DJ waveform** in a panel at the bottom of the page. Colours show the sound: orange/red = bass, green = mids, blue = highs.
- **Loop any part:** click where it starts, then click where it ends. It loops forever.
- **Slow it down:** 50%, 75% and 100% buttons, plus − / + in 5% steps. The key stays the same, so you can still sing along.
- **Speed trainer:** start slow (30–90%) and get faster every loop until you reach 100%, over 15, 30 or 50 loops. Then it plays 10 times at full speed and stops by itself.
- **Pause between loops** (0.5–3 s) to breathe before each repeat.
- **Saved parts** (Verse, Chorus…). Your loop and speed are remembered for every video.

## Install (2 minutes)

1. Download this repository (green **Code** button → **Download ZIP**) and unzip it.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json` in it).
5. Open any YouTube video. You'll see a new waveform button in the player controls (bottom right of the video). You can also click the extension icon or press **Alt+L**.

## How to use

| What you want | What to do |
|---|---|
| Make a loop | Click the wave at the start, then click at the end. Or drag across the part. |
| Fine-tune the loop | Drag the green **A** / red **B** flags, or use the ‹ › buttons (0.05 s; Shift = 0.01 s, Alt = 0.5 s). |
| Zoom in / zoom out | Press **Zoom in**: the wave shows only about 30 s around what is playing and scrolls along with the song. Press **Whole song** to see everything again. You can also scroll on the wave to zoom, and 🔍 zooms to your loop. |
| Open the looper | Waveform button in the video controls (bottom right), the **Wave Looper** button under the video next to Like/Share, the extension icon, or **Alt+L**. |
| Make the wave bigger | Press the ↕ buttons (top right of the panel), or drag the top edge of the panel up. |
| Jump somewhere | Click the time ruler at the top of the wave. |
| Set A/B while listening | Press **[** at the start and **]** at the end. |
| Loop on/off | **Loop** button or **\\**. |
| Slow down | **50% / 75% / 100%**, or − / +. Click the big % number to reset to 100%. |
| Speed trainer | **Trainer** → pick *from*, *to*, *over N loops* → **Start**. After reaching full speed it plays 10 times, then stops by itself. |
| Breathing pause, pitch | ⚙ settings. Turn **Keep pitch** off for tape-style slow-down (50% = one octave lower, handy for working out fast solos). |
| Undo a loop change | ↶ button. |
| Turn it all off | ✕ closes the panel and resets speed to 100%. |

Space, the arrow keys and every other YouTube shortcut keep working as usual.

### About the waveform "reading"

YouTube only downloads the song a little at a time. The first time you open a song, the looper **reads the whole song**: it plays it muted at high speed for a few seconds (usually 5–20 s), then puts you back exactly where you were. After that the wave is saved, so it shows instantly next time. You can turn this off in ⚙. If you do, the wave fills in as you listen, or you can press **Read whole song** whenever you like.

Works on `www.youtube.com` (watch pages, theatre mode and fullscreen) and `music.youtube.com`.

## For developers

```
src/inject.js     page-world tap: reads the audio YouTube feeds to Media Source Extensions, decodes it, makes waveform peaks
src/content.js    panel UI, loop engine, speed + trainer, scan, storage
src/core.js       pure logic (time format, trainer ramp, PeakStore), unit tested
src/panel-css.js  panel styles (inside a shadow root)
src/background.js toolbar button + Alt+L
```

```
node tools/make-fixtures.js   # test media (needs ffmpeg)
npm test                      # unit tests: logic + WebM/MP4 parsers
npm run e2e                   # loads the real extension in Chromium on a simulated YouTube page (needs playwright)
npm run zip                   # dist/dj-wave-looper.zip for the Chrome Web Store
```

The end-to-end test serves a fake YouTube watch page that streams media through MSE the way YouTube does, with YouTube's Trusted Types policy. It covers 31 steps: scan and position restore, waveform accuracy, making the wave bigger, the click-click loop, loop timing (under 80 ms overshoot), speed buttons, YouTube resetting the speed, the trainer ramp, the trainer stopping after N full-speed plays, the button under the video, flag dragging, nudge, undo, zoom, keyboard keys, breath pause, saved parts, the end-of-video guard, switching videos, ads, fullscreen and console errors.
