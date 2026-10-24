# DJ Wave Looper for YouTube

A Chrome extension for practising music on YouTube. It's made for singers learning by ear and for instrument players.

![Wave Looper panel](docs/screenshot.png)

- **See the whole song as a DJ waveform** in a panel at the bottom of the page. Colours show the sound: orange/red = bass, green = mids, blue = highs.
- **Loop any part:** click where it starts, then click where it ends. It loops forever.
- **Zero-gap loops:** B runs straight into A with no pause and no click, like a DAW or a looper pedal. A **green light on Loop** means the loop plays from memory with zero gap (amber: getting ready; red: why not, in its tooltip). YouTube sends the audio in pieces that overlap and resends the header after a jump: the looper keeps each piece of audio once, by its time, so loops anywhere in the song are zero-gap, also after jumping around. The loop's sound is decoded at full quality and plays from memory, sample-exact; the video plays along silently and follows every jump, so lyrics and the playhead stay right. Works with slow speeds (same pitch engine), the Trainer and line practice. Falls back to a normal loop while it gets ready, with a breath pause, or during ads; on by default on computers, switch **Seamless loop** in ⚙ (also on iPad if you like).
- **Slow it down:** 30%, 50%, 75% and 100% buttons, plus − / + in 5% steps. The key stays the same, so you can still sing along.
- **Studio-quality slow-down:** when you slow a song down, the sound goes through a studio time-stretch engine (like warping in a DAW) instead of the browser's basic one, so voices and instruments stay clean, without the robotic, watery sound. At 100% the sound is untouched. You can switch it off in ⚙ (**Studio-quality slow-down**).
- **Speed trainer:** tap **Trainer** and it starts right away at 30%. Every loop gets a little faster: **10, 30, 50 or 70 loops** up to 100%, then **5, 10, 10 or 10 more at 100%**, and it stops by itself. Tap **Trainer** again to stop and go back to normal speed. **Too fast?** Press a slower speed while it runs: the trainer steps back to the loop that plays at that speed, so you get those loops again.
- **Stems (AI), by themselves: the vocals, drums, bass or the rest alone.** Every song you open is split into **Vocals, Drums, Bass** and **Other** (guitars, keys, everything else) by an AI separation model (MDX-Net, the kind used by Ultimate Vocal Remover), right in your browser: nothing is uploaded, and the result is **saved on your computer**, so the next time you open the song its stems are there at once. It runs in the background while you practise (the part you are looping first) and never takes the song over: parts whose audio the page has not loaded yet follow as the song plays through them (on the first visit the whole song is read anyway, for the wave). Only when you mute, solo or shadow a stem on a loop whose audio is not there, that part is read once, muted. A thin bar under the stem buttons shows how far it is. On a Mac with WebGPU the models run on the graphics chip; otherwise on a few processor threads. Each stem is a little mixer strip in the row above the wave: click its **name to mute** it (vocals off to sing with the band), **S to solo** it (drums only to work on timing), **⇆ to shadow** it (below). The first time it downloads the models once (about 85 MB, kept by Chrome). Stems play through the zero-gap loop engine, so set an A–B loop with **Seamless loop** on (the default on computers); until the stems of your loop are ready the loop plays as usual. Songs up to 10 minutes; the last 12 songs are kept. ⚙ → **Stems: song / loop (4 WAV)** downloads all four as WAV files. Turn it off in ⚙ (**Stems by themselves**) if you want the computer quiet. Chrome only.
- **Shadowing: listen, then it's your turn.** Press **⇆** on a stem (the vocals, say). From then on every play of your loop comes **twice**: first **with** that stem (listen), then **without** it (your turn: you sing or play that part while the rest of the band keeps going), at whatever speed you are on. A badge over the wave says **LISTEN** or **YOUR TURN**. With the **Trainer** (or a line's ⟳, or **Practice**) it starts slow and gets a little faster with every pair of plays up to 100%, then keeps going at 100%, listen / your turn, nonstop, until you stop it. If the stems are not ready yet it waits for them at the current speed.
- **Lyrics next to the wave:** tap **Lyrics** (♪). It reads the song name from the YouTube title (it ignores words like *Official Video*, *Acapella*, *Instrumental* or *Remastered 2009*, and understands titles like `Song | Artist`, `BTS 'Dynamite'`, `周杰倫【告白氣球】` or `YOASOBI「夜に駆ける」`) and finds the lyrics in [LRCLIB](https://lrclib.net), a free lyrics database. When the lyrics have timings, the current line lights up and scrolls along, and you can tap a line to jump there. **Practise one line:** tap the ⟳ at the left of a line (or the left edge of the line). That line speeds up from 30% to 100% with the Trainer's counts (10 plays, then 5 at 100% by default), then it stops and your speed goes back to what it was (a running Trainer keeps its place). Tap ⟳ again to stop early: your speed comes back and the song carries on (your A–B loop if you have one). The line shows on the wave in purple with **[ ]** edges: drag them to make the line loop start earlier or end later, just like the A / B flags. Wrong song? Tap ⏭ for the next match, or type the song name and artist and press Enter. For **a cappella / vocals-only** videos the lyrics line themselves up with where the singing starts, and music videos with silence before the song skip that silence; for any version you can fine-tune the timing with **◀ 0.1s / 0.1s ▶** (saved per video).
- **Everything for the loop sits right above the wave:** play / pause, **A** / **B** with their ‹ › buttons, **Loop**, undo and clear. Speeds, the Trainer and the view buttons are in the top row.
- **Song parts:** small labels like **VERSE 1**, **PRE-CHORUS**, **CHORUS**, **BRIDGE**, **OUTRO** sit above the lyrics. They come from the chord sheet when you paste one, otherwise the looper works them out from the lyrics (lines that come back are the chorus, the part before each chorus is the pre-chorus, a one-off part late in the song is the bridge).
- **Download the audio** (⚙ → Download): the whole song or your A–B loop as a **WAV** file (plays in Music, GarageBand, any player), or the whole song as the **original** audio file from YouTube (smaller, same quality). It is made from the audio the page already received, so the looper reads the whole song first if needed. For your own practice: please respect the artists' rights.
- **Practice (one button, top right of the lyrics):** the whole song, part by part. Each part speeds up from 30% to 100% (the Trainer's 10 / 30 / 50 loops), plays 5 or 10 times at 100%, then the next part starts by itself. When every part is done the whole song plays once from the start at 100%, then it stops. Optional rest between parts in ⚙. Press ▶ during a rest to go on straight away; tap **Practice** again to stop.
- **Chords like Ultimate Guitar:** tap **Chords** → **Find on Ultimate Guitar** (opens the search for this song). On the chords page select all and **Copy**, come back and tap **Paste**. The chords (Fmaj7, Fm7, B7b13, C/E…) are placed over the exact word where they change, intro chord rows and section names included; lines the sheet wrote only once (a repeated chorus) get their chords too. **♭ / ♯** transposes. Saved per video. (Ultimate Guitar has no public API and doesn't allow other apps to pull its pages, so this copy-and-paste is the reliable way; ChordPro text like `[Am]Hello [F]world` works too.)
- **Loop from the lyrics → Trainer:** tap **A** at the right of the first line and **B** on the last line: exactly those lines loop and the Trainer starts on them.
- **Timing you can trust:** lyrics move in **0.1 s** steps. For a cappella videos the looper finds where every line's singing starts in the waveform and lines each lyric line up with it (not just the first line), so loops start right on the first syllable.
- **Pause between loops** (0.5–3 s) to breathe before each repeat.
- **Saved parts** (Verse, Chorus…). Your loop and speed are remembered for every video.

## Install (2 minutes)

On a Mac (MacBook) or PC, in Chrome:

1. Download this repository (green **Code** button → **Download ZIP**) and unzip it.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json` in it).
5. Open any YouTube video. You'll see a new waveform button in the player controls (bottom right of the video). You can also click the extension icon or press **Alt+L** (**Option+L** on a Mac).

## iPhone and iPad (Safari)

Chrome on iPhone/iPad can't run extensions, so there is a **script version** that runs in Safari through the free **Userscripts** app. Same panel and features, made for fingers:
- **DJ wave:** the wave scrolls under a playhead in the middle. Slide your finger on the wave and the song moves with it, like a record. **A quick tap on the wave pauses / plays.** Holding your finger still holds the song; lift it to play on.
- **Double-tap the wave** to set **A** right there, then double-tap again where the part ends to set **B**: the loop starts playing. (A double tap never pauses the song.)
- **For drummers (laptop Chrome):**
  - **Drums view** (on by default on a computer): the wave is split into three layers like a DJ deck, kick and bass in **red**, the middle in **amber**, snare and hi-hats in **white**, each scaled on its own so quiet hi-hats still show.
  - **Drum chart under the wave**, one row per drum like drum notation: **CR** crash, **HH** hi-hat / ride, **PC** percussion (cowbell, woodblock, rim), **SN** snare / clap, **TT** toms, **KK** kick. Each hit is a note (brighter = harder), on the beat grid, with 1/16 lines when you zoom in; a crash shows its ring. Only the drums the song has get a row; hover a row to see its name. Each hit is sorted by six bands of the sound and how long it rings: a kick is a short boom under 100 Hz with the beater's click, a tom rings at 100-400 Hz with little hiss, a snare is a crack with its body, a hi-hat a short hiss above 5 kHz, a crash a long one. Claps on top of a four-on-the-floor kick are snares; an open hi-hat on every off-beat is a hi-hat. Tested on a full kit (every kick, snare, tom and crash found, no false ones) and on house, trap, hip-hop, pop and a piano ballad. Hi-hats right under a snare or crash hide behind it, and a ride shows on the hi-hat row.
  - **Beat grid:** the looper finds the tempo (BPM) and every beat, and finds the **1** of each bar (kick on 1 and 3, snare on 2 and 4; the 1 is also where the song starts and where new parts come in). Bar lines carry the bar number; zoom in and you see **1 2 3 4** on every beat.
  - **Follows the song's tempo:** most songs are played to a click and get one straight grid; songs that **speed up, slow down or jump to a new tempo** get a grid that follows them, like rekordbox's *Dynamic* analysis and Serato's new beatgrids. The looper follows the tempo through the song, finds every beat on the kicks and snares, and splits the song into parts of one tempo (like Mixxx), each with an exact grid that starts on the very beat where the tempo changes. A live drummer drifting slowly gets a smooth grid that follows them. A small tag on the wave shows the new tempo where it changes, and the BPM shows the tempo where you are. Tested on a jump from 90 to 120 BPM, speeding up from 100 to 130, slowing down at the end, a new tempo after a break, and a half-time bridge (no tempo change): every beat within 2 ms.
  - **Exact to the millisecond:** every beat is placed on the real attack of the drum hit (measured to 0.1 ms), and songs played to a click get one perfectly straight grid, so a fill, a breakdown or a quiet intro can't pull it off. A live drummer who speeds up gets a grid that follows them. Tested on pop, house, hip-hop with swing, trap, drum & bass, a piano ballad and a song with an intro and a breakdown: steady songs land within 1 ms of every beat as you hear it in the player.
  - **DJ mouse:** drag the wave and the song moves with it like a record; one click stops / plays; **double-click** sets **A**, double-click again sets **B** and the loop plays. **Shift+drag** draws a loop. The wave slides under a fixed playhead (DJ view). Prefer the old way? Turn off **DJ mouse** in ⚙.
  - **Follow** (top right of the wave, on each time you open a video): on, the wave moves with the song and the playhead stays in the middle. Off, the wave stays still: drag it anywhere (the song keeps playing where it is), click a spot to play from there, double-click for A / B. Two fingers sideways on the trackpad slide the wave too (Follow goes off).
  - **Pinch to zoom on the MacBook trackpad, right where the mouse is:** the spot under the mouse stays under the mouse, and a full pinch zooms about 15×. Zooming away from the playhead turns Follow off so the wave stays on the part you look at; press **Follow** to go back to the song.
  - **BPM, found by itself:** when you open the looper it reads and analyses the whole song straight away (a few seconds, muted), so the tempo, the beats and Q are ready when you start practising. Next time the song opens instantly from memory.
  - **Hot cues C1–C4:** click an empty pad to mark the spot (on the beat with Q), click it again to jump there and play. Shift-click or right-click clears it. Coloured markers show them on the wave.
  - **Q (auto quantize):** turn it on and A, B and the hot cues always land exactly on the grid, whether you click, drag, move a flag or press [ ]. ‹ › then move A or B by one step. Key: **q**. Beside Q pick what it snaps to: **1/4** notes (every beat), **1/8** notes (for a part that starts on the "and", like a vocal pickup), **1/16** notes, or the start of each **bar**; small ticks on the wave show the 1/8 and 1/16 spots.
  - **Beat loops 1 · 2 · 4 · 8 · 16:** like a DJ controller, loop that many beats from the beat you're on. Press another size while it loops and the length changes from the same start.
  - **Fix the grid by hand: Grid** (or click the BPM). Saved per song.
    - **Tempo:** type the right BPM and press Enter (works even when no beat was found). **½** / **2×** halve or double it.
    - **The "1":** **◂1** / **1▸** move the start of the bar one beat. **1 here**: stop on the first kick of a bar and press it; the whole grid slides so a bar starts exactly at the playhead.
    - **Move grid ◂ ▸:** slide the whole grid earlier or later by 5 ms (Shift-click: 1 ms) if it feels a little ahead or behind.
    - **Reset:** back to the grid the looper found.
- **DJ waveform:** coloured like Serato (red bass, green mids, blue highs) with a soft outer shape and a bright body, the played part greyed and a glowing playhead.
- **A / B like a DJ app (loop in / loop out):** tap the wave to stop, drag the wave to where the part starts and tap **A**, drag on to where it ends and tap **B**: it loops. As soon as both are set, the loop plays by itself. Drag the green **A** / red **B** flags anywhere (the A flag too, while it waits for B), or use ‹ › to move them by 1 second.
- **Loop from the lyrics:** each lyric line has an **A** button at its right. Tap it on the first line of the part, then tap **B** on the last line: exactly those lines loop and start playing (A and B on the same line = just that line). The looped lines are marked green / red at the edges.
- **↺ 5s** jumps back 5 seconds and plays (inside a loop it goes back to the loop start). **5s ↻** skips 5 seconds ahead.
- **Half and half:** the looper takes the bottom half of the screen, the lyrics fill the top half with big words. **A− / A+** change the word size, and the bar under the lyrics drags to make them taller or shorter. The layout button moves the lyrics back beside the wave.
- **Play / pause** button a little bigger than the others.
- **Pinch to zoom**, **Whole song** to see everything, tap the little map under the wave to jump.
- A round floating button opens the looper.
- **Voice calls:** the video keeps playing during a call (⚙ **Play along with voice calls**, on by default on iPhone/iPad; the silent switch / silent mode mutes it).
- **Tap the video** to pause / play.

1. Install **Userscripts** from the App Store (free; icon is `</>`).
2. Open the Userscripts app once and tap **Change Userscripts Directory**. Pick a folder, for example *On My iPhone → Userscripts*.
3. Save `wave-looper.user.js` into that folder. Get it from the `userscript` folder of this repo, or from the file sent to you. In Files, *Move* it into the Userscripts folder.
4. Go to **Settings → Apps → Safari → Extensions → Userscripts**. Turn it on and set **Permissions → youtube.com → Allow**. (On older iOS: *Settings → Safari → Extensions*.)
5. Open **youtube.com** in Safari and play a video. Tap the round **waveform button** at the bottom right. If Safari asks, tap **ᴀA → Userscripts → Always Allow on this website**.

Notes:
- **iPad** works best. Safari shows YouTube's desktop site there, the same one the Chrome version was built and tested on.
- **iPhone** uses the mobile site (m.youtube.com). Loop, speed and trainer work. The waveform needs YouTube to stream the audio the same way it does on desktop. If the wave stays empty on your iPhone, the loop and speed still work. Tell me and I'll look into it.
- Videos opened in the **YouTube app** can't be controlled. Use youtube.com in Safari.
- The same file also works in Tampermonkey or Violentmonkey on any desktop browser.

## How to use

| What you want | What to do |
|---|---|
| Make a loop | Click the wave at the start, then click at the end. Or drag across the part. |
| Fine-tune the loop | Drag the green **A** / red **B** flags (or the purple **[ ]** of a lyric-line loop), or use the ‹ › buttons (0.05 s; Shift = 0.01 s, Alt = 0.5 s). |
| Zoom in / zoom out | Press **Zoom in**: the wave shows only about 30 s around what is playing and scrolls along with the song. Press **Whole song** to see everything again. You can also scroll on the wave to zoom, and 🔍 zooms to your loop. |
| Open the looper | Waveform button in the video controls (bottom right), the **Wave Looper** button under the video next to Like/Share, the extension icon, or **Alt+L**. |
| Make the wave bigger | Press the ↕ buttons (top right of the panel), or drag the top edge of the panel up. |
| Jump somewhere | Click the time ruler at the top of the wave. |
| Set A/B while listening | Press **[** at the start and **]** at the end. |
| Loop on/off | **Loop** button or **\\**. |
| Slow down | **50% / 75% / 100%**, or − / +. Click the big % number to reset to 100%. |
| Speed trainer | Tap **Trainer**: it starts right away at 30% → 100% over 10 loops, then 5 at 100%. Choose *from* (30/50/75%) and 10 / 30 / 50 loops (then 5 / 10 / 10 at 100%) any time. Tap **Trainer** again to stop and go back to normal speed. |
| Stems (vocals / drums / bass / other) | They are made by themselves and saved. In the row above the wave: click a stem's **name** to mute it, **S** to solo it. Needs an A–B loop with Seamless loop on. The first use downloads the AI models once (about 85 MB). |
| Shadowing | Press **⇆** on the stem. Each play of the loop comes twice: with the stem (listen), then without it (your turn), at any speed. With the **Trainer**, a line's ⟳ or **Practice** it also goes slow to fast, then nonstop at 100%. |
| Lyrics | Tap **Lyrics** (♪). They're found automatically from the song name; the current line lights up when the lyrics have timings. Tap a line to jump there. ⏭ = next match; or type the song name and press Enter. |
| Play / pause | ▶ / ❚❚ button in the row right above the wave, next to **A** / **B**. |
| Breathing pause, pitch, sound quality | ⚙ settings. **Studio-quality slow-down** is on by default; turn it off if your computer struggles. Turn **Keep pitch** off for tape-style slow-down (50% = one octave lower, handy for working out fast solos). |
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
src/background.js toolbar button + Alt+L; relays stem jobs to the offscreen page
src/stems.js      stem separation maths (STFT/iSTFT like torch, chunking, resampling), unit tested; shared by the page and the offscreen page
src/offscreen.js  the offscreen page: downloads and caches the MDX-Net models, runs them with ONNX Runtime Web (WebGPU when it agrees with the processor, else wasm on up to half the cores)
src/ort-load.js   picks the WebGPU or the plain wasm build of ONNX Runtime for the offscreen page
src/vendor/signalsmith-stretch.js  Signalsmith Stretch 1.3.2 (MIT, Geraint Luff): pitch/time-stretch AudioWorklet
src/vendor/stretch-worklet.js      its worklet as a file (tools/make-worklet.js): YouTube's script policy refuses blob: worklets
src/vendor/ort/   ONNX Runtime Web 1.30.0 (MIT, Microsoft): wasm and WebGPU builds
```

```
node tools/make-fixtures.js   # test media (needs ffmpeg)
npm run fixtures:models       # downloads the three separation models (85 MB) into test/fixtures/models for the stem tests
npm test                      # unit tests: logic, WebM/MP4 parsers, beat grid, stem maths
npm run test:stems            # the real models on a synthesised band: every stem must come out clean (slow)
npm run e2e                   # loads the real extension in Chromium on a simulated YouTube page (needs playwright)
npm run e2e:userscript        # same steps against the userscript build
npm run e2e:mobile            # userscript on an emulated iPhone visiting m.youtube.com (touch, pinch, layout)
npm run e2e:ipad              # userscript on an emulated iPad (Safari's desktop site with touch)
npm run build:userscript      # userscript/wave-looper.user.js (Safari/iOS, Tampermonkey); built from src/
npm run zip                   # dist/dj-wave-looper.zip for the Chrome Web Store
```

The end-to-end test serves a fake YouTube watch page that streams media through MSE the way YouTube does, with YouTube's Trusted Types policy. The page is served with YouTube's own script policy (Trusted Types, nonce + strict-dynamic). It covers 58 steps, including the AI stems (made by themselves; the four stems add up to the loop to the sample, each stem checked against the parts the test song was made of, mute and solo while it loops, all four as WAV files, back at once from disk after a reload, another song's audio read by itself), shadowing on a plain loop at 75% and with the trainer (with, without, faster, nonstop at 100%), a pitch check that 50% speed still sounds at the right pitch (440 Hz stays 440 Hz): scan and position restore, waveform accuracy, making the wave bigger, the click-click loop, loop timing (under 80 ms overshoot), speed buttons, YouTube resetting the speed, the trainer ramp, the trainer stopping after N full-speed plays, the button under the video, flag dragging, nudge, undo, zoom, keyboard keys, breath pause, saved parts, the end-of-video guard, switching videos, ads, fullscreen and console errors.

## Credits

Slow-down audio uses [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) by Geraint Luff / Signalsmith Audio, MIT licence (see the header of `src/vendor/signalsmith-stretch.js`). Lyrics come from [LRCLIB](https://lrclib.net).

Stems are separated by the **MDX-Net** models (Music Demixing Challenge 2021) trained by [KUIELab](https://github.com/kuielab/mdx-net) (Minseok Kim, Woosung Choi), downloaded on first use from the [Ultimate Vocal Remover model repository](https://github.com/TRvlvr/model_repo) and kept in Chrome's cache; they run in the browser with [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (Microsoft, MIT licence). Nothing leaves your computer. The models are for personal practice; please respect the artists' rights.
