# YouTube → Claude / ChatGPT — what it can do

An English-learning tool for YouTube. Watch any video. When you stop, it shows the last ~30 seconds as big,
complete sentences, plays that part once more, and sends it to Claude (or ChatGPT). The AI explains it like an
English teacher, and you can talk about it with Claude (also by voice), then keep watching.

There are 3 versions:

| Version | Device | Where you use it |
|---|---|---|
| **Chrome extension** (v3.2) | Mac / computer | YouTube in Google Chrome, plus **My tutor** (section 7) |
| **YT Safari** (v2.9) | iPad / iPhone | YouTube in Safari (a small app that adds the extension to Safari) |
| **YT Learn** (v1.0) | iPad / iPhone | Its own app, with YouTube and Claude / ChatGPT inside |

---

## 1. Features, side by side

✅ = yes · ➖ = not in this version

| Feature | Chrome (Mac) | YT Safari (iPad/iPhone) | YT Learn (iPad/iPhone) |
|---|:-:|:-:|:-:|
| **ChatGPT / Claude buttons under the video** (green = on, red = off) | ✅ | ✅ | ✅ |
| Both red = **plain YouTube** (nothing happens, nothing sent, no microphone) | ✅ | ✅ | ✅ |
| Turning a button on sends the **link + full transcript once** | ✅ | ✅ | ✅ |
| Every stop sends **only the ~30 s part** (complete sentences, with its time) | ✅ | ✅ | ✅ |
| **Big subtitle screen** when you stop (one sentence per line, newest in yellow) | ✅ | ✅ | ✅ |
| **Replays the part once**, then stops | ✅ | ✅ | ✅ |
| **Continue**: back to the start of the part, then play to the end | ✅ (play / Space / Enter / "shut up") | ✅ (2nd tap) | ✅ (tap / "let's go") |
| **Tap the video** to stop + replay + send | ➖ (click pause) | ✅ (also full screen) | ✅ |
| **▶ / ❚❚ button** on the subtitle screen (play/pause only, sends nothing) | ✅ | ✅ | ✅ |
| **A− / A+** subtitle size buttons (saved) | ✅ | ✅ | ✅ |
| Subtitle size slider in the settings window | ✅ | ✅ | ➖ |
| **Picture for Claude** (subtitle screen, 1 s after you stop) | ✅ | ➖ (uses the picture card) | ✅ |
| **Picture only for Claude** (one picture with the sentences + question, no text) | option | ✅ (on) | ➖ |
| ChatGPT gets **words only** | ✅ | ✅ | ✅ |
| **Voice commands**: "hi bro" = stop + send, "shut up" = quiet + back to the part + play on | ✅ | option (off: keeps the mic free) | ✅ ("let's go" too) |
| Works with **Claude voice call** (steps out for a moment, sends, goes back in) | ✅ | ✅ (new voice session too) | ✅ |
| **Claude hears the video part** in the voice call | ✅ (video sound into the call) | ➖ (Apple does not allow it) | ✅ (app voice reads it into the call) |
| **Talk mode**: computer voice reads the answer (off by default, never during a call) | ✅ | ➖ | ✅ (app voice) |
| Claude rewrites each part as **complete, punctuated sentences** | ✅ | ✅ | ✅ |
| **Status line**: "Sent to Claude ✓" or "⚠ NOT sent: reason" | ✅ | ✅ | ✅ |
| **🩺 Check**: finds problems, report you can copy | ✅ | ✅ | ➖ |
| Load your own **subtitle file** (.srt / .vtt) | ✅ | ✅ | ➖ |

---

## 2. Subtitles: where they come from and how they are cleaned

**Seven ways to get them**, tried one after another until one works:

1. a subtitle file you loaded yourself (.srt / .vtt)
2. a saved copy (each video is saved after the first time, so it opens instantly)
3. YouTube's caption file
4. YouTube's phone-app captions
5. YouTube's transcript service
6. the subtitles the player itself loaded (CC switched on for a moment, then off again)
7. YouTube's "Show transcript" panel (waits until it is fully loaded)

**Checked**: times must fit the video's length, so a wrong-video transcript is refused.

**Cleaned**:

