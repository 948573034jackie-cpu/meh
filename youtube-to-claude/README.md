# YouTube to Claude / ChatGPT (Chrome extension)

Learn English from YouTube videos with Claude (claude.ai) or ChatGPT (chatgpt.com), both in Chrome.

**Pick a mode** at the top of the popup: *Claude* or *ChatGPT*. Everything goes to that chat.

**Button:** *Send this video to …* sends the video link + full transcript (as a text file).

**When you pause the video** (Space, click, or the pause button):
1. The last **~25 seconds** of speech appear over the video as **one tight paragraph of complete sentences** (YouTube's cut-off subtitles are rebuilt into real sentences). The sentence you paused in is yellow.
2. The video plays that part again **once at normal speed**, then stops.
3. **When it has stopped**, the passage is sent to your chat (the first time for a video, with the link + full transcript too). The chat is asked to just repeat the passage, nothing else.
4. Talk about it with Claude/ChatGPT. When you are done, say **“bye bye”** (or press **Enter**): the video jumps back to the start of that part and plays on at normal speed. (Space just continues from where it stopped.)

**Popup settings:** replay on/off, **text size slider (14 small steps, 6 = medium)**, send the transcript on/off, “bye bye” on/off.

## Install
1. Download and unzip https://github.com/948573034jackie-cpu/meh/releases/download/claudesnap-latest/YouTube-to-Claude.zip
2. `chrome://extensions` → Developer mode → Load unpacked → choose the unzipped folder. (Updating: copy the new files over the old folder, then press the reload arrow.)
3. Pin the extension. Refresh your YouTube tab and your Claude/ChatGPT tab.
4. The first time you use “bye bye”, Chrome asks to allow the **microphone for youtube.com** — click Allow.

## Limits
- Needs a video with captions (typed or auto-generated) or YouTube's “Show transcript”.
- Use a normal text chat (not voice mode) in Claude/ChatGPT — voice mode has no text box to type into. The bottom of the video shows ✓ or ✗ with the reason.
- “bye bye” uses Chrome's speech recognition (needs internet). With speakers, the AI saying “bye bye” could trigger it; headphones avoid this. Enter always works.
- Ads are ignored. Only youtube.com/watch pages.
