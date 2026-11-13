# My tutor — what it can do

An English-learning tool for YouTube, with your own AI key (Claude). Watch any video. My tutor reads the subtitles,
checks your words (Level Check), stops at what is hard for you, explains it with a natural voice, and keeps one
vocabulary database for your Mac and your iPhone. (Version 3.5: sending the video to the Claude / ChatGPT websites
was removed. The tutor is the only mode.)

There are 3 versions:

| Version | Device | Where you use it |
|---|---|---|
| **Chrome extension** (v3.8) | Mac / computer | YouTube in Google Chrome |
| **I Know** (v3.8; it was called YT Learn) | iPhone / iPad | Its own app: YouTube inside it (search, your account, any video), with My tutor, a reader and a browser |
| ~~YT Safari~~ | — | no longer built: YT Learn is the iPhone version |

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
- Free mode (My tutor off in the app: no AI, no cost) has no English definitions: the built-in dictionary gives the Chinese meaning only.
- Free mode's sentence translation is Apple's Translation, on the iPhone / iPad: it needs iOS 18 (older iPhones show the dictionary only), and the first time iOS may ask to download English and Chinese.

---

## 7a. Level Check and smart stops

Before a video, book, PDF or text: **Check my words** (a tap test built only from this text: B2, C1, C2 + idioms + slang; tap what you know, then Done) or **Skip, just play**. ⚙ → "Ask Level Check before every video" turns it off.

**Each video is analyzed once.** After Level Check the AI writes the explanations of the coming stops in one go (the cheap model, Claude Haiku; a better one can be chosen in All settings), a part at a time ahead of where you are. They are saved with the video, so the stops make no AI call and watching again costs nothing. Then it goes into Listening mode by itself. A tap on a word asks the AI once for that word; pausing is just a pause; "Explain 30 s" uses the cheap model too.

The tutor stops only at the hardest sentences, and never because of a word you know. There are two groups of stops, each with its own **on / off** and its own **share of the sentences in %** (⚙ on the video → "My tutor stops for"):

| Group | At first | What happens |
|---|---|---|
| **Words and phrases** (a hard word, an idiom, slang, a phrasal verb) | on, 45% | the tutor says it 3 times and waits 5 seconds |
| **Whole sentences** (hard grammar, hidden meaning) | on, 5% (about 1 in 20) | the sentence is played once more from the video, then the tutor waits 5 seconds |

In both groups: **"I know"** (say it, or tap the button) = marked known, no explanation, the sentence plays again and the video goes on. **"bye bye"** = the same: the tutor goes, it is marked known, the video plays. Say nothing (or "I don't know") = the explanation, the sentence again, then on.

The same word is not asked again within 1,000 words, and a word explained 5 times counts as known and never stops again (both numbers can be changed). The explanation at a stop is the one written by the one analysis: a stop makes no AI call.

**My vocabulary file:** `~/Documents/MEH English/vocabulary.json`, with a copy in `My Drive/MEH English/` when Google Drive for desktop is installed. A Chrome extension cannot write files itself, so a small helper does it: All settings → Level Check shows the one command to run once. On iPhone / iPad the words stay in the app or extension. **Copy my level for Claude** is in ⚙, All settings and My Vocabulary.

**Reading mode:** the extension's window → "Read a PDF or text" (Chrome): open a PDF or text file, or paste a text. The same Level Check, database and 50% rule: it reads to the end of a sentence, shows and reads the explanation, shows the sentence again. The text is never changed, cut or reordered.

## 7b. On the iPhone: a book of subtitles, your voice is enough

- **The screen is a book.** The whole screen is the video's subtitles, in one normal text size that never changes by itself (⚙ → Text size). Every word can be tapped: a card shows its Chinese (the dictionary's; the AI translates what the dictionary does not have).
- **The play line.** The sentence being played, asked or explained always jumps to the play line: ⚙ → Play line, 0 = the bottom of the page, 100 = the top (40 at first, a little under the middle).
- **Only the bottom has controls**, five small ones: Tutor on/off · ⏯ play/stop · Explain 30 s (20, 40 or 60 in Settings) · Sentence · Call. Swipe the bar for the rest: Voice, Mode, Sleep, Words, Settings, Check (and in the app: Home, Paste link, App settings). Above the bar: the "I know / I don't know" buttons at a stop, and one line to type a question (➤ sends it).
- **What the tutor says is heard, not shown** (⚙ → "Show what the tutor says as text" turns the text on).
- **Just talk** (on from the start): "hello" = the tutor comes (the video stops, the last part is explained; when the video is already stopped, the call opens) · "I know" = marked known, no explanation · "bye bye" = the tutor goes and the video plays (at a stop it also marks the word or sentence known). The microphone stays on after "bye bye". ⚙ → Microphone: Low / Mid / High.
- **Sleep timer:** the Sleep button (or ⚙) = 30 minutes, again = 60 minutes, again = off. When it runs out the video, the tutor and the microphone stop.
- **Taps:** one tap on a word = its card and the explanation; a double tap = I know.
- **Short explanations:** the hard word and what it means in easy English, then the whole sentence in easy English (about 30 to 60 words; no heading, no intro).
- **The word test before a video is off at first** (⚙ → "Word test before each video").
- **The line being explained is always shown:** at "Sentence" and at "Explain 20 s" the page jumps to the line the tutor is talking about.
- **Three modes** (the Mode button, or ⚙ → Mode), each with its own text size: **Listening** (all the subtitles, the text moves with the sound), **Reading** (pages like an e-reader: a light page, the text does not move, a thin line follows the word being read, the pages turn by themselves; ‹ › or a swipe turns them, a tap on a sentence plays from there), **Video** (the video).
- **After an explanation** the Chinese card closes, the word is said 3 times again, the sentence plays from the video, and the video goes on to the end.
- **My teacher** (⚙ → My teacher): your own teacher first, then seven ways from research on language teaching (Picture It, Chinese Bridge, Chunk Catcher, Guess First, Little Story, Ask Why, Echo Me). The one you choose is also used for the explanations at the stops of the next videos.
- **Volume:** ⚙ → Tutor's volume / The word's volume (they now also work for the cloud voices on an iPhone).
- **No silent stops.** A stop where nothing is said for 30 seconds plays on by itself; a video that the phone itself paused as the microphone went on plays on again.

