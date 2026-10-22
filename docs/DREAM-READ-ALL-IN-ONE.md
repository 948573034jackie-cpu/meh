# Dream Read: everything in one file

Paste this whole file into the other chat. Before sending, fill in the line "The other app is: …" at the end of Part 1.

- Part 1: instructions for you (the other chat)
- Part 2: how Dream Read works
- Part 3: the learner's rules (these always win)

---

# Part 1: instructions for you

I am building an English-learning app and want to combine it with the reading and listening features of my
existing app, **Dream Read**. I am a native Chinese speaker, about B2 level, using an Intel MacBook Pro with
macOS 13. Please answer in simple, clear English.

**About Dream Read**
- How it is built and how every feature works: see Part 2 of this file.
- My rules for how it must behave (this is the most important part): see Part 3 of this file.
  These rules are final. If anything in your plan disagrees with Part 3, follow Part 3.
- The source code is on GitHub: `948573034jackie-cpu/meh`, branch `claude/readalong-app`.
  If you can open GitHub, please read the code there, especially `src/core` (reusable logic without Electron),
  `src/renderer/reader` (the two reading screens), `src/core/listen` (the listening teaching flow),
  `src/core/ai` and `src/shared/styles.ts` (AI prompts and teaching styles).

**What I want from you**
1. Read Part 2 and Part 3 of this file first.
2. Ask me what the other app is and what it already does, if I have not told you yet.
3. Then repeat back in 5 to 10 short lines what you will combine, how, and in what order, and wait for my OK.
4. Build in small steps. After every 2 or 3 features, give me a version I can test, and tell me how long each
   step will take before you start it.
5. Keep all my rules: the listening rule (word said 3 times, 5-second commands window with "I know", "I don't
   know", "go on", nothing sent to the AI in that window, then the explanation, then reading again from the same
   sentence), explanations in easy English with no filler, Chinese only as two meanings at the end with a Chinese
   voice, everything saved, and everything customisable.
6. Reuse the existing code in `src/core` where you can instead of rewriting it; it has about 650 tests.
7. Test everything before you give it to me, and tell me honestly what you could not test (for example, sound on
   a real Mac).

The other app is: **[describe the other app here, or attach it]**


---

# Part 2: how Dream Read works

Dream Read is a Mac app (plus an iPad web version) for reading and listening to English books while an AI tutor
explains hard words, phrases and sentences in their exact context. It was built for a native Chinese speaker at
about B2 level. The learner's rules are in **docs/RULES.md**; this file explains how the app is built and how each
feature works, so another developer or AI can reuse the reading features in a different app.

- Source: GitHub `948573034jackie-cpu/meh`, branch `claude/readalong-app`.
- Stack: Electron 44 (Chromium + Node 24), React 18, zustand, TypeScript (strict), esbuild, vitest (about 650 unit
  tests), Playwright (end-to-end tests of the real app).
- Commands: `npm run build`, `npm start`, `npm test`, `npm run test:e2e`, `npm run dist:mac` (Mac zips for Intel and
  Apple Silicon), `node scripts/build-web.mjs` (iPad web version).

---

### 1. The big picture

```
 Book file (EPUB / PDF / text)
        │  import + clean-up (src/core/import)
        ▼
 Book model: chapters → paragraphs → sentences → tokens   (src/core/model.ts)
        │
        ├── Dictionary + CEFR levels → which words/phrases are above the learner's level (src/core/vocab, src/core/dict)
        ├── Chapter AI job → Chinese meanings in context + hard phrases with levels (src/core/ai/hints.ts, src/main/hints.ts)
        │
        ▼
 Reader UI: Reading mode (pages) and Listening mode (karaoke lines)   (src/renderer/reader)
        │
        ├── Playback: reads sentence by sentence with word timing          (src/core/listen/playback.ts)
        ├── ListenController: pauses at hard items, runs the teaching flow (src/core/listen/controller.ts)
        ├── Voices: Kokoro (local), Mac voices, cloud voices               (src/core/tts, src/main/kokoro, src/main/tts.ts)
        ├── AI tutor: Claude or OpenAI with the learner's API key           (src/core/ai/prompts.ts, src/main/ai.ts)
        └── Voice chat: mic → speech recognition → commands or questions   (src/renderer/voice, src/core/voice, src/main/stt)
        │
        ▼
 Saved data: settings, library, vocabulary (+ CSV), progress, encrypted keys (src/main/*.ts, userData/data/)
```

