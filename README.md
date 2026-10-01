# Learn English with YouTube + Claude / ChatGPT

Everything is on the release page: https://github.com/948573034jackie-cpu/meh/releases/tag/claudesnap-latest

| What | File | For |
|---|---|---|
| **YouTube → Claude / ChatGPT** (Chrome extension) | `YouTube-to-Claude.zip` | Chrome on a computer |
| **YT Learn** (iPhone + iPad app) | `YTLearn-unsigned.ipa` or `YTLearn-Xcode-project.zip` | iPhone, iPad |
| ClaudeSnap Voice (Chrome extension: screenshot when you speak) | `ClaudeSnap-Chrome.zip` | Chrome |
| ClaudeSnap (Mac app: screenshot when you speak) | `ClaudeSnap.zip` | macOS 12+ |

## The idea (YouTube → Claude / ChatGPT, extension and iPhone/iPad app)
1. Pick **Claude** or **ChatGPT** as your chat.
2. Watch a YouTube video. **Pause it** (Space / tap).
3. The last ~25 seconds appear over the video as big, clear, complete sentences (only the subtitles, nothing else). Text size is a 1–10 slider.
4. The video plays that part again once. In its last second the text is sent to your chat with one plain instruction: explain it like an English teacher, then repeat the sentences — no greetings, titles or bullet points. The first time for a video, the link and full transcript go with it.
5. Talk about it. Say **“let's go”** (or press ▶ / Space / Enter): the video jumps back to the start of that part and keeps playing.

* Chrome extension: see `youtube-to-claude/README.md`
* iPhone / iPad app: see `ios/README.md`

## How it was tested
* The JavaScript that does the work is shared by the extension and the iPhone/iPad app (`youtube-to-claude/`, copied into `ios/YTLearn/Scripts/`).
* `tests/app-js-test.js` runs it (fake YouTube + fake Claude/ChatGPT pages) in **Chromium and WebKit (Safari's engine)** on every push.
* The iPhone/iPad app is compiled by Xcode on a Mac server, started in an **iPhone Simulator**, and tried against the real m.youtube.com and chatgpt.com on every push.
* Not verifiable from the build servers: signing in to Claude/ChatGPT (needs your account) and YouTube captions from a home connection (YouTube shows a bot check to data-centre connections). If something fails on your side the extension / app shows the exact reason on screen or in its “Last:” line.
