# Claude Eyes

A small menu-bar app for voice calls with Claude or ChatGPT. **When you start speaking, it takes a screenshot of your screen and sends it to the chat**, so the AI can see what you are looking at.

- Listens to the **microphone only** (never the computer's sound). It changes no volume, gain or audio setting.
- **One screenshot, then it waits 60 seconds.** No speech = no screenshot.
- Green icon = working, yellow = stopped. A green check flashes when a picture was sent. Click the icon for the menu.

## Where the picture goes (menu → "Send the picture to")
| Choice | How it works |
|---|---|
| **Chrome: claude.ai / chatgpt.com** (default) | Goes into your chat tab **in the background**. You never leave your page. Needs the small Chrome extension (below). |
| Claude desktop app / ChatGPT desktop app | The app cannot be fed in the background, so it is brought forward for about half a second, the picture is pasted, and you are put straight back on your page. |
| Only copy it | Puts the picture on the clipboard; you paste. |

If Chrome isn't available, it automatically falls back to whichever desktop app is open. The menu always shows what happened last ("sent to claude.ai in Chrome ✓" or why not).

## Only react to my voice (optional)
Menu → **Learn my voice…**, then read the text it shows (about 12 seconds, quiet room, alone). The app keeps a small "voiceprint" (192 numbers, **no audio**) on your computer only. Then turn on **Only react to my voice**:
- Your first word still triggers the picture immediately, but the picture is **sent about 2 seconds later**, after the app has checked that it was really you.
- Other people, and any voice coming out of the speakers (Claude's own voice), are ignored, and an ignored voice does not start the wait between screenshots.
- The menu's last line shows the score ("ignored: not your voice (0.29, needs 0.6)" or "[voice 0.75]"). If it ignores you too often, set **Voice match → Relaxed**; if other voices get through, set **Strict**.
- **Forget my voice** deletes the voiceprint. The 40 MB speaker-recognition model (NVIDIA TitaNet-small) is downloaded once from GitHub the first time you use this.

Honest limits: this was tested with computer-generated voices (10 different speakers, room echo, noise, a simulated laptop speaker), **not yet with real people**. Test results: your voice near the mic scored 0.72–0.81; other voices near the mic almost always below 0.6 (about 3% came close or above); voices from a speaker across the room scored below 0.4. A cold, a different microphone position or a noisy room lowers your own score. It is a convenience filter, not a security lock.

## Install (Mac)
1. Unzip, drag **Claude Eyes** to **Applications**.
2. First time only: **right-click → Open → Open** (macOS warns about apps from outside the App Store). If it still refuses, run once in Terminal: `xattr -cr "/Applications/Claude Eyes.app"`
3. Allow **Microphone**, **Screen Recording** (then quit and reopen the app once) and **Accessibility** when asked (reopen this window any time: menu → *Check permissions…*).
4. Menu → **Set up the Chrome extension…** and follow the 3 clicks (Chrome's *Developer mode* → *Load unpacked* → pick the folder it shows you). A green **ON** badge on the extension means it is connected.

## Development
```
npm install
npm test          # unit tests (features vs. reference, voice logic, bridge, paste scripts, ...)
npm run test:e2e  # real app + fake microphone + real screen capture + real window switching (needs xvfb, xdotool, openbox)
npm run test:ext  # real Chromium + the real extension + mock claude.ai / chatgpt.com pages
npm run test:voice # real app + fake microphone playing a conversation (you, other people, a 'Claude voice' through a speaker)
npm run test:full # the whole chain: fake speech → app → screenshot → extension → chat tab
npm start
```
Source: `src/` (app), `extension/` (Chrome extension). The app and the extension talk over `127.0.0.1` only, and the app accepts only this extension (checked by its fixed ID).