- doubled words ("the the") and repeated lines are removed
- [Music] and [Applause] are removed
- "code" is removed (`&#39;`, `&amp;`, `<font>`, `{\an8}`, time lines like `00:01:02.000 --> …`, `>>`, invisible characters)
- `[ __ ]` (YouTube's hidden swear word) becomes "(bleep)"

**Sentences**:

- built from punctuation, or from pauses when there is none
- a sentence never ends on words like "the", "and", "to" or "because"
- the part you get is ~30 seconds of whole sentences, never cut in the middle

---

## 3. How a stop works (step by step)

1. You stop the video: tap it (iPad), pause it, or say "hi bro" (Mac).
2. The ~30 s part before that point is picked, using whole sentences only.
3. The big subtitle screen appears.
4. The part plays once more at normal speed, then stops.
5. It is sent to the AI:
   - **Claude**: the words + a picture (Mac), or one picture with the words and question on it (iPad)
   - **ChatGPT**: the words only
6. The question asks for:
   - an English-teacher explanation in simple words
   - then the sentences again as complete sentences
   - no headings, no lists, no extra questions
7. You continue: tap again, press play, or say "shut up". The video goes back to the start of the part and keeps playing to the end.

---

## 4. Settings window (extension icon)

- Choose Claude or ChatGPT, or send the video by hand
- When I pause: show the last ~30 s and send it
- Replay the part once
- Claude: picture only
- Claude: also send a picture of the subtitle screen
- Show the buttons under the video
- Voice commands
- Voice call: step out for a moment, send, go back in
- Voice call: play the part into the call (Mac only)
- Talk mode (Mac only)
- Subtitle size slider (1–10)
- Load a subtitle file
- Last result
- 🩺 Check for problems + Copy report

*(On iPad, the two Mac-only options are hidden.)*

---

## 5. 🩺 Check: what it looks at

- the extension version and your settings
- the last send result
- the YouTube tab: does it answer? Is there a video? Subtitles? Is it muted? Mobile site? Are both buttons off?
- the Claude / ChatGPT tab: does it answer? Is it on screen? Is there a message box and picture upload? Is it in a voice session, and was the End button found?

It lists the problems in plain words. **Copy report** lets you send them for help.

---

## 6. Known limits (Apple / website rules)

- iPad Safari pauses pages you cannot see, so keep YouTube and claude.ai side by side (Split View).
- During any voice call, the iPad makes other sound quieter.
- On iPhone, YouTube must be the desktop site (aA → Request Desktop Website).
- Jumping back 30 s can take a moment while YouTube loads that part again.
- With a free Apple ID, the iPad apps must be reinstalled every 7 days (Sideloadly on the Mac).

---

## 7. My tutor (Chrome only, v3.2): your own AI teacher on YouTube

Two ways to learn, never at the same time (turning one on turns the other off):

- **Claude / ChatGPT** (the website call): everything above.
- **My tutor** (your own API key): Dream Read's teacher, on YouTube.

Before you watch, the AI reads the video:
- it rebuilds YouTube's broken subtitle lines into complete, punctuated sentences;
- it marks what is above your level: words, phrases and whole hard sentences (with short Chinese hints).

At every automatic stop:
1. The page shows the last 30 seconds (20 / 30 / 40 / 60) over the whole screen, big and clear.
2. A word is said 3 times (a hard sentence is played once from the video).
3. 5 seconds: **I know** (K) = unhighlighted, no explanation, the sentence plays again, on.
   **I don't know** (D), silence or anything else = explained; it stays highlighted and is explained again next time.
4. The explanation starts at once (the AI already wrote it while you waited), with **your own teacher rules**
   (RULE ONE for words, RULE TWO for sentences), in a natural voice, Chinese at the end.
5. The word 10 times, the sentence from the video.
6. A moment to ask by voice (a call with Claude). Quiet for 3 seconds = the video goes on. The dictionary card closes when the sentence plays again.

Your commands:
- **Pause** the video: the part plays again on the page, the teacher breaks it down in very easy English, you can
  ask, then the video goes back to the start of the part.
- **←** (left arrow): the last sentence is played, explained and played again.
- **"bye bye"** (or Esc): the AI stops at once and the video plays again from the start of what was explained.
- **Space** while the teacher talks: pause the teacher and ask.
- **📞 Call** (Shift+T): a voice call about what is on the screen, with **Claude** (your Claude key) or OpenAI's live voice (real time, you can interrupt).
- **Shift+L**: listening mode (all subtitles over the screen, the playing line near the middle) / normal video.
- **[ ]**: smaller / bigger text; **Shift+C**: Chinese under every line (live AI translation). All keys can be changed.

Everything can be changed right on the YouTube page (⚙): text sizes (any size), part length, voice (OpenAI marin /
cedar…, ElevenLabs, Mac), speed, microphone sensitivity, live call on/off, your level, the AI model, your teacher's
instructions (write anything), how many repeats, the API keys and the shortcuts.

📒 My Vocabulary: every explained word and sentence with its explanation, Chinese and a link to that moment in the
video; CSV download; progress per level (A1 to C2).

Keys: Claude (explanations) and/or OpenAI (the voice, the live call, or everything). One key is enough to start.

---

## 8. Downloads

https://github.com/948573034jackie-cpu/meh/releases/tag/claudesnap-latest

- `YouTube-to-Claude.zip`: Chrome extension (Mac)
- `YTSafari-unsigned.ipa`: YT Safari (iPad / iPhone)
- `YTLearn-unsigned.ipa`: YT Learn (iPad / iPhone)
