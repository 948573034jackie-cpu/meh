# YouTube to Claude / ChatGPT (Chrome extension)

Learn English from YouTube videos with Claude (claude.ai) or ChatGPT (chatgpt.com), both in Chrome.

**Pick a mode** at the top of the popup: *Claude* or *ChatGPT*. Everything goes to that chat.

**Button:** *Send this video to …* sends the video link + full transcript (as a text file).

**When you pause the video** (Space, click, or the pause button):
1. The last **~25 seconds** of speech appear over the video as complete sentences: each sentence on its own line with a gap between, while tiny phrases stay with a neighbouring sentence (YouTube's cut-off subtitles are rebuilt into real sentences). The sentence you paused in is yellow.
2. The video plays that part again **once at normal speed**, then stops.
3. **In the last second of the replay**, the text you just read is sent to your chat (the first time for a video, with the link + full transcript too), together with one plain instruction: explain this part like an English teacher (what is happening, what they talk about, the important idea), then repeat the sentences — directly, no greeting, titles, headings or bullet points.
4. Talk about it with Claude/ChatGPT. When you are done, say **“bye bye”** (or press **Enter**): the video jumps back to the start of that part and plays on at normal speed. (Space just continues from where it stopped.)

**Popup settings:** replay on/off, **text size slider (1–10 in quarter steps, 6 = medium, 10 = the biggest)**, send the transcript on/off, “bye bye” on/off.

## Install
1. Download and unzip https://github.com/948573034jackie-cpu/meh/releases/download/claudesnap-latest/YouTube-to-Claude.zip
2. `chrome://extensions` → Developer mode → Load unpacked → choose the unzipped folder. (Updating: copy the new files over the old folder, then press the reload arrow.)
3. Pin the extension. Refresh your YouTube tab and your Claude/ChatGPT tab.
4. The first time you use “bye bye”, Chrome asks to allow the **microphone for youtube.com** — click Allow.

## Sending (how it presses Send)
It types the message, then clicks Send. If the message is still in the box it presses Enter (the send key in ChatGPT), and if the page ignores that, it sends a real Enter key press through Chrome itself (this is why the extension asks for the *debugger* permission; Chrome may flash a "started debugging this browser" bar for a moment). After every try it checks that the message really left the box.

## Limits
- Needs a video with captions (typed or auto-generated) or YouTube's “Show transcript”.
- Use a normal text chat (not voice mode) in Claude/ChatGPT — voice mode has no text box to type into. The bottom of the video shows ✓ or ✗ with the reason.
- “bye bye” uses Chrome's speech recognition (needs internet). With speakers, the AI saying “bye bye” could trigger it; headphones avoid this. Enter always works.
- Ads are ignored. Only youtube.com/watch pages.
