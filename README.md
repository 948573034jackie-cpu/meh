# ReadAlong

A macOS reading and listening app for English learners. It reads EPUB, PDF or pasted text aloud with a British voice, highlights each sentence and word as it is spoken, shows the pronunciation and Chinese meaning of any word you tap, and, in **listening mode**, stops at words above your level so Claude (or ChatGPT) can explain them out loud before the book continues.

## What it does

- **Books**: open EPUB and PDF files (with a text layer) or paste any text. Your library remembers where you stopped.
- **Tap a word**: British IPA, a play button, the Chinese meaning, the CEFR level, and buttons for *Known*, *Learning*, *Ignore* and *Ask AI*. Works offline from a built-in 50,000-word dictionary.
- **Read aloud**: play, pause, previous/next sentence, speed 0.5× to 2.5×. The current sentence is tinted and the current word underlined.
- **Two layouts**: Kindle-like pages or a scrolling page, plus a **subtitle band** at the bottom (about 30 % of the window, draggable) that shows the paragraph being read with the current sentence enlarged.
- **Listening mode** (Q): words above your level (A1 to C2, your choice) are highlighted. When the reading reaches one it stops, says the word three times, explains the definition and the meaning in this sentence in simple English, gives the Chinese meaning, says the word three times again, reads the sentence twice, and continues. Marked phrases and sentences are read once, broken down, read again, then the book continues. Any key or click interrupts.
- **Cancel a highlight**: double-click a highlighted word (or press K) to mark it known for good. While listening, a single tap on a highlighted word also marks it known without stopping.
- **Explain the last part** (Shift+E): explains what was read in the last 20, 30, 40 or 60 seconds, rounded to whole sentences.
- **Voices**: the free Mac voices (download the Enhanced or Premium British ones in System Settings), free Microsoft neural voices (unofficial service), or paid OpenAI and ElevenLabs voices.
- **AI**: Claude Haiku, Sonnet or Opus, or ChatGPT, through your own API key. Costs are shown per explanation and per month, with a daily warning and a monthly stop you set.
- **Look**: dark theme by default, light and sepia themes, selectable highlight colours, three fonts, text size, line height and margins.

## Install on your Mac

The app is not signed with an Apple developer certificate, so macOS will refuse to open it until you run two commands once.

1. Unzip `ReadAlong-<version>-arm64-mac.zip` (Apple Silicon: M1, M2, M3, M4) or `ReadAlong-<version>-mac.zip` (Intel). Check Apple menu → About This Mac if unsure.
2. Drag `ReadAlong.app` into your Applications folder.
3. Open Terminal (Applications → Utilities → Terminal), paste this line and press Return:

   ```
   xattr -cr /Applications/ReadAlong.app && codesign --force --deep --sign - /Applications/ReadAlong.app
   ```

4. Open ReadAlong from Applications. If macOS still shows a warning, open System Settings → Privacy & Security, scroll down and click **Open Anyway**.

macOS 13 Ventura or newer is required.

### Build it yourself instead

Install [Node.js](https://nodejs.org) (LTS), then in Terminal:

```
git clone https://github.com/948573034jackie-cpu/meh.git readalong
cd readalong
npm install
npm run dist:mac:local
```

The app appears in `release/`. This path produces an ad-hoc-signed app that opens without the commands above.

## First-time setup (5 minutes)

1. **AI key**. Choose Claude or ChatGPT in Settings → AI explanations.
   - Claude: sign in at platform.claude.com (a separate account from claude.ai; the same email works), open **Settings → Billing → Buy credits** and buy 5 dollars of credit with a credit or debit card, then open **API keys → Create key**, copy the key (shown once) and paste it into ReadAlong. On the Billing page you can also set a monthly spend limit. Anthropic's rules do not allow Chinese mainland, Hong Kong or Macau billing addresses or phone numbers.
   - ChatGPT: sign in at platform.openai.com, add credit under Billing, create an API key, paste it into ReadAlong.
   - Without a key, tapping words still shows the dictionary meaning; only the spoken AI explanations need the key.
2. **Voice**. The Mac voices work right away. For a much better British voice, open System Settings → Accessibility → Spoken Content → System Voice → Manage Voices…, download **Daniel (Enhanced)**, **Serena (Premium)** or **Jamie (Premium)**, restart ReadAlong and pick the voice in Settings → Voice & speed. The free Microsoft voices (Sonia, Ryan) need an internet connection.
3. **Level**. Settings → Level & stops: pick your CEFR level (default B2).

## Roughly what it costs

Estimates for about 120 spoken explanations a day (3 hours of listening), 30 days, with the free Mac or Microsoft voices:

| AI model | per month |
|---|---|
| Claude Haiku 5.5 | about 50 cents |
| Claude Sonnet 5.5 | about 10 dollars |
| Claude Opus 5.5 | about 20 dollars |
| ChatGPT GPT-5.4 mini | about 3 dollars |

The app shows the real cost after every explanation, warns when a day passes your daily limit and stops AI features at your monthly limit.

## Keyboard shortcuts

Space play/pause · ← → previous/next sentence · Shift+← → paragraph · PageUp/PageDown page · R replay · E explain word, selection or sentence · Shift+E explain the last part · K known · L learning · X ignore · Q listening mode · B subtitle band · S say the word · + − speed · 0 normal speed · Tab / Shift+Tab next/previous hard word · H mark selection or sentence for listening · Esc close popup or skip an explanation · ⌘O open · ⌘⇧V paste text · ⌘= ⌘− text size · ⌘T theme.

## Development

```
npm install
npm run build        # bundles main, preload and renderer with esbuild into dist/
npm start            # runs the app
npm test             # unit tests (vitest)
npm run test:e2e     # Playwright end-to-end tests (uses a virtual display on Linux)
npm run dist:mac     # unsigned zips for arm64 and x64 (works on Linux too)
python3 scripts/build-dict.py .dict-src resources/dict/dict.json.gz   # rebuild the dictionary (see scripts/fetch-dict-sources.sh)
```

Layout: `src/main` (Electron main process: files, storage, API calls, cloud voices), `src/preload` (bridge), `src/renderer` (React UI), `src/core` (pure TypeScript: book model, importers, segmentation, dictionary, vocabulary analysis, TTS engines, playback and listening controller, AI prompts), `resources/dict` (the offline dictionary), `test/unit` and `test/e2e`.

## Data and credits

Dictionary data: [ECDICT](https://github.com/skywind3000/ECDICT) (MIT repository), [ipa-dict](https://github.com/open-dict-data/ipa-dict) en_UK (GPL-3 derived), [CEFR-J Wordlist](https://www.cefr-j.org/) 1.5 (Tono Laboratory, TUFS; free with citation), [Octanove Vocabulary Profile C1/C2](https://github.com/openlanguageprofiles/olp-en-cefrj) (CC BY-SA 4.0). The level of words outside these lists is estimated from exam tags and frequency ranks. Your books, vocabulary, settings and API keys stay on your Mac (`~/Library/Application Support/ReadAlong`); only the word, its sentence and the surrounding sentences are sent to the AI you chose.
