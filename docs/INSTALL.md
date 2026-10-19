# Dream Read: install and first use (about 15 minutes)

## 1. Which zip?
- Apple menu → About This Mac.
- "Chip: Apple M1 / M2 / M3 / M4" → use **DreamRead-0.2.0-arm64.zip**
- "Processor: Intel …" → use **DreamRead-0.2.0-x64.zip**
- macOS 13 Ventura or newer is needed.

## 2. Install (the app is not Apple-signed, so this needs one Terminal line, once)
1. Double-click the zip. Drag **Dream Read.app** into **Applications**.
2. Open **Terminal** (Launchpad → search "Terminal"). Paste this line and press Return:

       xattr -cr "/Applications/Dream Read.app" && codesign --force --deep --sign - "/Applications/Dream Read.app"

3. Open Dream Read from Applications.
   If macOS still complains: System Settings → Privacy & Security → scroll down → **Open Anyway**.

Your old ReadAlong books, words and keys are copied over automatically the first time.
Your API keys are now stored encrypted inside the app's own folder, so they are no longer forgotten after an update.

## 3. First start
1. **Level test** (5 minutes): one word at a time, tap Yes if you know it, No if not. Some words are made up, so be honest. Dream Read then sets your level (A2 to C2). You can redo it any time: Settings → Level & stops → Test my level.
2. **Dream voice** (free, natural British voice that runs on your Mac): Settings → Voice → **Download the Dream voice** (192 MB, once). Until it is ready the Mac voice reads.
3. **Claude API key** (for explanations):
   - Open https://platform.claude.com, sign up, Settings → Billing → **Buy credits** (5 dollars is plenty to start) and set a **Spend limit**.
   - **API keys** → **Create key** → copy it.
   - Dream Read: Settings → AI → paste the key → **Save** → **Test**. A green dot means it is saved and works.
   - Anthropic does not accept mainland China, Hong Kong or Macau phone numbers or billing addresses.
4. **Speech model for voice chat** (free, runs on your Mac): the first time you press the round mic button, Dream Read asks to download it (111 MB, once). Allow the microphone when macOS asks.

## 4. Reading mode (like Kindle)
- Tap the right edge or press PageDown for the next page, the left edge or PageUp for the previous page, the middle to show or hide the bars.
- Left / Right arrow = previous / next sentence. Space = play / pause.
- **Aa** = text size, spacing, theme. **Go to** = chapter, page or percent.
- Tap a word once = "I don't know": a card shows the meaning and Chinese, the AI explains it out loud, then the card disappears and the voice waits.
- Double-tap a word = "I know": the highlight goes away for good.
- Chinese meanings are written under the hard words.

## 5. Listening mode (like song lyrics)
- Press **L** or the Listen button. The text flows up, the current sentence is large.
- The book pauses at words above your level, explains them, waits 7 seconds, then goes on.
- During those 7 seconds just say **"I know"** (never explained again), **"I don't know"** (explained again, more slowly) or ask any question. Say **"bye bye"** to close the voice line.
- Up arrow = explain the previous sentence. Down arrow = explain the next sentence.
- The timeline at the bottom covers the whole book; drag it to jump.

## 6. Talk with your tutor any time
- Press the round **mic button** on the right (or **M**) and just talk. The book pauses while you speak, the tutor answers by voice, and you can interrupt by speaking.
- "Always on" in the mic popover keeps the line open. You can also type: pronunciation does not matter.

## 7. Your words and progress
- **My Vocabulary**: every word you asked about, with its sentence, explanation, book and date. It is also saved as Documents/Dream Read/my-vocabulary.csv, always up to date.
- **Progress**: how many words you know at each level; tap a level to see only the unknown words.

## 8. Make it yours
- Settings → AI → **Explanation styles**: 10 teaching styles (your own, Teacher, Picture, Chunk, Word Parts, Story, Quiz, Philosopher, Poetry, Lyrics). Each can be edited, copied, hidden, given its own personality, length and AI model. **Preview** shows exactly what is sent to the AI.
- Settings → **Skip**: like Speechify, skip page numbers, footnotes, brackets, citations, web links and more.
- Settings → Voice: free voices, or paid Azure, Google, OpenAI, ElevenLabs voices (price per hour shown).
- Press **?** in a book to see every shortcut.

## iPad
See docs/IPAD.md: Dream Read also runs in Safari and can be added to the iPad home screen.

## If something does not work
View → Diagnostics → **Copy all**, and paste the text back to me.
