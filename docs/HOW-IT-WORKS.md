# Dream Read: how the app works

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

## 1. The big picture

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
bridge, `window.readalong` (type `ReadAlongApi` in `src/shared/api.ts`, implemented in `src/preload/index.ts`). Big
data the reader asks for once (a book, the 7 MB dictionary) crosses it as JSON text, parsed in the page: a string is
about 10x faster through IPC and the context bridge than the same object (`JsonPayload`, `fromJsonPayload`); the
dictionary starts loading while the Library is shown.
Everything in `src/core` is plain TypeScript with no Electron, so it can be reused anywhere (the iPad build
reuses it with a browser version of the bridge in `src/web/api.ts`).

---

## 2. Books: import and the book model

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

## 3. Levels, hard words and phrases

- **Dictionary** (`resources/dict/dict.json.gz`, built by `scripts/build-dict.py`): about 50,000 English words
  from ECDICT (Chinese meanings, frequency), British pronunciation, and CEFR levels from CEFR-J and Octanove;
  about 800 dictionary phrases.
- **Above the level** (`src/core/vocab/analysis.ts`): each word gets a CEFR level (list level, or estimated from
  frequency); a word is "hard" when it is above the learner's level and not known/ignored. Dictionary phrases with
  only an estimated level get a level derived from their hardest word.
- **AI phrase finder** (`src/core/ai/hints.ts`, `src/main/hints.ts`): for each chapter, a cheap model (Claude
  Haiku by default) lists the 2–5 word idioms, phrasal verbs and slang a learner at this level would not understand,
  each with a CEFR level and a Chinese meaning. Each phrase is checked against the text and mapped to token spans.
  The same job gives a context-chosen Chinese meaning for each hard word. Results are cached per book. The job stays
  out of the voice's way in the main process: no key, no work; it reuses the library's parsed book, collects the
  words a paragraph at a time with the thread given back in between, and writes its cache asynchronously.
- **Word status** (LingQ style): unknown (highlighted), learning (yellow), known (no highlight), ignored.
- **Level test** (`src/core/level`, `src/renderer/views/LevelTest.tsx`): a 2-stage yes/no word test with made-up
  words to catch guessing; it estimates vocabulary size and a CEFR level; daily "I know / I don't know" answers keep
  adjusting the estimate (Beta model per frequency band).