Electron has two sides. The **main process** (`src/main`) owns files, API keys, AI calls, the Kokoro voice model
and speech recognition. The **renderer** (`src/renderer`, React) is the screen. They talk only through one
bridge, `window.readalong` (type `ReadAlongApi` in `src/shared/api.ts`, implemented in `src/preload/index.ts`).
Everything in `src/core` is plain TypeScript with no Electron, so it can be reused anywhere (the iPad build
reuses it with a browser version of the bridge in `src/web/api.ts`).

---

### 2. Books: import and the book model

- **EPUB** (`src/core/import/epub.ts`): unzips with JSZip, follows the spine, turns HTML into paragraphs, drops
  footnotes, page-break markers and the contents page.
- **PDF** (`src/core/import/pdf.ts`): pdf.js reads text items with their positions; words are joined by glyph
  geometry (fixes ligature splits like "fi ght"), running headers/footers and page numbers are removed,
  paragraphs and headings are rebuilt, hyphenated line ends are joined when the text proves it.
- **Text / paste** (`src/core/import/text.ts`): `#` headings become chapters.
- **Sentences** (`src/core/segment.ts`): `Intl.Segmenter` plus fixes for abbreviations (Mr., Dr., e.g.).
- **Model** (`src/core/model.ts`): `Book → Chapter → Paragraph → Sentence → Token` with character offsets; a
  `Position` is `{chapter, paragraph, sentence}`. `src/core/nav.ts` moves between sentences, finds context
  around a position (about 500 words before, 200 after), and word offsets.
- **Names** (`src/core/dict/names.ts`): character names are detected so they are never treated as hard words.

### 3. Levels, hard words and phrases

- **Dictionary** (`resources/dict/dict.json.gz`, built by `scripts/build-dict.py`): about 50,000 English words
  from ECDICT (Chinese meanings, frequency), British pronunciation, and CEFR levels from CEFR-J and Octanove;
  about 800 dictionary phrases.
- **Above the level** (`src/core/vocab/analysis.ts`): each word gets a CEFR level (list level, or estimated from
  frequency); a word is "hard" when it is above the learner's level and not known/ignored. Dictionary phrases with
  only an estimated level get a level derived from their hardest word.
- **AI phrase finder** (`src/core/ai/hints.ts`, `src/main/hints.ts`): for each chapter, a cheap model (Claude
  Haiku by default) lists the 2–5 word idioms, phrasal verbs and slang a learner at this level would not understand,
  each with a CEFR level and a Chinese meaning. Each phrase is checked against the text and mapped to token spans.
  The same job gives a context-chosen Chinese meaning for each hard word. Results are cached per book.
- **Word status** (LingQ style): unknown (highlighted), learning (yellow), known (no highlight), ignored.
- **Level test** (`src/core/level`, `src/renderer/views/LevelTest.tsx`): a 2-stage yes/no word test with made-up
  words to catch guessing; it estimates vocabulary size and a CEFR level; daily "I know / I don't know" answers keep
  adjusting the estimate (Beta model per frequency band).

### 4. The two screens

- **Reading mode** (`src/renderer/reader/ReadingScreen.tsx`): Kindle-like pages using CSS columns; tap zones
  (left 20% back, right 20% forward, middle shows bars); Aa panel; Go to; progress that cycles page / time left;
  Chinese hint under each hard word; single tap = explain, double tap = known.
- **Listening mode** (`src/renderer/reader/ListeningScreen.tsx`): full-width lines like song lyrics, the current
  sentence large and kept in view, the current word highlighted, a whole-book timeline with chapter marks
  (`Timeline.tsx`), speed 0.5–2.0, "I don't know" and "Explain last 20/30/40 s" buttons.
