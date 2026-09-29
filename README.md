# Claude Eyes

A tiny menu-bar app for voice calls with Claude. **When you start speaking, it instantly takes a screenshot and puts it into Claude's chat**, so Claude can see what you're talking about before you finish your sentence.

## How it behaves

- **Only your microphone is listened to.** It never records or analyses the computer's sound (Claude's voice, YouTube, music). It doesn't change any volume: no volume control, no auto-gain, no echo cancel, no audio output. Your YouTube / speaker / mic volumes stay exactly as they are.
- **Nothing is recorded or sent anywhere except the screenshot.** The app only measures "is someone speaking right now?"; audio is never saved.
- **One screenshot, then it waits one minute.** The first time you speak → 1 screenshot (within ~0.1 s of your first word). After that it ignores speech for 60 seconds (change under *Wait between screenshots*: 30 s / 1 / 2 / 5 min). If you don't speak, it takes nothing.
- **Icon in the top-right menu bar** (Mac) / system tray (Windows): 🟢 green = working, 🟡 yellow = stopped. Click it for the buttons:
  - **Screenshot when I speak: ON/OFF**: the on/off switch (OFF also releases the microphone completely)
  - Paste into Claude app automatically
  - Microphone sensitivity (Low / Normal / High)
  - Wait between screenshots
  - Send a test screenshot now
  - Start when I log in (on by default, so it's always there after you open your computer)

## Install

Build the app on your own computer (needs [Node.js](https://nodejs.org) installed, one time):

```
git clone https://github.com/948573034jackie-cpu/meh.git && cd meh
git checkout claude/desktop-voice-call-app-3avr4d
npm install
npm run dist        # makes the installer in the dist/ folder (.dmg on Mac, .exe on Windows)
```

Or just try it without installing: `npm install && npm start`.

(The repo also has a GitHub Actions workflow that builds the Mac and Windows installers automatically and uploads them as *Artifacts*, when GitHub Actions is available for your account.)

**First time on Mac** (the app isn't signed by Apple, so macOS asks you to confirm):
1. Open the `.dmg`, drag *Claude Eyes* to Applications, then **right-click → Open** once.
2. Allow **Microphone** when asked.
3. Click *Send a test screenshot now*. Allow **Screen Recording** (System Settings → Privacy & Security), then quit and reopen the app.
4. Allow **Accessibility** when asked (this is what lets it press ⌘V to paste into Claude).

**Windows**: run the installer (click *More info → Run anyway* if SmartScreen warns), allow the microphone if Windows asks.

## How the screenshot reaches Claude

The screenshot is copied to the clipboard, then the **Claude desktop app** is brought forward for a split second, the picture is pasted (⌘V / Ctrl+V), and focus jumps back to whatever you were using. If the Claude app isn't open, the screenshot just stays on your clipboard and you get a notification. Turn off *Paste into Claude app automatically* if you'd rather paste yourself.

Tip: use **headphones**. With loudspeakers, a loud Claude voice can leak into the microphone and count as "speech" (it will still only cause one screenshot per minute).

## For developers

```
npm install
npm test          # 32 unit tests: voice detector, settings, icons, paste scripts
npm run test:e2e  # real Electron app + fake microphone playing a scripted recording + real screen capture (needs xvfb on Linux)
npm start         # run it
```

- `src/vad.js`: speech-onset detector (adaptive noise floor, 60 ms onset, 1.2 s hang-over, 60 s screenshot interval)
- `src/listener.js` / `audio-worklet.js`: hidden page that reads the microphone (all audio processing off, no output device)
- `src/screenshot.js`: captures the display the mouse is on
- `src/deliver.js`: clipboard + paste into the Claude app (macOS AppleScript / Windows PowerShell / Linux xdotool)
- CI (`.github/workflows/build.yml`) runs all tests, validates the Mac/Windows paste scripts on real Mac/Windows machines, and builds the installers.
