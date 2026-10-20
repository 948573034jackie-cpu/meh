# YouTube English with My Tutor: everything in one file

Chrome extension **"YouTube to Claude / ChatGPT", version 3.2** (Mac, Google Chrome).

---

## 1. What it is

An English teacher for YouTube. Two ways to learn (only one at a time):

- **My tutor** (your own API key): your AI teacher stops the video at what is hard for you, explains it with
  your own rules, speaks with a natural voice, and you can call it and talk.
- **Claude / ChatGPT** (the website): when you pause, the part you heard is sent to your claude.ai or
  chatgpt.com chat.

Turning one on turns the other off.

---

## 2. Install (one time)

1. Download **YouTube-to-Claude.zip** and double-click it. Keep the folder (for example in Documents).
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. If an old version is there: click **Remove**.
5. Click **Load unpacked** and choose the folder.
6. It must say **3.2**. Pin it (🧩 icon). Refresh your YouTube tab.

Update later: remove the old one and load the new folder the same way.

---

## 3. API keys

Click **⚙** on the Dream panel (right of the video) → **API keys** → paste → **Save**.

| Key | What it gives you |
|---|---|
| **Claude** (Anthropic) | the explanations, the AI sentences and Chinese meanings, and the **call with Claude** |
| **OpenAI** | the natural voice (marin, cedar…) and the OpenAI live call; it can also do everything alone |
| **ElevenLabs** (optional) | another natural voice |

One key is enough to start. The keys stay in Chrome on your computer. **Never paste a key into a chat.**

---

## 4. Start

1. Open a YouTube video with subtitles (CC).
2. Under the video, click **My tutor** so it turns green.
3. The AI first reads the video. It makes **complete, punctuated sentences** (YouTube cuts them), and it marks
   what is above your level: **words, phrases and whole hard sentences**, with a short Chinese hint.

---

## 5. What happens at every stop

1. The video stops right after a hard word (or after a hard sentence).
2. The **reading page** covers the screen and shows the **last 30 seconds** (or 20 / 40 / 60), every word.
3. A word is said **3 times**. A hard sentence is played **once** from the video.
4. **5 seconds** with two answers:
   - **I know** (say it, or press **K**): unhighlighted, not explained, the sentence plays again, the video goes on.
   - **I don't know** (say it, or **D**), silence, or anything else: it is explained. It stays highlighted and is
     explained again next time, until one day you say "I know".
   - Nothing you say in these 5 seconds is sent to the AI.
5. The explanation starts **at once** (the AI wrote it while you waited), with **your teacher's rules**
   (RULE ONE for words, RULE TWO for sentences and phrases), Chinese meanings at the end.
6. The word is said **10 more times** slowly; then the **sentence plays from the video**. The dictionary card
   closes when the sentence plays.
7. **A moment to ask** (a call with Claude). Say nothing for **3 seconds** and the video goes on.

---

## 6. Your commands

| You do | What happens |
|---|---|
| **Pause** the video | the part plays again on the page, the teacher breaks it down in very easy English, you can ask, then the video goes back to the start of the part |
| **←** (left arrow) | the last sentence: played, explained, played again |
| **"bye bye"** or **Esc** | the AI stops at once and the video plays again from the start of what was explained |
| **Space** while the teacher talks | the teacher stops; you can ask |
| **Shift+T** or **📞 Call** | a voice call about what is on the screen (it waits for you; "bye bye" ends it) |
| **Shift+L** | listening mode (all subtitles over the screen) / normal video |
| **[** and **]** | smaller / bigger text |
| **Shift+C** | Chinese under each line on / off |
| **Shift+E** or "hi bro" | explain the last part |
| **Shift+M** | My tutor on / off |
| **Enter** | go on (back to the video) |
| Tap a word | explain it here |
| Double tap a word | I know it |
| Tap a sentence | jump there |

Every shortcut can be changed in ⚙ → Shortcuts (click it, press the new keys).

---

## 7. The voice call

⚙ → **Voice call → Call with**:

- **Claude** (default): Claude hears you through the microphone and answers in the tutor's voice.
  Talk when the dot is green. Space stops Claude. Needs your Claude key.
- **OpenAI live (real time)**: answers at once, and you can interrupt it by talking. Needs your OpenAI key
  (about 2 to 10 US cents per minute).

Use **📞 Test the call** in ⚙ to try it.

**Microphone**: the first time, Chrome asks to allow the microphone for youtube.com, so click **Allow**. If it is
blocked: click the lock icon left of the address bar → Microphone → Allow. For the OpenAI call:
⚙ → Microphone → Normal / Sensitive / Very sensitive.

---

## 8. The voice

⚙ → **Voice**. "Speaking now" shows which voice talks.

