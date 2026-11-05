# My tutor: YouTube English (Chrome extension)

Your own AI English teacher on YouTube, with your own API key (Claude). Version 3.5: the tutor is the only mode
(sending the video to the Claude / ChatGPT websites was removed).

## Install
1. Download and unzip https://github.com/948573034jackie-cpu/meh/releases/download/level-check-latest/YouTube-to-Claude.zip
2. `chrome://extensions` → Developer mode → Load unpacked → choose the unzipped folder. (Updating: copy the new files over
   the old folder, then press the reload arrow of the extension.)
3. Pin the extension. Click its icon → **All settings** → API keys: paste your Claude key → Save → Test. (Optional: a
   Microsoft key for the free natural voice, an OpenAI key for the OpenAI voice and live call.)
4. Open a YouTube video with subtitles. The tutor is on (the **My tutor** button under the video turns it off and on).

## What happens
1. **Level Check** before the video: tap the words you know (made from this video only), or "Skip, just play".
2. The AI analyzes the video **once** (the cheap model) and writes the explanations of the coming stops. Then
   **Listening mode**: at the hardest sentences the video stops (a hard word is said 3 times and waits for "I know"), the sentence is heard, explained (spoken
   and shown), heard again, and goes on by itself.
3. Tap a word on the page: it is explained; double tap: I know it. ⚙ on the page: quick settings (voice, sizes, the part
   length, your level…). 📞: a voice call with Claude about the part. 📖: Listening mode (all subtitles as a page).
4. **Your vocabulary file**: All settings → Level Check shows the one command that installs the small Mac helper; then
   every word and test goes to `~/Documents/MEH English/vocabulary.json`, with copies in iCloud Drive ▸ MEH English and
   Google Drive ▸ MEH English (when Google Drive for desktop is installed). The iPhone app (YT Learn) can share that file.
5. Click the icon → **🩺 Check for problems** when something is wrong: copy the report and send it.

## Subtitles: seven ways, saved, and your own file
The extension tries these in order and uses the first one that looks right (its times must fit the length of the video):
1. a subtitle file you loaded yourself (.srt / .vtt / .txt) in the extension window,
2. the copy saved the last time you watched this video,
3. the video's caption file, 4. the same list the YouTube phone app uses, 5. YouTube's transcript service,
6. the subtitles the player itself downloads (it switches CC on for a moment and back off), 7. the "Show transcript" panel.

## Limits
- Needs a video with captions (typed or auto-generated) or YouTube's "Show transcript".
- Only youtube.com/watch pages. Ads are ignored.
- The microphone is used only while the tutor waits for you (I know / I don't know, a question, a call, voice mode);
  allow it for youtube.com the first time.

## Older versions
The website-sending versions (2.x – 3.4) are in the git history and described in `YOUTUBE-TUTOR-ALL-IN-ONE.md` (3.3).