- Both share one position and one playback (`src/renderer/reader/ReaderView.tsx` wires everything).
- **Word card** (`WordCard.tsx`): word, IPA, level, Chinese meaning in context (large), short English meaning,
  I know / I don't know / Ignore, 中文 on/off. It appears during a pause or tap and disappears after the explanation.
- Rendering (`render.ts`): sentences and tokens become spans with data attributes, so highlighting the current
  sentence/word and restyling a word after "I know" is cheap.

### 5. Playback and the listening teaching flow

- **Playback** (`src/core/listen/playback.ts`): a loop that speaks one sentence at a time, emits `sentence` and
  `word` events (for karaoke highlighting), prepares the next sentences ahead, skips sentences the Skip panel
  removes, and calls hooks `stopAt(pos)` / `onStop(pos)` that the controller uses to pause at hard items.
- **ListenController** (`src/core/listen/controller.ts`) runs the learner's rule (details in RULES.md):
  1. pause at a hard word/phrase/learning word (not again within 500 words);
  2. show the card, say the word 3 times;
  3. a 5-second **commands-only** window (I know / I don't know / Go on; other speech is ignored and never sent to
     the AI);
  4. explanation by the AI in the active style, then another 5-second window ("I don't know" = deeper again);
  5. read the interrupted sentence again from its start and go on.
  It also handles manual explanations (taps, selection, Up/Down arrows = previous/next sentence, "explain the last
  30 seconds"), the quiz pause, barge-in (the learner starts talking), and saving words as learning/known.
- **Scripts** (`src/core/listen/script.ts`): turn an AI reply into spoken steps; Chinese parts are spoken by a
  Chinese voice (never an English voice); two Chinese meanings at the end; `[PAUSE]` marks a quiz wait.

### 6. The AI tutor

- **Prompts** (`src/core/ai/prompts.ts`, `src/shared/styles.ts`): every explanation request carries the book title,
  chapter, the exact position, about 500 words before and 200 after, the sentence, the target, a dictionary hint,
  recent history, and (for "I don't know") `again: true` for a deeper explanation. The system prompt is the shared
  **context rules** (easy spoken English, no labels, no filler, explain in this context, paint the scene with words,
  never invent text, adapt to the kind of text: novel, poem, song, philosophy, science...).
- **Styles**: 10 built-in teaching styles (Custom, Teacher, Imagination, Chunk, Word Parts, Story, Quiz,
  Philosopher, Poetry, Lyrics), each with word and sentence prompt templates, a script shape, knobs (personality,
  length, answer type) and an optional own model. All editable in Settings (`StylesEditor.tsx`).
- **Calling the AI** (`src/main/ai.ts`): Anthropic (Claude) or OpenAI with the learner's key, streamed; cost
  estimated per call; daily warning and monthly budget limit; clear error messages.
- **Keys** (`src/main/secrets.ts`): AES-256-GCM encrypted in the app's own data folder (not the macOS keychain, so
  keys survive updates and re-signing); verified after saving; five providers (Anthropic, OpenAI, ElevenLabs,
  Azure, Google).

### 7. Voices

- **Kokoro "Dream voice"** (`src/main/kokoro`, `src/core/tts/kokoro.ts`): a free 82M-parameter neural voice that
  runs on the Mac with onnxruntime-node 1.23.2 (the last version with Intel Mac binaries). Text → phonemes
  (espeak-ng WASM) → model → audio + per-word timings from the model's duration output. It runs in a worker
  thread, with a priority queue (the sentence needed now first), long sentences split into clauses, about 8
  sentences prepared ahead, and a disk cache. One-time 192 MB download.
- **Mac voices** (`src/core/tts/webspeech.ts`): the built-in system voices, with watchdogs against silent hangs.
- **Cloud voices** (`src/main/tts.ts`): Microsoft Edge (free), OpenAI, ElevenLabs, Azure, Google; each shows its
  price per hour; word timings when the service gives them, otherwise estimated.
- **Skip panel** (`src/core/import/skip.ts`): like Speechify, skip headers, footers, footnotes, citations, brackets,
  braces, parentheses, URLs, page numbers, contents and captions from the spoken text (the page is unchanged).

