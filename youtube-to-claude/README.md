# YouTube to Claude / ChatGPT (Chrome extension)

Learn English from YouTube videos with Claude (claude.ai) or ChatGPT (chatgpt.com), both in Chrome.

**Pick a mode** at the top of the popup: *Claude* or *ChatGPT*. Everything goes to that chat.

**Button:** *Send this video to …* sends the video link + full transcript (as a text file).

**When you pause the video** (Space, click, or the pause button):
1. The last **~25 seconds** of speech appear over the video as complete sentences — **only the subtitles, nothing else** on the screen. Each full sentence has its own line; tiny phrases stay with a neighbouring sentence.
2. The video plays that part again **once at normal speed**, then stops.
3. **In the last second of the replay**, the text you just read is sent to your chat (the first time for a video, with the link + full transcript too), with one plain instruction: explain this part like an English teacher, then repeat the sentences — directly, no greeting, titles, headings or bullet points.
4. Talk about it with Claude/ChatGPT. When you are ready, say **“let's go”**, or press **Space**, the **play arrow**, click the video, or press **Enter**: the video jumps back to the start of that part and plays on through the rest of the video.

**Popup settings:** replay on/off, **text size slider (1–10 in quarter steps, 6 = medium, 10 = the biggest)**, send the transcript on/off, “let's go” voice command on/off.

## Install
1. Download and unzip https://github.com/948573034jackie-cpu/meh/releases/download/claudesnap-latest/YouTube-to-Claude.zip
2. `chrome://extensions` → Developer mode → Load unpacked → choose the unzipped folder. (Updating: copy the new files over the old folder, then press the reload arrow.)
3. Pin the extension. Refresh your YouTube tab and your Claude/ChatGPT tab.
4. The first time you use “let's go”, Chrome asks to allow the **microphone for youtube.com** — click Allow.

## Text size is stable
The size is tied to the video player's *current* size by the browser itself (CSS container units), so it can never get stuck huge or tiny: fullscreen and theater mode make it scale up and back down smoothly, there is a hard limit (14–120 px), and your slider setting is kept.

## Sending (how it presses Send)
It types the message, then clicks Send. If the message is still in the box it presses Enter (the send key in ChatGPT), and if the page ignores that, it sends a real Enter key press through Chrome itself (this is why the extension asks for the *debugger* permission; Chrome may flash a "started debugging this browser" bar for a moment). After every try it checks that the message really left the box.

## Limits
- Needs a video with captions (typed or auto-generated) or YouTube's “Show transcript”.
- Use a normal text chat (not voice mode) in Claude/ChatGPT — voice mode has no text box to type into. The bottom of the video shows ✓ or ✗ with the reason.
- “let's go” uses Chrome's speech recognition (needs internet). With speakers, the AI saying “let's go” could trigger it; headphones avoid this. Space / Enter / the play arrow always work.
- The subtitles are loaded in the background as soon as the video opens, so the first pause is instant. The popup's “Last:” line shows how many seconds each send took.
- Ads are ignored. Only youtube.com/watch pages.

## Picture for Claude, and no repeated words
* With **Claude** selected, every pause sends the words **and a picture of the video** (the frame where you paused, without the subtitles on top). **ChatGPT** gets the words only. You can turn the picture off in the extension window ("Claude only: also send a picture…").
* YouTube's automatic subtitles repeat the end of one line at the start of the next line. The extension now removes these repeats, so every sentence appears once.
