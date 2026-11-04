# YouTube → Claude / ChatGPT — what it can do

An English-learning tool for YouTube. Watch any video. When you stop, it shows the last ~30 seconds as big,
complete sentences, plays that part once more, and sends it to Claude (or ChatGPT). The AI explains it like an
English teacher, and you can talk about it with Claude (also by voice), then keep watching.

There are 3 versions:

| Version | Device | Where you use it |
|---|---|---|
| **Chrome extension** (v3.4) | Mac / computer | YouTube in Google Chrome, plus **My tutor** (section 7) |
| **YT Safari** (v3.4) | iPad / iPhone | YouTube in Safari (a small app that adds the extension to Safari), plus **My tutor** (section 7) |
| **YT Learn** (v1.0) | iPad / iPhone | Its own app, with YouTube and Claude / ChatGPT inside, plus **My tutor** (section 7) |

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
- On iPhone, sending to Claude / ChatGPT needs YouTube's desktop site (aA → Request Desktop Website). My tutor works on the phone's site too.
- Jumping back 30 s can take a moment while YouTube loads that part again.
- With a free Apple ID, the iPad apps must be reinstalled every 7 days (Sideloadly on the Mac).

---

## 7a. Level Check and smart stops

Before a video, book, PDF or text: **Check my words** (a tap test built only from this text: B2, C1, C2 + idioms + slang; tap what you know, then Done) or **Skip, just play**. ⚙ → "Ask Level Check before every video" turns it off.

**Each video is analyzed once.** After Level Check the AI writes the explanations of the coming stops in one go (the cheap model, Claude Haiku; a better one can be chosen in All settings), a part at a time ahead of where you are. They are saved with the video, so the stops make no AI call and watching again costs nothing. Then it goes into Listening mode by itself. A tap on a word asks the AI once for that word; pausing is just a pause; "Explain 30 s" uses the cheap model too.

The tutor stops at **50% of the sentences or fewer**, only the hardest, and never because of a word you know. At a stop: the sentence from the video, the explanation (spoken and shown, starting with the hard words, no labels, no filler, no Chinese, no IPA), the sentence again, then on by itself. Tap a word: don't know (explained, then on). Double tap: known. The small counter shows stops / sentences so far. The older stops (I know / I don't know, the word repeated) are one setting away: "Stop by Level Check" in All settings.

**My vocabulary file:** `~/Documents/MEH English/vocabulary.json`, with a copy in `My Drive/MEH English/` when Google Drive for desktop is installed. A Chrome extension cannot write files itself, so a small helper does it: All settings → Level Check shows the one command to run once. On iPhone / iPad the words stay in the app or extension. **Copy my level for Claude** is in ⚙, All settings and My Vocabulary.

**Reading mode:** the extension's window → "Read a PDF or text" (Chrome): open a PDF or text file, or paste a text. The same Level Check, database and 50% rule: it reads to the end of a sentence, shows and reads the explanation, shows the sentence again. The text is never changed, cut or reordered.

## 7. My tutor (Chrome, YT Safari and YT Learn, v3.4): your own AI teacher on YouTube

On the iPhone / iPad there is no keyboard: a bar at the bottom of the page (YT Safari) or of the app (YT Learn) has the
buttons instead: My tutor on / off, Stop / play, Explain 30 s, Last sentence, Talk, Voice, Page, Listening, Words,
Settings. In YT Safari the API keys are kept in the extension's own storage (⚙ → All settings); in YT Learn, in the
iPhone's Keychain. Needs iOS 16.4 or newer.

Two ways to learn, never at the same time (turning one on turns the other off):

- **Claude / ChatGPT** (the website call): everything above.
- **My tutor** (your own API key): Dream Read's teacher, on YouTube.

Before you watch, the AI reads the video:
- it rebuilds YouTube's broken subtitle lines into complete, punctuated sentences;
- it marks what is above your level: words, phrases and whole hard sentences (with short Chinese hints).

At every automatic stop:
1. The page shows the last 30 seconds (20 / 30 / 40 / 60) over the whole screen, big and clear: always every word
   at once (a long part gets smaller text; the word card has its own column and never covers the text).
2. A word is said 3 times (a hard sentence is played once from the video).
3. 5 seconds: **I know** (K) = unhighlighted, no explanation, the sentence plays again, on.
   **I don't know** (D), silence or anything else = explained; it stays highlighted and is explained again next time.
4. The explanation starts at once (the AI already wrote it while you waited), with **your own teacher rules**
   (RULE ONE for words, RULE TWO for sentences), in a natural voice, Chinese at the end.