### 8. Voice chat with the tutor

- **Mic** (`src/renderer/voice/mic.ts`): echo-cancelled microphone audio, downsampled to 16 kHz in an AudioWorklet.
- **Speech recognition** (`src/main/stt`): free and local with sherpa-onnx: Moonshine v2 model (111 MB) plus
  Silero voice-activity detection; partial and final transcripts.
- **Commands** (`src/core/voice/commands.ts`): "I know", "I don't know", "go on / bye bye" recognised with fuzzy
  and sound-alike matching for a Chinese accent.
- **VoiceChat** (`src/renderer/voice/VoiceChat.ts`): opens the mic in the 5-second windows (commands only), and in
  conversation mode (mic button, M key or Always on): the book pauses when the learner speaks, the question goes
  to the AI with the book context, the reply is spoken sentence by sentence, and speaking interrupts it.

### 9. Saving and learning records

- Settings, library and reading positions, word statuses: JSON files in the app data folder (`src/main/settings.ts`,
  `src/main/library.ts`, atomic writes in `src/main/storage.ts`).
- **My Vocabulary** (`src/main/vocabulary.ts`, `src/renderer/views/Vocabulary.tsx`): every explained word with its
  sentence, explanation, Chinese, book and date; status learning/known; mirrored to
  `~/Documents/Dream Read/my-vocabulary.csv` after every change.
- **Progress** (`src/renderer/views/Progress.tsx`): known/learning/unknown counts per CEFR level; tap a level to see
  its unknown words.
- **Review class** (`src/core/vocab/review.ts`, `reviewScript.ts`): after a session, a spoken review of today's
  words and the story so far, with spaced repetition dates.

### 10. iPad version

`src/web` replaces the main process with browser code (IndexedDB storage, AI and cloud voices called from the
browser, Safari voices), bundled by `scripts/build-web.mjs` as an installable web app (offline cache, home-screen
icon). Kokoro and local speech recognition are Mac-only. See docs/IPAD.md.

### 11. Other documents

- docs/RULES.md: the learner's rules (the behaviour spec).
- docs/INSTALL.md: install and first use. docs/IPAD.md: iPad version.
- docs/KOKORO.md: the local voice. docs/VOICE.md: speech recognition. docs/VOCABULARY.md: vocabulary store.
- docs/research/: research behind the level test, the UX (Kindle, Speechify, LingQ, Trancy), voices and the
  teaching styles.

---

# Part 3: the learner's rules

The learner is a native Chinese speaker, about B2, using an Intel MacBook Pro. These are all the rules they
have given. When the code and this file disagree, this file wins. Change it only when the learner changes a rule.

### 1. Listening mode: a hard word, phrase or short sentence (latest rule)
1. The book is read aloud to the end. It pauses at every **word, phrase (2 to 5 words), slang or short
   sentence above the learner's level**, and at every yellow "learning" word. It does not pause twice for the
   same word within 500 words.
2. At the pause, the **dictionary card appears under the word**, and the word is said **3 times**.
3. Then a **5-second window**. During these 5 seconds the microphone only listens for three commands.
   **Nothing the learner says is sent to the AI**, and repeating the word or saying anything else is ignored.
   - **"I know"** (or K, or the button): saved as known for good, highlight removed, never explained again.
     No explanation.
   - **"Go on"** (also "bye bye", "continue", "next"; or Esc, or the button): no explanation, the AI says
     nothing, but the word is **saved as learning**.
   - **"I don't know"** (or D, or the button): the explanation starts at once, the fuller version.
   - **Silence, the learner repeating the word, or anything else**: when the 5 seconds end, the AI explains.
4. After the explanation, the card disappears and another 5-second window opens (same rules: speech is not
   sent to the AI):
   - "I don't know": explain again, harder and deeper. Then this window again.
   - "I know": saved as known.
   - "Go on" or nothing: the word stays learning.
5. Reading then continues **from the start of the interrupted sentence** (never the next sentence) to the end
   of the book.

### 2. Explanations
- Easy English, plain spoken prose: no headings, labels, numbers or lists.
- **No filler**: never "we already know this", "the Chinese translation is", "let me explain", "great question".
  Start teaching at once and go step by step.
