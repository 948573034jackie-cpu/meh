# ReadAlong — reading + listening app for English learners (plan v1)

Working name: **ReadAlong** (easy to change). Learner: native Chinese, English B2. Target: your iMac (macOS desktop app).
Date: 2026-10-18. Everything below was checked against primary sources (official docs, library source code, package registries) and local experiments; items I could not verify are marked.

---

## 1. The one thing to know first

**No app can type into the voice call of the ChatGPT app or the Claude app.** I checked both companies' documentation, their URL schemes, Apple Shortcuts, AppleScript/accessibility automation, and the open-source projects that try. The only official hooks are "pre-fill a new text chat" links (`claude://claude.ai/new?q=...`, `https://chatgpt.com/?q=...`); they do not auto-send, do not start voice mode, and return nothing to the calling app, so reading could never resume automatically. Also, the custom instructions you saved inside ChatGPT and Claude only apply inside those apps, not to API calls.

**So the voice call lives inside ReadAlong instead:**

1. In Settings you choose **Claude** or **ChatGPT** once and paste an **API key** for it (pay-as-you-go; a ChatGPT Plus or Claude Pro subscription does not include API access).
2. You paste the **same instructions** you already use, into one text box (I pre-fill a good default for a B2 Chinese learner).
3. When you tap a word, or the listening mode reaches a hard word, the app sends **the word + the sentence + the surrounding paragraph + your level** to that AI.
4. The answer is **spoken out loud** by a British voice and shown in a small transcript box. Then the book continues automatically.
5. You can also **talk back** (hold a key, ask a follow-up by voice) in a later phase.

Optional escape hatch ("Open in ChatGPT / Claude" button): opens the app/website with the question pre-filled, for when you want the full chat. Not automatic.