5. The word 10 times, the sentence from the video (the word card closes as it plays).
6. A moment to ask by voice (live call). Quiet for 3 seconds = the video goes on.

Your commands:
- **Pause** the video: the part plays again on the page, the teacher breaks it down in very easy English, you can
  ask, then the video goes back to the start of the part.
- **←** (left arrow): the last sentence is played, explained and played again.
- **"bye bye"** (or Esc): the AI stops at once and the video plays again from the start of what was explained.
- **Space** while the teacher talks: pause the teacher and ask.
- **📞 Talk** (Shift+T): a live voice call with the tutor about what is on the screen (real time, you can interrupt).
- **Shift+L**: listening mode (all subtitles over the screen, the playing line near the middle) / normal video.
- **[ ]**: smaller / bigger text; **Shift+C**: Chinese under every line (live AI translation). All keys can be changed.

Everything can be changed right on the YouTube page (⚙): text sizes (any size), part length, voice (Microsoft: free about 9 hours a month; OpenAI marin /
cedar…; ElevenLabs; or any Mac voice; it tells you when a key is missing, and a new voice says a test sentence), speed, microphone sensitivity, live call on/off, your level, the AI model, your teacher's
instructions (write anything), how many repeats, the API keys and the shortcuts.

New in 3.4:
- **The good voice does not disconnect:** a failed sentence (a short internet problem, a busy server, no sound after 12 seconds) is tried again. If that fails too, only that sentence is said by the Mac / iPhone voice, and the good voice is used again for the next one. Only after 3 failures in a row does the plain voice speak for 1 minute, then the good voice comes back. The 🩺 Check shows why it failed. Chrome's online "Google" voices are said in short pieces (Chrome stops them after about 15 seconds) and are listed last.
- **The voice call:** Claude by default; it listens even with voice commands off, and says so when the microphone is blocked. "📞 Test the call" is in ⚙. The OpenAI live call reconnects once by itself when the connection drops, tries older live models when the newest is not on your key, and falls back to Claude if it still does not work.

New in 3.2:
- **Two volume sliders** (⚙ → Voice): the teacher's explanation and the word / sentence being taught. They follow the
  video's volume (100 % = as loud as the video).
- After an explanation the video **goes on by itself** (no talk, no live call waiting). Talk only when you ask (📞 / Shift+T).
- **Subtitles on the video**: lower by default, height slider, Auto / Always / Off, **Shift+S** to show / hide (remembered);
  YouTube's own subtitles: hide while Dream shows / always / never.
- **Video size**: YouTube decides, or your own size (40–85 % of the page).
- **Seven teaching ways** (⚙ → My teacher), each with a beginner (A1–A2) and an intermediate (B1+) version: Picture It
  (your rules in easy English), Chinese Bridge, Chunk Catcher, Guess First, Little Story, Ask Why, Echo Me. Edit any of
  them (✎) and Reset.
- **Stops by itself** (⚙ → What you see): Off / Rarely / Sometimes (default) / Often / Every hard word. Spaced stops
  teach only the hardest item (a hard sentence first, then the highest level).
- **My Vocabulary** is saved online too (Chrome sync, your Google account) and in a backup for youtube.com; it comes back
  by itself after a reinstall. It shows **"You know about N English words"**; 📒 on YouTube shows the number.
- **Voice call with Claude** (📞 / Shift+T), no OpenAI needed: you talk (Chrome's speech recognition) or type, Claude
  answers with the conversation and what is on the screen, and your tutor's own voice speaks it at once, sentence by
  sentence. Say "stop" (or press Space) to interrupt, "go on" to go back to the video. OpenAI realtime is still an
  option (⚙ → Talk with), and if it fails (no credit) the call switches to Claude by itself.
- The extension updates itself when a newer build is put in its folder (unpacked installs).

📒 My Vocabulary: every explained word and sentence with its explanation, Chinese and a link to that moment in the
video; CSV download; progress per level (A1 to C2).

Keys: Claude (explanations) and/or OpenAI (the voice, the live call, or everything). One key is enough to start.

---

## 8. Downloads

https://github.com/948573034jackie-cpu/meh/releases/tag/claudesnap-latest

- `YouTube-to-Claude.zip`: Chrome extension (Mac)
- `YTSafari-unsigned.ipa`: YT Safari (iPad / iPhone)
- `YTLearn-unsigned.ipa`: YT Learn (iPad / iPhone)