- Explain the meaning **in this exact context** of the book (it reads about 500 words before and 200 after,
  plus the title and chapter). Understand the story, the characters and the meaning under the words.
- Paint the scene **in the learner's mind with words** (who is there, what they see, hear and feel). Never
  images or pictures.
- Never invent text that is not in the book. Never say the word "stop" to the learner.
- **Chinese**: only the two meanings that fit this sentence, spoken at the end by a **Chinese voice**, never by
  an English voice. A **中文** on/off button is on the word card and in Listening mode.
- The learner's pronunciation is often recognised badly: never ask them to repeat; work out the meaning from
  the book.
- **Explanation styles** (Settings → AI): My Custom Style (default), Teacher, Imagination, Chunk, Word Parts,
  Story, Quiz, Philosopher, Poetry, Lyrics. Every style can be edited: its prompts, personality, length,
  answer type, repeats and AI model; styles can be copied, hidden, deleted or made new.

### 3. Dictionary and highlights
- Words and phrases above the learner's level are highlighted. Known words and words in My Vocabulary marked
  known are never highlighted.
- A short **Chinese meaning is written under each hard word**, chosen by the AI for this chapter (dictionary
  meaning until the AI's is ready), in a size that is easy to read.
- The dictionary card (word, pronunciation, level, Chinese in large characters, short English meaning) appears
  under the word when it is tapped or when Listening pauses there, and **disappears by itself after the
  explanation**.
- Phrases: for each chapter the AI finds expressions of 2 to 5 words and gives each a CEFR level **before**
  they are shown; above-level ones are highlighted and explained like words.

### 4. Reading mode (like Kindle)
- Pages; tap the right edge or PageDown = next page, left edge or PageUp = previous page, middle = bars.
- Left/Right arrows = previous/next sentence. Space = play/pause. Aa = look. Go to = chapter, page, percent.
- **Single tap on a word = "I don't know"**: card + spoken explanation, then the voice waits.
- **Double tap = "I know"**: highlight removed for good.
- Select text = explain the phrase or sentence.

### 5. Listening mode (like song lyrics)
- Full-width text flows up; the current sentence is large; timeline for the whole book with chapter marks.
- Up arrow = explain the previous sentence; Down arrow = explain the next sentence. "I don't know" button.
  "Explain the last 20/30/40 seconds".
- Reading and Listening share one position; L switches between them.

### 6. Talking with the tutor
- A round mic button on the right in both modes (M key); "Always on" keeps it listening.
- Outside the 5-second windows the learner can talk any time: the book pauses, the tutor answers by voice in
  this context, and the learner can interrupt by speaking. "Bye bye" closes the call.
- A typed box is always there ("pronunciation does not matter, you can type").

### 7. Saving and progress
- Every explained word goes to **My Vocabulary** (sentence, explanation, Chinese, book, date) and to
  Documents/Dream Read/my-vocabulary.csv, always up to date. Known words stay known.
- **Progress**: known, learning and unknown words per level; tap a level to see only the unknown words.
- A level test at first start (and any time); the level keeps adjusting from "I know" / "I don't know".
- A short spoken review class after a session.
- All settings, styles, prompts, API keys (all providers) and progress are saved and survive restarts and updates.

### 8. Voices and reading
- Default: the free **Dream voice** (Kokoro, British), prepared ahead so playback is smooth.
- Paid voices (Azure, Google, OpenAI, ElevenLabs) show their price per hour.
- **Skip** panel like Speechify: headers, footers, footnotes, braces, citations, parentheses, brackets, web
  links, page numbers, contents, captions.
- Comfort: separate text sizes, line spacing, themes (Night default, Sepia, Light, Grey), speed 0.5–2.0.

### 9. Working agreement
- Build in small steps; send a build after 2 or 3 features; the learner tests on the Mac the same day.
- Before a new feature, repeat the understanding back in 3 to 5 lines.
- The learner's Mac is Intel: always check Intel (x64) binaries and speed.
- Later: an account (Google, Apple or email) that saves vocabulary, progress and keys online.
