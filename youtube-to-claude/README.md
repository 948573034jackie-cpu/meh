# YouTube to Claude / ChatGPT (Chrome extension)

Helps you learn English from YouTube videos with Claude (claude.ai) or ChatGPT (chatgpt.com), both in Chrome. Pick the target with the two buttons in the popup; the radio buttons choose where pause-sentences go.

**Button:** on a YouTube video page, click the extension icon → *Send this video to Claude*. Claude gets the link and the full transcript (as an attached text file).

**Pause:** when you pause the video (Space, click, or the pause button):
1. the last ≤3 sentences (under 30 seconds, ending at the sentence you stopped in) appear very big over the video,
2. they are sent to Claude with their timestamps (the first time for a video/chat, the link + full transcript are sent too),
3. the video replays those sentences once, then stops with the sentences still on screen. Press Space to continue.

Both pause features can be turned off in the popup, and **Text size** (Auto / Large / Extra large / Huge / Giant) sets how big the words are. Sentences are rebuilt as complete sentences (not cut mid-sentence like YouTube's subtitles) and fill about 30 seconds.

## Install
1. Download and unzip https://github.com/948573034jackie-cpu/meh/releases/download/claudesnap-latest/YouTube-to-Claude.zip
2. `chrome://extensions` → Developer mode → Load unpacked → choose the unzipped folder.
3. Pin the extension. Keep a claude.ai tab open (or it opens one for you). Refresh your YouTube tab once.

## Limits
- Needs a video with captions (typed or auto-generated) or YouTube's "Show transcript".
- Ads are ignored. Only youtube.com/watch pages.
- If claude.ai changes its layout, the sending step may need an update; the popup shows why a send failed.
