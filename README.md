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

## Install (Mac)
1. Unzip, drag **Claude Eyes** to **Applications**.
2. First time only: **right-click → Open → Open** (macOS warns about apps from outside the App Store). If it still refuses, run once in Terminal: `xattr -cr "/Applications/Claude Eyes.app"`
3. Allow **Microphone**, **Screen Recording** (then quit and reopen the app once) and **Accessibility** when asked (reopen this window any time: menu → *Check permissions…*).
4. Menu → **Set up the Chrome extension…** and follow the 3 clicks (Chrome's *Developer mode* → *Load unpacked* → pick the folder it shows you). A green **ON** badge on the extension means it is connected.

## Development
```
npm install
npm test          # unit tests
npm run test:e2e  # real app + fake microphone + real screen capture + real window switching (needs xvfb, xdotool, openbox)
npm run test:ext  # real Chromium + the real extension + mock claude.ai / chatgpt.com pages
npm run test:full # the whole chain: fake speech → app → screenshot → extension → chat tab
npm start
```
Source: `src/` (app), `extension/` (Chrome extension). The app and the extension talk over `127.0.0.1` only, and the app accepts only this extension (checked by its fixed ID).