- **Auto**: the OpenAI voice when your OpenAI key is saved, otherwise the Mac voice.
- **OpenAI**: marin or cedar (most natural), coral, sage, ballad…
- **ElevenLabs**: George, Alice, Daniel, Lily…
- **Mac**: choose any Mac voice in the list. For better Mac voices: System Settings → Accessibility →
  Spoken Content → System voice → Manage Voices… → download an "Enhanced" or "Premium" English voice.

Choosing a voice says a short test sentence. Speed: ⚙ → Speed.

---

## 9. The reading page

- **At a stop**: only the last part (20 / 30 / 40 / 60 s, the buttons at the top). The text gets smaller by
  itself when needed, so every word fits on the screen. Change the seconds there and the page changes at once.
- **Listening mode** (Shift+L or 📖): all subtitles, like your Dream book. The playing line stays near the
  middle (⚙ → "Playing line at", 42% from the top).
- **A− / A+** or [ ]: any text size. **中文**: the AI's Chinese under each line, written live.

---

## 10. Quick settings (⚙, right on YouTube)

Everything is saved at once:
- what you see (mode, page at stops, part length, playing line position)
- the AI's complete sentences; stop at words / phrases / sentences
- text sizes (page, side panel, subtitles over the video), Chinese lines and hints, hide YouTube's captions
- voice, speed, Chinese spoken at the end
- voice call (Claude or OpenAI), after each explanation, the microphone, the live model, go on after quiet
  seconds or wait for me
- your level (A1 to C2), the AI model, the style
- **My teacher's instructions**: write anything (your rules are already there), plus how many repeats
- API keys and shortcuts

---

## 11. My Vocabulary

📒 on the panel: every explained word and sentence, with its explanation, Chinese, and a link to that moment in
the video. CSV download. Progress per level (A1 to C2).

---

## 12. New in 3.2 (fixed)

1. **Call Claude**: the voice call now goes to Claude by default, with your Claude key. The microphone turns on
   for the call even when voice commands are off. The OpenAI call is safer too: if Chrome blocks the louder
   microphone it uses the normal one; if your account lacks the newest live model it tries older ones; if the
   sound is blocked, one click on the page starts it.
2. **Change the voice**: "Speaking now" shows the real voice; there is a Mac voice list; a clear note when a
   key is missing; choosing a voice says a test sentence.
3. **The whole part on the screen**: all the words of the 20 / 30 / 40 / 60 seconds fit. The answer buttons
   sit under the text, not on it. Changing the seconds changes the page at once.
4. **The dictionary card closes** when the sentence is played again after the explanation.

---

## 13. Honest limits

- Tested in Chrome with a test YouTube page, a test AI and a test live-call server (69 checks, all pass), but
  **not yet on real YouTube with your real keys, your microphone and your speakers**.
- Without an OpenAI key the call uses Chrome's own speech recognition: it is slower, and its sensitivity can't be
  changed.
- While My tutor is on, ←, Space, K, D and Esc work for the tutor (← no longer jumps back 5 seconds).
- Not built yet: the level test and the review class.
- If something goes wrong: click the extension icon → **🩺 Check** → copy the report and send it.

---

## 14. For Claude Code on your Mac (so it can test in your real Chrome)

Send this part to the chat on your Mac:

```
Repo: 948573034jackie-cpu/meh
Branch: claude/new-session-pxh22u

- Load in Chrome ("Load unpacked"): the folder youtube-to-claude/
- My tutor's code: dream-ext/ (TypeScript). After a change, inside dream-ext/ run: npm ci, then node build.mjs
  (it writes youtube-to-claude/dream/). Then reload the extension in chrome://extensions.
- Tests: in dream-ext/ run npx vitest run; the Chrome test: node tests/dream-e2e.js (needs Playwright).
- How it should work: this file (YOUTUBE-TUTOR-ALL-IN-ONE.md) and FEATURES.md section 7.

Please test My tutor on real YouTube in my Chrome (I save my keys myself in ⚙ → API keys):
the call with Claude, the OpenAI live call, choosing the voice, the whole part on the page at a stop,
the card closing when the sentence plays again. Fix what does not work. Use simple English with me.
```

To start that chat on your Mac: install Claude Code (Terminal: `curl -fsSL https://claude.ai/install.sh | bash`),
install Node.js (LTS, nodejs.org), install the **Claude in Chrome** extension, then in Terminal:
`git clone https://github.com/948573034jackie-cpu/meh.git && cd meh && git checkout claude/new-session-pxh22u && claude --chrome`

---

## 15. Downloads

- Latest Chrome extension: `downloads/YouTube-to-Claude.zip` in the repo, or
  https://github.com/948573034jackie-cpu/meh/releases/tag/claudesnap-latest (YouTube-to-Claude.zip)
