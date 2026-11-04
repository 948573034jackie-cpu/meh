# My tutor — what it can do

An English-learning tool for YouTube, with your own AI key (Claude). Watch any video. My tutor reads the subtitles,
checks your words (Level Check), stops at what is hard for you, explains it with a natural voice, and keeps one
vocabulary database for your Mac and your iPhone. (Version 3.5: sending the video to the Claude / ChatGPT websites
was removed. The tutor is the only mode.)

There are 3 versions:

| Version | Device | Where you use it |
|---|---|---|
| **Chrome extension** (v3.5) | Mac / computer | YouTube in Google Chrome |
| **YT Learn** (v1.1) | iPhone / iPad | Its own app: YouTube inside it (search, your account, any video), with My tutor |
| **YT Safari** (v3.5) | iPhone / iPad | YouTube in Safari (a small app that adds the extension to Safari) |

---

## 1. Which one to use

- **Mac:** the Chrome extension. It writes the vocabulary file on the Mac (Documents ▸ MEH English), with copies in
  iCloud Drive ▸ MEH English and Google Drive ▸ MEH English (when Google Drive for desktop is installed).
- **iPhone:** **YT Learn**. It looks like YouTube because it *is* YouTube, inside the app, with the tutor's bar at the
  bottom, its panel under the video and its big reading page at stops. Settings ▸ **Choose the folder** makes it share
  the vocabulary file with the Mac (iCloud Drive or Google Drive).
- **YT Safari** is the same tutor inside Safari. Apple does not let a Safari extension write files, so its words stay
  in the extension (Copy my level for Claude still works).

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

**Sentences**: built from punctuation, or from pauses when there is none; a sentence never ends on words like "the",
"and", "to" or "because". The AI then rewrites them as complete, punctuated sentences (section 7).

---

## 3. 🩺 Check: what it looks at

- the extension version and the device; which keys are saved (never the keys themselves), the voice, the AI
- the YouTube tab: does it answer? Is there a video? Subtitles? Is it muted? Is the microphone blocked?
- My tutor: on / off, its last problem, the voice's last problem, how its dictionary was unpacked
- the vocabulary file: where it was saved, or why it was not

It lists the problems in plain words. **Copy report** lets you send them for help.

---

## 4. Known limits (Apple / YouTube rules)

- With a free Apple ID, the iPhone apps must be reinstalled every 7 days (Sideloadly on the Mac).
- Jumping back can take a moment while YouTube loads that part again.
- YouTube sometimes shows "Sign in to confirm you're not a bot" on some connections: sign in to YouTube in the app or in Safari.
- A Safari extension cannot write files, so YT Safari has no shared vocabulary file.

---

## 7a. Level Check and smart stops

Before a video, book, PDF or text: **Check my words** (a tap test built only from this text: B2, C1, C2 + idioms + slang; tap what you know, then Done) or **Skip, just play**. ⚙ → "Ask Level Check before every video" turns it off.

**Each video is analyzed once.** After Level Check the AI writes the explanations of the coming stops in one go (the cheap model, Claude Haiku; a better one can be chosen in All settings), a part at a time ahead of where you are. They are saved with the video, so the stops make no AI call and watching again costs nothing. Then it goes into Listening mode by itself. A tap on a word asks the AI once for that word; pausing is just a pause; "Explain 30 s" uses the cheap model too.

The tutor stops at **50% of the sentences or fewer**, only the hardest, and never because of a word you know. At a stop: the sentence from the video, the explanation (spoken and shown, starting with the hard words, no labels, no filler, no Chinese, no IPA), the sentence again, then on by itself. Tap a word: don't know (explained, then on). Double tap: known. The small counter shows stops / sentences so far. The older stops (I know / I don't know, the word repeated) are one setting away: "Stop by Level Check" in All settings.

**My vocabulary file:** `~/Documents/MEH English/vocabulary.json`, with a copy in `My Drive/MEH English/` when Google Drive for desktop is installed. A Chrome extension cannot write files itself, so a small helper does it: All settings → Level Check shows the one command to run once. On iPhone / iPad the words stay in the app or extension. **Copy my level for Claude** is in ⚙, All settings and My Vocabulary.

**Reading mode:** the extension's window → "Read a PDF or text" (Chrome): open a PDF or text file, or paste a text. The same Level Check, database and 50% rule: it reads to the end of a sentence, shows and reads the explanation, shows the sentence again. The text is never changed, cut or reordered.

## 7. My tutor (Chrome, YT Safari and YT Learn, v3.5): your own AI teacher on YouTube

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