## 7. My tutor (Chrome and YT Learn, v3.6): your own AI teacher on YouTube

On the iPhone / iPad there is no keyboard: a bar at the bottom of the page (YT Safari) or of the app (YT Learn) has the
buttons instead: My tutor on / off, Stop / play, Explain 20 s, Sentence, Call, Voice, Sleep, Words,
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

## 7c. I Know 3.8 (12 Nov 2026): what changed

- **One level, 0 (easiest) to 100 (hardest).** One long slider in Settings, and three switches: Words, Phrases,
  Sentences. The tutor stops by itself ONLY for what is harder than your level (`level100.ts`: a word's number comes
  from how common it is and its school level). At or below your level, or known: never a stop. A tap on a word still
  explains it. The old A1–C2 level and the three % sliders are gone.
- **The 1,000-word rule counts across videos** (`heard.ts`): one "words heard" counter per learner; it goes on from one
  video to the next and travels with the online vocabulary.
- **The stop card:** a word = the word, its pronunciation, its translation; a phrase or sentence = the text and its
  translation. One tap anywhere = I know; no tap = the tutor explains. Edge touches and slow presses do not count.
- **Voice:** "hello" = always explain the last 10 / 20 / 30 s; "hi bro" = always the call. A "10 s" part is about 10 s.
- **The tutor's volume really works on the iPhone** for cloud voices (the volume is put into the sound, `gain.ts`) and
  the live call (a gain), with a Volume button in the bar (quieter / louder).
- **Full screen both ways:** turn the phone, or YouTube's own full-screen button, or the bar's Full screen button: the
  video over the whole window with the tutor's subtitles; an iPhone on its side gets a rail of big buttons.
- **One button mode:** nothing on the screen changes; a touch on the page or the video = explain the last N s.
- **One Text size** for every mode, the subtitles on the video and the card. **Video mode:** film-like subtitles (one or
  two lines, only what is said now); the big page is off until its switch turns it on; an iPad shows the page beside
  the video.
- **Complete sentences for every video** (always made, once per video; very long ones cut at a natural place).
- **Back where you stopped**, **Free mode** (no AI), official subtitles when good (3.8 steps 2 to 7).
- **A daily word review** by plain counting (no AI): explained 7 times = known; not met for 90 days = to review again;
  what your words say about your level (only said: your slider never moves by itself).
- **Find me a video** (ranked 1 to 10, re-ranked by level without the AI, a list that stays and plays on), **lyrics
  found by the app and shown with parts and notes**, a **reader** (EPUB, text, PDF) and a **browser** with Explanation mode.
- Accounts with Google / Apple sign-in are NOT built: `docs/accounts-data-layout.md` has the plan for the data.

## 7d. I Know 3.9 (13 Nov 2026): fixes after the first try on the phone

- **Keys and voice up front.** Quick settings, first page: under "Tutor's voice" the key box of the chosen voice
  (when its key is missing), the region, the voice list and "Test the voice". "🔑 API keys" is its own box. The app's
  own settings (SwiftUI) have the same keys natively, with Save and "Test the Microsoft voice".
- **The Microsoft region is found by itself** (`findAzureRegion` in `bg.ts`: the voice list of each region is asked
  with the saved key; the one that answers is saved).
- **The voice is never held up**: making a clip again at the learner's volume has 1.5 s; a clip that does not start
  in 2.5 s or fails is replaced by the original, and the device is not asked again (`gain.ts`, `audio.ts`).
- **The stop card**: one meaning (in this sentence); it stays for the explanation and the word said again, and
  closes when the sentence plays again.
- **My level A1–C2 + "How much to explain" 0–100 %** (`explainPct`, default 100): nothing below the level; of the
  rest only the hardest share of words, of phrases and of hard sentences (`keepHardest` in `level-stops.ts`).
- **Back where you stopped**: a page iOS stopped is opened again at its minute; the screen in front (video / reader
  / browser) and the reader's open book are remembered.
- **One look for every mode**: Settings → Look: Auto (as the device is set) / Day / Night (`readLook`, `lookOf`).
- **Tutor off = a normal YouTube page** (no session); free mode only with Settings → Advanced → "With the tutor off".
- **The card's Chinese is the AI's meaning in this sentence**: from the video's analysis when it was made for this
  sentence, else asked in real time, once (`zhHere` / `askHere`); the card closes when the sentence plays again, for
  the big and the small card alike.

## 8. Downloads

https://github.com/948573034jackie-cpu/meh/releases/tag/claudesnap-latest

- `YouTube-to-Claude.zip`: Chrome extension (Mac)
- `YTSafari-unsigned.ipa`: YT Safari (iPad / iPhone)
- `YTLearn-unsigned.ipa`: YT Learn (iPad / iPhone)
