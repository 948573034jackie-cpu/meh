# My tutor: learn English with YouTube and your own AI key

Everything is on the release page: https://github.com/948573034jackie-cpu/meh/releases/tag/level-check-latest

| What | File | For |
|---|---|---|
| **My tutor** (Chrome extension) | `YouTube-to-Claude.zip` | Chrome on a Mac / computer |
| **YT Learn** (iPhone + iPad app: YouTube inside it, with My tutor) | `YTLearn-unsigned.ipa` or `YTLearn-Xcode-project.zip` | iPhone, iPad |
| ~~YT Safari~~ (the Safari extension app) | no longer built: the app, YT Learn, is the iPhone version | — |
| ClaudeSnap Voice / ClaudeSnap (a screenshot when you speak; a separate tool) | `ClaudeSnap-Chrome.zip`, `ClaudeSnap.zip` | Chrome / macOS 12+ |

## The idea
1. Open a YouTube video. My tutor reads the subtitles.
2. **Level Check**: a 2-minute tap test made only from this video's words (B2, C1, C2 + idioms + slang). Or skip it.
3. The video is analyzed **once** (Claude Haiku by default, cheap). Then it plays in Listening mode: at the hardest
   sentences it stops (a hard word: said 3 times, "I know" skips it; each kind of stop has its own share), plays the sentence, explains it (spoken and shown), plays it again, and goes on
   by itself. Tap a word = explain it; double tap = I know it.
4. Your words, tests and level go into **one vocabulary file** (`vocabulary.json`), shared by the Mac and the iPhone
   (iCloud Drive or Google Drive). **Copy my level for Claude** gives Claude your level in one paste.

* The Chrome extension: `youtube-to-claude/README.md` · the iPhone app: `ios/README.md` · everything it can do: `FEATURES.md`.

## How it is tested
* `dream-ext/` (TypeScript) is My tutor. It is built into `youtube-to-claude/dream/` and copied into the iPhone app and
  the Safari extension, so all three run the same code.
* On every push: the unit tests, the real extension in Chrome on a test YouTube page with a test AI
  (`tests/dream-e2e.js`, `tests/level-check-e2e.js`), the Safari extension and the app's scripts in WebKit (Safari's
  engine), and the app compiled by Xcode and started in an iPhone Simulator.
* Not verifiable from the build servers: real API keys, a real microphone and speakers, and YouTube on a data-centre
  connection (it shows a bot check there).