## 4. The two screens

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
  sentence/word and restyling a word after "I know" is cheap. A chapter's AI hints and phrases are loaded together
  before it is shown (the next chapter's ahead), so a chapter change renders the chapter once; a new sentence moves
  the highlight classes only on the lines between the old and the new one.
- Listening mode paints little while the voice reads: the lines animate only their opacity, the spoken word is
  coloured and underlined (not bold, which re-lays out the line), the bottom bar is opaque (no blur), the mic pulse is
  an opacity/transform animation. `test/unit/css-lint.test.ts` keeps it that way.

## 5. Playback and the listening teaching flow

- **Playback** (`src/core/listen/playback.ts`): a loop that speaks one sentence at a time, emits `sentence` and
  `word` events (for karaoke highlighting), prepares the next sentences ahead, skips sentences the Skip panel
  removes, and calls hooks `stopAt(pos)` / `stopTargets(pos)` / `onStop(pos)` that the controller uses to pause at
  hard items. The word a stop says 3 times is synthesized before the cut (with the read-ahead of the sentence before,
  and again when its own sentence starts; that read-ahead then holds only the next sentence, so the stop's word and
  explanation never wait behind book work). The stop fades the sentence out over 25 ms. `prime()` synthesizes the
  start position when a book opens and after a seek while paused, so Play starts from the cache. A speed change
  goes on at the new rate without re-reading the sentence (the Mac voice still re-reads it).
- **Behind another window**: the window is not background-throttled, the word highlights are polled every 50 ms
  while the page is hidden (no animation frames then), and while Listening mode reads aloud the main process holds
  a power-save blocker against App Nap (`src/main/power.ts`, released on pause, stop, Reading mode and book close),
  so a stop still cuts at its word.
- **ListenController** (`src/core/listen/controller.ts`) runs the learner's rule (details in RULES.md):
  1. pause at a hard word/phrase/learning word (not again within 500 words);
  2. show the card, send the explanation request at once (`PreparedExplanation`, `src/core/listen/prepared.ts`:
     the reply streams in silently, nothing is shown, saved or added to the chapter history yet) and say the word
     3 times;
  3. a 5-second **commands-only** window with a fixed end (I know / I don't know / Go on; other speech is ignored,
     never sent to the AI and never makes the window longer; "I know" and "Go on" drop the prepared request). The
     first sentences of the reply are synthesized meanwhile (`TtsEngine.prepareSoon`, Kokoro priority 'soon');
  4. the prepared explanation at once ("I don't know", or when the window ends), spoken sentence by sentence as it
     streams with every arrived sentence synthesized ahead, then another 5-second window ("I don't know" = a new,
     deeper request, spoken as it streams);
  5. read the interrupted sentence again from its start and go on. A stop interrupted before its explanation was
     heard (pause, seek, Reading) stops at the word again when the reading comes back.
  It also handles manual explanations (taps, selection, Up/Down arrows = previous/next sentence, "explain the last
  30 seconds"; they stream the same way), the quiz pause, barge-in (the learner starts talking), and saving words
  as learning/known. Only explanations that were heard enter the chapter history and My Vocabulary.
- **Scripts** (`src/core/listen/script.ts`): turn an AI reply into spoken steps; Chinese parts are spoken by a
  Chinese voice (never an English voice); two Chinese meanings at the end; `[PAUSE]` marks a quiz wait.

## 6. The AI tutor

- **Prompts** (`src/core/ai/prompts.ts`, `src/shared/styles.ts`): every explanation request carries the book title,
  chapter, the exact position, about 500 words before and 200 after, the sentence, the target, a dictionary hint,
  recent history (only explanations the learner heard), and `again: true` only for "I don't know" after an
  explanation (a deeper one). The system prompt is the shared
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

## 7. Voices

- **Kokoro "Dream voice"** (`src/main/kokoro`, `src/core/tts/kokoro.ts`): a free 82M-parameter neural voice that
  runs on the Mac with onnxruntime-node 1.23.2 (the last version with Intel Mac binaries). Text → phonemes
  (espeak-ng WASM) → model → audio + per-word timings from the model's duration output. It runs in a worker
  thread, with a priority queue (the sentence needed now first), long sentences split into clauses, about 8
  sentences prepared ahead, and a disk cache. One-time 192 MB download. Each clip is trimmed to the speech by
  energy (Kokoro leaves about 0.6 s of silence after the last phoneme); the pauses are added on purpose: 180 ms after
  a comma, 280 ms after ; : —, 350 ms after a sentence end inside a long text, and the sentence pause (Settings,
  350 ms by default) between sentences.
- **Speed facts** (Settings → Diagnostics): the voice's threads, spinning, load and warm-up times, the CPU, and the
  median / p90 real-time factor of the last segments (`KokoroEngine.perf()`, `src/core/perf.ts`); the AI's median time
  to its first words per model. **Copy diagnostics** puts it all in the clipboard for the developer.
- **Mac voices** (`src/core/tts/webspeech.ts`): the built-in system voices, with watchdogs against silent hangs.
- **Cloud voices** (`src/main/tts.ts`): Microsoft Edge (free), OpenAI, ElevenLabs, Azure, Google; each shows its
  price per hour; word timings when the service gives them, otherwise estimated.
- **Skip panel** (`src/core/import/skip.ts`): like Speechify, skip headers, footers, footnotes, citations, brackets,
  braces, parentheses, URLs, page numbers, contents and captions from the spoken text (the page is unchanged).

## 8. Voice chat with the tutor

- **Mic** (`src/renderer/voice/mic.ts`): echo-cancelled microphone audio, downsampled to 16 kHz in an AudioWorklet.
- **Speech recognition** (`src/main/stt`): free and local with sherpa-onnx: Moonshine v2 model (111 MB) plus
  Silero voice-activity detection; partial and final transcripts. On an Intel Mac it uses 1-2 threads
  (`defaultSttThreads`), leaving the cores to the voice that prepares the explanation during the windows.
- **Commands** (`src/core/voice/commands.ts`): "I know", "I don't know", "go on / bye bye" recognised with fuzzy
  and sound-alike matching for a Chinese accent.
- **VoiceChat** (`src/renderer/voice/VoiceChat.ts`): opens the mic in the 5-second windows (commands only), and in
  conversation mode (mic button, M key or Always on): the book pauses when the learner speaks, the question goes
  to the AI with the book context, the reply is spoken sentence by sentence, and speaking interrupts it.

## 9. Saving and learning records

- Settings, library and reading positions, word statuses: JSON files in the app data folder (`src/main/settings.ts`,
  `src/main/library.ts`). `src/main/storage.ts` keeps them in memory and writes them in the background (500 ms after
  the last change, at the latest 2 s after the first; a temporary file renamed over the old one), and writes anything
  still unsaved synchronously when the app quits. The reading position is saved at most every 5 s and when the book
  or the app closes.
- **My Vocabulary** (`src/main/vocabulary.ts`, `src/renderer/views/Vocabulary.tsx`): every explained word with its
  sentence, explanation, Chinese, book and date; status learning/known (one `vocab:explained` call per heard
  explanation); mirrored to `~/Documents/Dream Read/my-vocabulary.csv` in the background a few seconds after each
  change (and at quit).
- **Progress** (`src/renderer/views/Progress.tsx`): known/learning/unknown counts per CEFR level; tap a level to see
  its unknown words.
- **Review class** (`src/core/vocab/review.ts`, `reviewScript.ts`): after a session, a spoken review of today's
  words and the story so far, with spaced repetition dates.

## 10. iPad version

`src/web` replaces the main process with browser code (IndexedDB storage, AI and cloud voices called from the
browser, Safari voices), bundled by `scripts/build-web.mjs` as an installable web app (offline cache, home-screen
icon). Kokoro and local speech recognition are Mac-only. See docs/IPAD.md.

## 11. Other documents

- docs/RULES.md: the learner's rules (the behaviour spec).
- docs/INSTALL.md: install and first use. docs/IPAD.md: iPad version.
- docs/KOKORO.md: the local voice. docs/VOICE.md: speech recognition. docs/VOCABULARY.md: vocabulary store.
- docs/research/: research behind the level test, the UX (Kindle, Speechify, LingQ, Trancy), voices and the
  teaching styles.
