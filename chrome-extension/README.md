# ClaudeSnap Voice (Chrome extension)

Everything happens inside Chrome. When you speak, the extension:

1. screenshots the page you are reading (the visible tab of your Chrome window),
2. attaches the picture to your **claude.ai** tab (in the background — no tab switching, so you never lose your place),
3. ignores sound while the claude.ai tab is playing audio, so Claude's own voice does not trigger it.

Your voice itself goes to Claude through claude.ai's own voice mode.

## Install (2 minutes)

1. Download and unzip: https://github.com/948573034jackie-cpu/meh/releases/download/claudesnap-latest/ClaudeSnap-Chrome.zip
2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, choose the unzipped folder.
3. Click the puzzle icon in Chrome and **pin** ClaudeSnap Voice.
4. Click its icon → **Open**. The first time, a setup tab asks for the microphone: click **Allow microphone** and choose **Allow**. Then click the icon → **Open** again.
5. Keep a claude.ai tab open (start your voice chat there), go to the page you are reading, and speak.

The icon shows **ON** while listening, **OK** after a picture is sent, and **!** if something is missing (no claude.ai tab open, or nothing to screenshot).

## Limits

- It can only screenshot pages **inside Chrome**, not other apps.
- Pages such as `chrome://…` and the Chrome Web Store cannot be captured.
- A picture is sent only when you speak, and at most one per minute (60 s after a send, the next time you speak). In silence nothing is sent.
- While Claude is talking, your voice is ignored (this is how Claude's voice is filtered out).
- It relies on the claude.ai page having an attach-image input or message box; if claude.ai changes, the attach step may need an update.