**Cost per hour of listening with ~40 explanations** (prices from the vendors' published tables; OpenAI's pricing page could not be opened from this machine, so those numbers come from OpenAI's API spec plus a secondary pricing database):

| Path | Explanation text | Spoken by | ≈ cost / hour |
|---|---|---|---|
| Claude Haiku 5.5 + Mac voice | Anthropic API | macOS British voice (free, offline) | < $0.01 |
| Claude Sonnet 5.5 + Mac voice | Anthropic API | macOS voice | ≈ $0.08 |
| GPT small model + Mac voice | OpenAI API | macOS voice | ≈ $0.03 |
| OpenAI Realtime voice (gpt-realtime-2.1-mini) | OpenAI API | OpenAI neural voice, text in → audio out | ≈ $0.40 |
| OpenAI Realtime (gpt-realtime-2.1) | OpenAI API | OpenAI neural voice | ≈ $1.40 |

Notes: OpenAI's voices have no guaranteed British accent (it can be requested in the instructions, best-effort). The Mac voice is guaranteed British (Daniel, Kate, Oliver, Serena, Jamie, Stephanie; the "Enhanced/Premium" versions sound much better and are a free download in System Settings → Accessibility → Spoken Content). Anthropic has no voice API at all, so Claude mode always uses a separate voice engine. OpenAI's older TTS models (tts-1, gpt-4o-mini-tts) have a shutdown date announced for early 2027, so I will not build on them.

---

## 2. What the app will do (mapped to your requests)

| Your request | Plan |
|---|---|
| Open EPUB / PDF / paste text | Import EPUB (own parser, one clean page, no iframes), PDF with text layer (pdf.js, paragraph reconstruction), paste or drop .txt/.md. Library with covers and resume position. Scanned PDFs: not in v1 (clear error), OCR possible later. |
| Tap a word → pronunciation + translation instantly | Offline dictionary built from ECDICT (770k entries, Chinese glosses, exam tags, frequency) trimmed to ~50k useful words + ~38k inflected forms, with **British IPA** from ipa-dict en_UK. Popup opens in < 100 ms, no internet. ▶ plays the word with the British voice. |
| Two AI modes, chosen once | Settings: Claude or ChatGPT, API key stored in the macOS Keychain (Electron safeStorage), instruction text box, model choice. |
| Read aloud, speed control, highlight the sentence, stop/play | Web Speech API using the macOS voices (verified: on macOS, Chromium uses Apple's AVSpeechSynthesizer and fires a word-boundary event for every word, so both the **sentence** and the **current word** can be highlighted). Speed 0.5×–2.5×. Space = play/pause. |
| Subtitle band ≈ 30% of the screen | "Band" layout: bottom pane (25–40%, resizable) showing the current paragraph, current sentence large, neighbours dimmed, word karaoke. Toggle with B. |
| Normal Kindle-like view | "Page" layout: paginated (← →) or scrolling, margins, 1–2 columns, sentence tint follows the voice and pages turn before a sentence is spoken. |
| LingQ-style: tap any word → sent to the AI with context | Popup has **Ask AI** (E). Sends word + sentence + paragraph + level. Phrase: click first word, Shift-click last word. |
| "Explain the last 30 seconds" button | Button + Shift+E: pauses, takes the sentences spoken in the last 30 s (15/30/60 configurable), sends them with the paragraph, speaks the explanation, then "Replay those 30 s" or "Continue". |
| Dark look, text size choices | Dark (default, #121212 base / #1E1E1E elevated), Light, Sepia, Match system. Font family (serif/sans/dyslexia-friendly), size 14–28 px, line height, margins. |
| Highlight colours I can choose | Per-state colour presets (Blue/Yellow/Orange/Green/Purple/Red/Silver), each with a dark and a light variant, contrast-checked. Default: over-level = blue fill + dotted underline, learning = yellow, known = nothing, sentence being read = soft tint, word being read = orange underline. |
| **Automatic listening mode** | Toggle Q. Reads continuously. Before each sentence it finds words whose CEFR level is above yours (not known, not a name, first time in this chapter). At the end of that sentence (recommended; "stop at the word" available) it pauses, sends the word(s) to the AI, speaks the explanation, re-reads the sentence, continues. |
| Don't stop too often | "Stops" slider 1–5 (Kindle Word Wise style) with a live preview ("this chapter: 37 stops → 12"). Rules: first occurrence per chapter, max N stops per 10 minutes (default 5), names/numbers never stop, one stop per paragraph can batch 2–3 words. Over the cap, words stay highlighted and queue; E explains them together. |
| Tap to cancel a highlight so it never stops again | Double-click or K = **Known** (never highlighted, never stops). L = Learning (yellow). X = Ignore. Tapping a non-highlighted word and asking the AI marks it Learning. All keyed by lemma (mark "run" once → "running", "ran" covered). Export/import CSV. |
| Choose level A1–C2 | Level picker. Every word in the text gets a CEFR estimate: exact level from CEFR-J (A1–B2) + Octanove (C1–C2) lists; otherwise estimated from Chinese exam tags (中考/高考/四六级/考研/托福/雅思/GRE) and frequency rank (COCA + BNC, so British spellings work). Leftover rare words are batch-classified by the AI in the background once per chapter and cached. |
| Good at night, colourful by day | Dark theme default; day themes; colour pickers; all states also differ by shape (underline/fill) for colour-blind safety. |

Keyboard (reader focused): Space play/pause · ←/→ previous/next sentence · Shift+←/→ paragraph · PageUp/PageDown page · R replay sentence · E explain word/selection · Shift+E explain last 30 s · K known · L learning · X ignore · Q auto-explain on/off · B band on/off · D show/hide sentence translation · S say the word · + / − speed · Tab next hard word · Esc close/stop explanation · Cmd+O open · Cmd+Shift+V paste text · Cmd+, settings · Cmd+= / Cmd+− font size.

---

## 3. Architecture

- **Electron 44** (Chromium 152, Node 24) desktop app, TypeScript, Vite bundling, no native modules (keeps the Linux→Mac cross-build and your Mac self-build simple).
- **Renderer**: single DOM, one `<span>` per word with sentence/paragraph ids; CSS multi-column pagination; band view is a second view of the same sentence array. Per-chapter mounting for long novels.
- **Text pipeline**: EPUB → JSZip → OPF spine → DOMParser → DOMPurify → paragraphs; PDF → pdf.js text items → lines → paragraphs (hyphen joins, header/footer removal). Sentences via `Intl.Segmenter` + a merge pass for "Mr." / "Dr." / closing quotes (verified failure cases). Words via `Intl.Segmenter` (handles façade, don’t, hyphens) + possessive stripping.
- **Dictionary**: build script (Python/Node on CI) → `dict.json.gz` ≈ 2.2 MB (measured) loaded into a Map at startup. Lookup order: exact → inflection pointer (ECDICT "0:lemma") → lemmatizer → accent-folded. Names: per-book name list (capitalised, not sentence-initial, ≥ 2 occurrences) never trigger; popup says "name" and the AI gives the Chinese transliteration on request.
- **Speech engine interface** (`speak(sentence, rate)` → start / word(charIndex) / end events): (1) Web Speech + macOS en-GB voice (primary, word-level); (2) OpenAI Realtime voice (for explanations, sentence-level highlight); (3) fake engine for automated tests. Startup probe: if a voice gives no word events, the word cursor turns off and sentence highlight remains.
- **AI provider interface**: Anthropic Messages API (claude-haiku-5-5 default, claude-sonnet-5-5 option) streamed → speech engine; OpenAI Realtime API (gpt-realtime-2.1-mini default, text item in → audio + transcript out, out-of-band responses so context stays small) or OpenAI text model + Mac voice. Context packet = instructions + book/chapter + previous sentence + sentence + next sentence + word + dictionary gloss + level. Short rolling memory (last 6 exchanges) so follow-ups work.
- **Storage**: JSON files in `~/Library/Application Support/ReadAlong/` (library, progress, known words, settings, AI cache); API keys encrypted with safeStorage (Keychain).
- **Cost control**: usage meter from API responses, daily soft cap (default $1) and monthly hard stop (default $10) inside the app; on a spend-limit error the auto-explain stops but reading continues.
- **Privacy**: only the word + sentence + paragraph (never whole chapters) go to the API; a "sentence only" option; keys never logged.
- **Offline**: reading, dictionary, Mac voice work offline; AI features degrade gracefully (queued, dictionary gloss shown).

---

## 4. Build steps (each step ends with tests you can see)

1. **Skeleton + importers + page view + themes/fonts.** EPUB/PDF/paste → paragraphs/sentences/words; dark/light/sepia; font controls; library + resume. Tests: unit tests on generated EPUB/PDF (already proven in a spike), segmentation edge cases, Playwright end-to-end under a virtual display.
2. **Dictionary + popup + levels + highlights.** Build script, lookup, level estimator (tested on literary samples), popup, known/learning/ignore, colour presets.
3. **Read-aloud engine + band view.** Speech interface, macOS voice path, speed, sentence/word highlight, auto-follow/page-turn, band layout, shortcuts. Tests with the fake engine; a diagnostics screen so you can report the voice probe result from the iMac (there is no Mac in this build environment).
4. **AI: providers, spoken explanations, auto-listen loop, explain-last-30 s.** Both providers, context packet, instruction box, stops slider + caps, queueing, cost meter. Tests with mocked API servers.
5. **Polish.** Settings pages, onboarding (level, voice download, key test), export/import vocabulary, error handling, performance on long books.
6. **Package + install guide.** electron-builder 26.17.0 (the version that keeps the app's internal symlinks correct) → unsigned `.zip` for Apple Silicon and Intel; README with the one-time Terminal commands (`xattr -cr` + `codesign --force --deep --sign -`) because unsigned apps show "damaged" on Apple Silicon; plus a "build it on the Mac yourself" script. Phase 2 options: Kokoro offline neural British voice (~160 MB download), ElevenLabs voices, OCR for scanned PDFs, voice talk-back via microphone.

---

## 5. What I verified today on this machine

- Electron 44.9 launches under a virtual display here and Playwright can drive it (speech voices are empty on Linux, as expected; hence the fake engine for tests).
- EPUB parsing (JSZip + HTML parser) and PDF paragraph reconstruction (pdf.js 6.4) work on generated test books.
- ECDICT (MIT-licensed repo) downloaded: 770,611 rows; trimmed dictionary = 49,562 words + 38,056 inflected forms = 2.2 MB gzipped; level estimator flags for a B2 reader e.g. *sanguine, acrimonious, reticence, inauspicious* but not *melancholy, consensus, emerge*.
- Lemmatizer and sentence splitting behave; the known failure cases (Mr./Dr., closing quotes) are documented and will get a fix pass.
- macOS cross-build from Linux works for `.zip` (not `.dmg`); verified the symlink pitfall in electron-builder 26.15.3 and the fix in 26.17.0.

## 6. Open items that depend on your answers

See the questions in the chat message (chip/macOS version, API keys, explanation voice, stop timing, install method, scanned PDFs, Chinese sentence translation, UI language, spend cap).

## 7. Data licences (for your information)

ECDICT: repo MIT, data licence unstated (fine for personal use). CEFR-J: free incl. commercial with citation. Octanove C1/C2: CC BY-SA 4.0. ipa-dict en_UK: GPL-3-derived (kept as a separate attributed file). Oxford 3000/5000 and English Vocabulary Profile: not open, not used.
