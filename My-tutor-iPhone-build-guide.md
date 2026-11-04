# My tutor for iPhone and iPad — the complete build guide

Date: 2026-11-01. Written for the owner (Jackie, a Chinese-speaking English learner) and for the engineer or AI that builds the app. Everything in this file comes from the real code in the zip `my-tutor-all-files.zip` (repo `948573034jackie-cpu/meh`, last commit `c85c5c0`).

---

## 0. In simple English: what this file is, and what to do

**What you have now:** "My tutor" works in **Chrome on a computer** (the folder `youtube-to-claude/`, built from `dream-ext/`). It stops at hard words, phrases and sentences, explains them with your rules, speaks with a natural voice (Microsoft, free), talks with you in a voice call, keeps your vocabulary and your level, and remembers each video.

**What you want:** the same thing as **one app on your iPhone and iPad**, with its own icon. YouTube is inside the app, and My tutor sits on top of the video.

**The good news:** your project already has an iPhone/iPad app, **YT Learn** (folder `ios/`). It shows YouTube inside the app and runs the *same JavaScript* as the Chrome extension. It is an older version: it only sends the paused part to the Claude or ChatGPT website. It does **not** have My tutor yet. So the job is: **put My tutor into YT Learn.** No new app from zero.

**Two ways to build it:**

| Way | What you need | How testing works |
|---|---|---|
| **A. Cloud build** (recommended for you now) | Nothing new on your Mac. GitHub builds the app for free (the project already has this: `.github/workflows/build.yml`). You install the app on your iPhone with the free program **Sideloadly** and your Apple ID. | The AI tests the JavaScript on your Mac (WebKit tests), GitHub builds, **you** try the app on your phone for 5 minutes and say what is wrong. |
| **B. Xcode on your Mac** | macOS 26 (Tahoe) + Xcode (free, 10 GB). Your Mac (MacBook Pro 2019) can do it, but you did not want to update yet. | The AI can also run the app in the iPhone Simulator and test everything itself. |

**Install on the phone, both ways:** a free Apple ID = the app works **7 days**, then you install it again (one click). A paid Apple Developer account (99 USD a year) = the app works **1 year**, and you can use TestFlight. This app shows YouTube inside, so Apple will probably **not** accept it in the App Store; on your own phone it is fine.

**The first 5 steps (way A):**
1. Give the new chat this file and the zip `my-tutor-all-files.zip`. Say: *"Build My tutor into the iOS YT Learn app. Follow My-tutor-iPhone-build-guide.md. Test with the WebKit tests, then make the GitHub build."*
2. The AI writes the code (section 7 says exactly what) and runs the tests on your Mac.
3. You push the code to GitHub (the AI tells you the two commands), GitHub builds `YTLearn-unsigned.ipa` (about 10 minutes).
4. On your Mac install **Sideloadly** (sideloadly.io), plug in your iPhone, choose the `.ipa`, type your Apple ID. The app appears on the phone. On the phone: Settings → General → VPN & Device Management → your Apple ID → Trust.
5. Open YT Learn, open a video, pause it: My tutor should explain. Tell the AI what works and what does not.

**How long:** about 3–5 working sessions for a first version that works on your phone, then fixes.

**Money:** the same as in Chrome: Claude API (about $0.2–1 a day), Microsoft voice free up to 500,000 characters a month (about 9 hours of talking). The iPhone itself has good free voices too.

---

## 1. What the app does (every feature, from the Chrome version)

The user watches a YouTube video. My tutor is "on" (button **My tutor ● on** under the player; Shift+M). Everything below is in `dream-ext/src/yt.ts` unless another file is named.

### 1.1 The side panel (right column of YouTube)
- **Head buttons:** `Explain 30 s` (Shift+E or say "hi bro"), `📞` call (Shift+T), `📖` listening mode (Shift+L), `中文 on/off` (say the Chinese meanings at the end of explanations), `A−`/`A+` text size, `🎙` voice mode, `📄 on/off` (the big page at stops), `📒 6,866` My Vocabulary (the number = about how many English words you know), `⚙` quick settings.
- **Status line:** e.g. `141 sentences (complete, by the AI) · subtitles · stops at what is above B2`.
- **Sentence list:** every subtitle sentence; the playing one is highlighted and kept at `followAt` % from the top (default 42). Words above the learner's level are highlighted by CEFR level (`hl-unknown`, `hl-learning`), phrases too (`.ph`). A tap on a word opens the **word card** (word, IPA, level, Chinese meanings from the dictionary, buttons `I know` / `I don't know` / `Ignore` / `中文 on`). A tap on a sentence jumps the video there. Hints (Chinese under hard words) and a Chinese line under each sentence (`zhLines`, Shift+C) are made by the cheap AI model live.
- **Ask box** at the bottom: typed question → the tutor answers with the video context. Next to it **🎤 Speak** (push-to-talk, stops by itself after 20 s at most) and **Ask**.

### 1.2 Subtitles band over the video
A band over the video shows the current sentence (`band: 'auto' | 'on' | 'off'`, Shift+S; `bandBottom` = height from the bottom in %, default 7; size `subtitleSizePx` default 26; YouTube's own captions hidden while the band shows, `hideYtCaptions`, or always, `hideYtAlways`).

### 1.3 The big reading page ("stage") and listening mode
- **Part view:** at a stop or a pause, the last 20/30/40/60 s (`lastSecondsWindow`, default 30; buttons `20s 30s 40s 60s`) is shown as complete sentences, auto-fitted so every word is on the page (`fitPart()`, ResizeObserver; font never scrolls in part view). Top bar: `Dream`, **⏸/▶ stop button**, title, time range, `20s..60s`, `A−/A+`, `中文`, `📞 Talk`, `🎙 Voice`, `📖 Listening`/`🎬 Video`, `📄 Page on/off`, `⚙`, `✕`.
- **Listening mode** (`view: 'listening'`, Shift+L): all subtitles on the page, full screen, the playing sentence follows.
- **▶ Explain button on every sentence** (`.sx`): plays it from the video, explains it (RULE TWO, original words first), plays it again.
- **Select words → "Explain …" button** (`onSelection`, snaps to whole words): one word → word explanation (RULE ONE, with the dictionary entry); several words → phrase (RULE TWO).
- **📄 Page on/off** (`stageOn`): off = the page never opens by itself; you only watch the video; explanations go to the panel.
- **⏸ / ▶** (`stopOrPlay`, Shift+P): stops everything (video, explanation, call) with no "you paused" explanation; ▶ plays on from the same sentence.
- Ghost-click guard: clicks in the first 600 ms after the page opens are ignored.

### 1.4 Automatic stops (the teacher)
Vendor engine: `dream-ext/vendor/core/listen/controller.ts` + `playback.ts` ("Dream Read"), driven by `VideoEngine` (`video-engine.ts`) which plays sentences from the YouTube video itself.
- Triggers: a **word** above the level (dictionary CEFR > `learnerLevel`), a **phrase** (found by the AI "phrases" job), a **hard sentence** (AI "hard" job, about 1 per 8 s max, `HARD_PER_SECONDS = 8`, `stopSentences`).
- Spacing `stopGapSec` (quick setting "Stops by itself"): `-1` Off, `90` Rarely, `45` Sometimes (default), `20` Often, `0` Every hard word. Phrases and sentences always stop; single words only if ≥ gap seconds since the last stop (`lastStopAt`). `maxItemsPerStop` = 1 when gap > 0. Stops already explained in this video are skipped next time (`drDone`).
- A stop: the video pauses at the end of the sentence; the page shows the part; the word is said 3 times (`wordRepeats`, by the "word voice"), the card opens, the **command window** asks *"Do you know “meticulous”?"* `I know (K)` / `I don't know (D)` for `commandWindowMs` (default 5000 ms; extended while a talk is open). I know → marked known, video goes on. I don't know / timeout → explanation (streamed, spoken sentence by sentence while it is written), then the sentence is played again from the video, then (word) the word 10 slow times, then the video goes on. `Esc` = "bye bye" (stop the AI, play again from the start of the sentence). `Space` while the teacher explains = pause it and ask.
- After an explanation: `talkAfter()` = `talkAfterExplain || voiceMode`; default off → the video just goes on. If on, the talk opens for `talkSilenceSec` (default 3 s) or until "go on".

### 1.5 Pause → replay → explain the part
`onPause` (not by the tutor itself): `explainOnStop` (default true) → `partFlow`: show the last 30 s part, **replay it once** from the video (`replayPart`, default true; pause again or Enter = skip to the explanation), then `explainNow('passage', …)` with `PART_PROMPT` (what is happening first, then sentence by sentence, each starting with the original sentence), then back to the **start** of the part, playing, with no stops inside it (`quietUntil`).
- `←` (`explainSentence`, ArrowLeft): the last sentence: play, explain (RULE TWO), play again, go on.
- "hi bro" / Shift+E: explain the last part without replay.

### 1.6 Voice output
Engines (section 5): Mac/iOS system voice, OpenAI, ElevenLabs, **Microsoft (Azure, free)**. Two volume sliders: teacher voice (`teacherVolume`, default 60) and word/pronunciation voice (`wordVolume`, default 80), squared (`sliderGain`), × the video volume when `followVideoVolume` (default true). Speed `voice.rate` (0.6–1.6). A video sentence the teacher quotes is **played from the video**, not read (`QuotesFromVideo`); the taught sentence after an explanation is also played from the video (`SentenceFromVideo`).

### 1.7 Calls and listening (section 6)
- **📞 Talk** (`callTutor`): opens the talk bar; with `callEngine: 'claude'` (default) the tutor greets you with its own voice and you talk (Chrome speech recognition → Claude → voice); with `'openai'` + an OpenAI key a real-time WebRTC call (`gpt-realtime-2.1`).
- **🎙 Voice mode** (`voiceMode`): the microphone stays on; say **hello** (explain the last part; if playing: stop, replay, explain), **stop**, **play** (also stops the tutor), **bye bye** (voice mode off), anything else = a question. About 3 s pause after explanations (`thinkPauseMs`).
- **Microphone** only when needed (`micAlways: false`), sensitivity `micLevel` 1–3 (default 3, OpenAI call only).

### 1.8 Memory and learning
- **My Vocabulary** (`📒`, page `dream/vocab.html`): every explained word with sentence, explanation, Chinese, video link and status `known | learning | ignored`; CSV export; progress per CEFR level; streak; "how many words I know" = `estimateKnown()`.
- Saved in `chrome.storage.local` + a copy in `chrome.storage.sync` (`drSyncMeta`, `drSyncPart0..n`, "online") + a backup in `localStorage` of youtube.com `dreamTutorBackup.v1` (settings + vocabulary, never keys) restored after a reinstall.
- **Level from my words** (`levelAuto`, default true): up one CEFR level when ≥ 75 % of ≥ 15 words met at the next level were known; down when < 40 % of ≥ 15 words of the own level were known (`suggestLevel`). A level chosen by hand turns it off. Shown in ⚙ as "B2 words you met: 40 of 52 known · C1 …".
- **Each video:** where you stopped (`drSpots`, saved every 5 s; on open, back there if > 30 s in, not finished, < 60 days; toast "Back where you stopped (1:23). Press 0 for the start."); stops already explained (`drDone`).
- **Self-update** (unpacked extension only): the background compares `build-stamp.txt` and reloads itself and the page.

### 1.9 Quick settings (⚙), all rows and defaults
What you see: Mode normal/listening · Page at every stop (`stageOn` true) · Play the part again first (`replayPart` true) · Part length 30 s · Playing line at 42 % · Complete sentences by the AI (`aiSentences` true) · Stops by itself (Sometimes) · Stop at hard words/phrases/sentences (all on).
Subtitles on the video: Show auto · Height 7 % · Hide YouTube's own subtitles (while Dream shows).
Video size: YouTube decides / My size (`videoSize` 0 = off, else 40–85 % of the page width).
Text size: Reading page 34 px · Side panel 19 px · Subtitles 26 px · Chinese under each line on · Chinese hint under hard words on · Hide YouTube's own captions on.
Voice: Teacher volume 60 % (▶ Test) · Word volume 80 % (▶ Test) · Follow the video's volume on · Tutor's voice Auto/Microsoft (free)/OpenAI/ElevenLabs/Mac (Auto = Microsoft with its key, else OpenAI with its key, else the system voice) · the voice list of the chosen engine · Microsoft usage this month · Live call voice · Speed 1.0× · Say the Chinese meanings at the end on.
Talk to my tutor: After each explanation off · Voice call on (`liveOn`) · Talk with Claude + my tutor's voice / OpenAI realtime (`callEngine` claude) · Live model gpt-realtime-2.1 / -mini · Voice mode off · Microphone on only when the tutor waits / always · Microphone Normal/Sensitive/Very sensitive (3) · Go on: wait for me / after quiet seconds (3).
My teacher: My level (B2) · Level from my words on · AI model (Claude Opus 5.5 default; Sonnet/Haiku; or OpenAI gpt-5.4-mini) · Teaching way (My rules + 7 ways, each editable and resettable) · My teacher's instructions (textarea, `DEFAULT_TEACHER`) · Say the word before 3 / after 10 times, sentence after a word 1, sentence before 1 / after 1 · Commands window 5 s.
API keys: Microsoft (Azure Speech) key + region (`eastus`) + Test · Claude · OpenAI · ElevenLabs (a Microsoft key pasted in another box is saved as Microsoft).
Shortcuts: every action rebindable (click, press keys).

### 1.10 Keyboard shortcuts (`shortcuts.ts`, defaults)
`ArrowLeft` explain the last sentence · `Shift+E` explain the last part · `Shift+T` talk · `Shift+L` listening mode · `Shift+B` show/hide the page · `Shift+P` stop everything / play on · `]` `[` bigger/smaller text · `Shift+C` Chinese on/off · `Shift+S` subtitles band · `Shift+M` tutor on/off · `Space` pause the teacher and ask (while explaining) · `Enter` go on (page/talk open) · `K` I know · `D` I don't know · `Esc` bye bye. On iPhone these become buttons (there is no keyboard).

### 1.11 The old "call" mode (youtube.js)
Removed in 3.5: My tutor is the only mode. youtube.js now only reads the subtitles, runs the microphone for the tutor and keeps the small bar under the video (My tutor on / off, 🩺 Check).

---

## 2. Architecture of the Chrome version

```
YouTube page (content scripts, in order):  lib.js → youtube.js → dream/dream-yt.js
   lib.js        helpers (subtitle sentence building, etc.)
   youtube.js    old mode + shared services: loadTranscript(), speech recognition loop, the bar with the buttons,
                 window.__ytcApi = { loadTranscript, videoId, isAd, video, settings, buildSentences, setBarStatus, finishSpeech }
   dream-yt.js   My tutor (esbuild bundle of dream-ext/src/yt.ts + vendor "Dream Read" core). Exposes
                 window.__ytcDream = { owns, wantsMic, heard(text, final, key), decorateBar, callChanged, diag }
                 and answers window.postMessage({type:'dr-debug-request'}) with {type:'dr-debug', build, voice}

Background service worker: background.js  → importScripts('dream/dream-bg.js')  (bundle of dream-ext/src/bg.ts)
   holds the API keys, talks to Anthropic / OpenAI / ElevenLabs / Azure, records usage, self-update, vocab sync.

Content ↔ background:
   chrome.runtime.connect({name:'dream-ai'})  port, messages:
       → {type:'explain', req}            → {type:'delta', text} … {type:'done', text, usage} | {type:'error', message, code}
       → {type:'complete', prompt, stream?} (cheap model jobs)  → delta/done/error
       → {type:'chat', system, messages}  (voice call turns)     → delta/done/error
   chrome.runtime.sendMessage:
       {type:'dream-tts', engine, text, voice, lang}  → {b64, mime, timings} | {error}
       {type:'dream-test-key', provider} → {ok, message};  {type:'dream-test-azure', key?} → {ok, message}
       {type:'dream-live-sdp', …} (OpenAI realtime SDP exchange);  {type:'dream-usage', model, usage}
       {type:'dream-dev-check', build} → {reloading};  {type:'dream-open', page}; {type:'dream-vocab-online', save?}
       youtube.js: {type:'heard', text, final, key} (tests), {type:'ask', text, target} (old mode), {type:'voice-wake'}
Storage: chrome.storage.local (everything), chrome.storage.sync (vocab copy), chrome.storage.session (dev reload),
         localStorage of youtube.com (backup), IndexedDB "dreamVoice" (sound cache, in the background worker).
Pages: dream/options.html (all settings), dream/vocab.html (My Vocabulary), popup.html (old mode switches).
Resources: dream/dict.json.gz (the dictionary: words → CEFR level, IPA, Chinese; read with chrome.runtime.getURL).
Build: cd dream-ext && npm i && node build.mjs  → youtube-to-claude/dream/{dream-bg.js, dream-yt.js, options.js, vocab-page.js, build-stamp.txt}
       (esbuild, iife, target chrome116, minified; __DREAM_BUILD__ = stamp)
Tests: dream-ext: npx vitest run (33 unit tests);  tests/dream-e2e.js (105 browser checks, Playwright + Chromium +
       a fake API server on localhost:8790);  tests/safari-webkit-test.js (old mode in WebKit);  tests/lib-unit.js.
```

`chrome.*` APIs really used (count of uses): `chrome.storage.local` 41, `chrome.runtime.sendMessage` 26, `chrome.tabs.sendMessage` 15, `chrome.storage.sync` 8, `chrome.tabs.query` 7, `chrome.storage.session` 5, `chrome.runtime.onMessage` 5, `chrome.storage.onChanged` 4, `chrome.runtime.getURL` 4, `chrome.runtime.getManifest` 4, `chrome.runtime.connect` 4 (ports), `chrome.debugger.*` 6 (old mode screenshots only), `chrome.tabs.create` 3, `chrome.tts.*` 3 (old mode), `chrome.tabs.get/update/reload/captureVisibleTab`, `chrome.scripting.executeScript`, `chrome.runtime.reload`, `chrome.runtime.onConnect`, `chrome.runtime.getPlatformInfo` (keep-awake ping).

---

## 3. Data model and storage (`dream-ext/src/store.ts`)

All in `chrome.storage.local` (on iPhone: a JSON file store, section 7.4).

| Key | Content |
|---|---|
| `drSettings` | Dream Read `Settings` merged over defaults: `learnerLevel` 'B2'; `ai: { provider 'anthropic', anthropicModel 'claude-opus-5-5', openaiModel 'gpt-5.4-mini', hintsModel null (= Haiku 5.5), activeStyle, styles{}, contextWordsBefore 500, contextWordsAfter 200, speakChinese true, monthlyStopUsd 10 }`; `voice: { rate 1.0, voiceId (Mac), explainVoiceId }`; `listen: { wordRepeats 3, lastSecondsWindow 30, commandWindowMs 5000, pauseAfterExplainMs, quizWaitMs, autoExplainWords true, autoExplainPhrases true }`; `appearance: { fontSizePx 19, subtitleSizePx 26, showHints }`. |
| `drExtras` (`YtExtras`, defaults) | `tutorOn false, explainOnStop true, stopInCall false, panel true, band 'auto', hideYtCaptions true, voice 'auto', openaiVoice 'marin', elevenVoice 'JBFqnCBsd6RMkjVDRZzb', azureVoice 'en-GB-AdaMultilingualNeural', azureRegion 'eastus', elevenQuality 'best', talkAfterExplain false, talkSilenceSec 3, liveOn true, liveModel 'gpt-realtime-2.1', micLevel 3, view 'normal', followAt 42, stageOn true, replayPart true, stageSizePx 34, zhLines true, aiSentences true, stopSentences true, teacher DEFAULT_TEACHER, shortcuts {}, teacherVolume 60, wordVolume 80, followVideoVolume true, bandBottom 7, hideYtAlways false, videoSize 0, stopGapSec 45, callEngine 'claude', micAlways false, voiceMode false, migrated 0 (EXTRAS_VERSION 1), levelAuto true, fakeVoice (tests)`. `migrateExtras` v1 sets `talkAfterExplain false`. |
| `drVocab` | `{ words: { lemma: 'known'|'learning'|'ignored' }, marked: {} }` |
| `drEntries` | `{ lemma: VocabEntry }`: `lemma, word, sentence, explanation, chinese, bookId 'yt:<videoId>', bookTitle, chapter '1:23', position, createdAt, lastSeenAt, timesExplained, status, level, again` |
| `drUsage` | `UsageRecord[]` (two months): `{ date, provider, model, inputTokens, outputTokens, cachedTokens, usd }`; Azure records have `model 'azure-neural'`, `inputTokens` = characters, usd 0 → `azureCharsSince()` / `azureUsageText()` (free 500,000; ≈ 54,000 chars = 1 h). |
| `drKeys` | `{ anthropic?, openai?, elevenlabs?, azure? }` (never backed up, never synced) |
| `drSent:<videoId>` | AI sentence split `{ version SPLIT_VERSION 7, words, ends[], texts[] }` |
| `drZh:<videoId>` | Chinese line per sentence text |
| `drHints:<videoId>` | `{ version, level, hints{lemma: zh[]}, phrases, split, sentences (hard), v HINTS_VERSION }` |
| `drSpots` | `{ videoId: { t, d, at } }` (300 newest) · `drDone` `{ videoId: { keys[], at } }` (200 newest, 800 keys each) |
| `drAzureVoices` | voice ShortNames the region has (from the key test) |
| `drTestBaseUrls` | tests only: fake API base URLs `{ anthropic, openai, elevenlabs, azure }` |
| `subsCache` (youtube.js) | subtitle copies per video |
| sync: `drSyncMeta`, `drSyncPart0..n` | vocabulary copy "online" |
| localStorage `dreamTutorBackup.v1` | settings + vocabulary backup (restoreIfFresh / backupSoon) |
| IndexedDB `dreamVoice` / store `sounds` | `tts-cache.ts`: key `engine|voice|lang|best|text` → `{b64, mime, timings, at}`, texts ≤ 80 chars, max 3000 |

Writes go through `oneAtATime()` (a promise queue) to avoid lost updates; `updateSettings(fn)` / `patchSettings` / `patchExtras` / `setKey(provider, key)`; `azureRegionOf('East US' | url)` → `eastus`.

**Subtitles (`youtube.js loadTranscript`):** YouTube's timedtext often comes back empty without a PO token, so the reliable way is YouTube's own **"Show transcript" panel** (opened, read, closed; waits + 3 retries `[4000, 8000, 15000]` ms from yt.ts); copies kept in `subsCache`. `buildSentences(cues, {words:true})` makes rule-based `TimedSentence { start, end, text, words: TimedWord{w, t, e}[] }`; then the AI split (section 4.5) rebuilds complete sentences; `video-book.ts` makes the "book" (chapters/paragraphs/sentences with `Position {chapter, paragraph, sentence}` and timings `timingOf(pos)`, `positionAt(time)`). On **m.youtube.com** (iPhone) the transcript panel is different: YT Learn already reads subtitles through its own YouTube session (see `ios/README.md`); the same `loadTranscript` runs in the app.

**Dictionary:** `dream/dict.json.gz` (2.3 MB gzip) → `DictData { w: { word: { l: 'A1'..'C2', s: source tag, i: ipa, t: chinese, f: frequency } } }`, `createDictionary(d)` gives `lookup(token)` → `{ entry: { ipa, zh, level }, lemma }` and `lemmaOf(word)`. Loaded once with `fetch(chrome.runtime.getURL('dream/dict.json.gz'))` + gunzip in the page (`ai-client.ts getDictData`).

---

## 4. AI layer (`dream-ext/src/bg.ts`, `ai-client.ts`, `vendor/core/ai/prompts.ts`)

### 4.1 Requests
- **explain** (`runExplain`): the teaching model (`ai.provider/anthropicModel`, default `claude-opus-5-5`; or OpenAI), `messages.stream`, `max_tokens = prompt.maxTokens + 1000` (room for thinking), `output_config.effort 'low'`, system prompt with `cache_control: ephemeral`; Opus/Sonnet/Fable get `betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'`; `stop_reason 'refusal'` → error; empty + `max_tokens` → clear error. Kinds: `word`, `phrase`, `sentence`, `passage` (part), `question`. `withTeacher(prompt, styleId)` appends `ALWAYS_RULES` to every system prompt (+ a note that the teaching way wins over the instructions' style).
- **complete** (`runCompletion`, background jobs): the cheap model (`hintsModel` or `claude-haiku-5-5`), `maxTokens = max(prompt.maxTokens, 1500)`. Jobs: AI sentence split, hard sentences (`hard-sentences.ts`, 300 tokens), word hints "Word Wise" (Chinese meanings of hard words, batched), phrases ("multi-word expressions"), Chinese lines (`zh.ts`, up to 4000 tokens), Chinese meaning of one word (60 tokens).
- **chat** (`runChat`, the voice call): the cheap model (Haiku 5.5) for speed, `max_tokens 2000`, the last **10** turns, starting with a user turn; empty answer → asked once more (`ChatCall.run(again)`), twice empty → "Claude gave no answer".
- **Budget:** `monthlyStopUsd` (default 10) stops all AI with code `budget`. Usage recorded per request (`record()` → `drUsage`, with cached tokens).
- **Lean context (cost):** the content script hands the controller `leanSettings()` = `contextWordsBefore ≤ 80`, `contextWordsAfter ≤ 40`; history in prompts: styled prompts keep the last **2** turns (200 chars each), plain prompts 4 turns (250 chars); the controller keeps 12.
- **Keep-awake:** while a job runs, `chrome.runtime.getPlatformInfo()` every 20 s keeps the MV3 worker alive (not needed on iPhone).
- Errors are classified (`classifyError`): `no-key`, `auth`, `budget`, `network`, `rate`, `other`.

### 4.2 Prompt structure (`vendor/core/ai/prompts.ts buildStyledPrompt`)
System = the style's `contextRules` filled with `{{level}}`, `{{native}}` etc. + ALWAYS_RULES. User = optional history ("Earlier in this chapter: Learner: … / You: …") + context block:
```
Book: <video title>
Chapter: <...>
Place in the book: chapter 1, paragraph 3, sentence 2.
Text before the sentence:
<≤80 words>
The sentence being read now:
<sentence>
Text after the sentence:
<≤40 words>
```
+ the task = the style's `wordPrompt` or `sentencePrompt` with `{{word}}`, `{{sentence}}`, `{{dict}}` (e.g. `Dictionary hint for the word: pronunciation /…/, Chinese meaning …, CEFR level C2.`) + for a spoken question: `The learner just said this out loud (speech recognition may have got some words wrong; …): "<question>". Answer it as part of your explanation.` + knob text of the style. For the paused part the sentence prompt is replaced by `PART_PROMPT` with `{{part}}`, `{{seconds}}`, `{{level}}`.

### 4.3 The learner's own rules (`teacher-text.ts`, verbatim)
`DEFAULT_TEACHER`:
```
Help me, an intermediate English learner, understand English like a real English teacher for second-language learners. Never use structural markers, headings, titles, numbers or bullets. Just explain the content directly. Never tell me what you plan to do next: just do it. Don't waste my time and don't add unnecessary words. Speak like a teacher sitting with a student at an intermediate second-language level. Use simple vocabulary. Act immediately, without asking questions.

RULE ONE, for a single word above my level (only for single words): paint a scene with words that shows the meaning of the word in the text (do not say "here is a scene", just describe it). Then explain the meaning of the word in this context. Then give a very detailed explanation of the word, exactly like a dictionary entry (do not say "this word means", just state the meaning).

RULE TWO, for a full sentence or phrase that is too difficult for my level (only for sentences and phrases): describe the scene of the sentence directly, so I feel inside the moment (do not say "I will describe"). Then explain what the sentence means in the story (do not say "this sentence means"). Then break down each part of the sentence one phrase at a time, explaining both the literal meaning and the deeper meaning of each part in natural simple sentences. Then clearly summarize the one main point of the sentence in simple words.

When something is hard, say it in very easy English that I can understand, keeping the original meaning.
```
`MY_TEACHER_STYLE` (style "My Teacher (my rules)"): wordPrompt
```
The word or phrase to teach is "{{word}}" in this sentence: {{sentence}}
{{dict}}

If "{{word}}" is a single word, teach it with RULE ONE of the learner's instructions. If it is a phrase of several words, teach it with RULE TWO. The app has already said it three times and says it again and plays the sentence from the video afterwards, so do not repeat the word in a row and do not read the sentence again at the end.
```
sentencePrompt
```
The sentence or phrase to teach is: {{sentence}}

Teach it with RULE TWO of the learner's instructions. The app plays the sentence again from the video afterwards, so do not repeat it at the end.
```
shape `{ wordBefore: 3, wordAfter: 10, sentenceAfterWord: 1, sentenceBefore: 1, sentenceAfter: 1 }`.

`ALWAYS_RULES` (added to every explanation and call):
```
Always do these two things.
First, before you explain anything, say the original words from the video exactly as they are, so the learner hears what you are talking about: the whole sentence for a sentence, and for a word or phrase the sentence it is in (when it is not in the video, just say the word itself and go on to explain it). Write a whole original sentence on its own, exactly as it is in the video and inside quotation marks, with nothing else in that sentence: the learner then hears it from the video itself. When you break a sentence into pieces, say each piece exactly as it is in the sentence before you explain it.
Second, what the learner says comes from speech recognition, and they may pronounce words wrongly. Never comment on their pronunciation and never ask them to repeat. Work out from this part of the video what they meant. If they used a wrong word, say the correct word or sentence once, naturally, then answer in this exact context.
```
`PART_PROMPT` (the paused part):
```
The learner just paused the video. This is the part they just heard, in complete sentences (about {{seconds}} seconds):
{{part}}

First, tell the learner what is happening in this part so they can imagine it: who is speaking, where they are, what is going on and how people feel, in very easy English that a {{level}} learner understands. Then teach it like a real English teacher sitting next to the learner, sentence by sentence, in order. For each sentence, first say the original sentence exactly as it is in the video. Then, if it is hard for a {{level}} learner, say what it means here and break it into its natural phrases: say each phrase exactly as it is, then explain its literal and its deeper meaning in simple sentences (RULE TWO). For an easy sentence, after saying it, add only a few words. When a single word is above the learner's level, paint a small scene that shows its meaning here and explain it in this context (RULE ONE, short). Finish with the one main point of this part in one simple sentence. Never use headings, numbers, lists or labels, and never say what you will do next.
```

### 4.4 The 7 teaching ways (`teaching-ways.ts`, research note in `research_notes/Seven teaching styles/`)
Each has a beginner (A1–A2) and an intermediate (B1–C2) prompt pair, editable in ⚙ and resettable, and a shape (word repeats before/after, sentence before/after): `way-picture` **Picture It** 画面讲解 (shape 10,1,1), `way-bridge` **Chinese Bridge** 中文搭桥 (3,1,1; speaks Chinese on purpose), `way-chunks` **Chunk Catcher** 抓词块 (2,1,1), `way-guess` **Guess First** 先猜后讲 (3,1,1), `way-story` **Little Story** 小故事 (2,1,1; "a short new story, six to nine sentences"), `way-why` **Ask Why** 追问引导 (2,1,1), `way-echo` **Echo Me** 影子跟读 (3,2,2). `maxTokens` 700 beginner / 1000 intermediate. Copy the full texts from the file when building.

### 4.5 Complete sentences by the AI (`sentences-ai.ts`)
Words of the subtitles are numbered and sent in chunks of ~380 words (cut at the longest pause, better after a full stop) to the cheap model, 3 chunks at a time, each bad chunk retried once. Prompt (verbatim):
```
system: You turn the speech subtitles of a YouTube video into complete, well-punctuated sentences for an English learner. Answer only in the requested line format.
user: These are the words of a YouTube video's subtitles, in order, each with its number (number:word). Speech-recognition subtitles often have no punctuation and are cut in the middle of sentences.

Rebuild the complete sentences. A sentence is one complete thought, punctuated the way a careful writer would punctuate this speech; split run-on speech (thoughts joined with "and", "so", "but" without a real end) into natural sentences, but never cut a real sentence: a long sentence stays whole (up to 60 words), and a sentence never ends at a comma. Keep every word in the same order and do not add or remove words: only add punctuation and capital letters, and fix an obvious speech-recognition spelling mistake of a single word. Leave sound tags like [Music] out of the sentence text.

Answer with one line per sentence and nothing else (no notes, no thinking aloud), in this form:
<number of the last word of the sentence>|<the sentence, punctuated>
Your last line must end at word <N>. These words may stop in the middle of a sentence (the video goes on): then write that unfinished last sentence with ~ in front of it, like this: <N>|~And then we

Words:
<0:word 1:word …>
```
`maxTokens = min(16000, words*4 + 1500)`. Answer lines are **aligned to the real words by LCS** (`alignLines`: the AI's numbers drift), junk lines (< 50 % matched) dropped, the AI text used only when `sameWords` ≥ 80 %, a sentence cut where two chunks meet is joined (`~` marker or no full stop in written subtitles), pieces ending with a comma followed by a lowercase start are joined (`joinCut`), a failed chunk of written subtitles falls back to full stops (`punctuationLines`), speech subtitles keep the rule-based guess; a sentence > 70 words or > 40 s rejects the chunk. Cached in `drSent:<id>` (`SPLIT_VERSION 7`). While it runs the status says "the AI is finding the complete sentences… 2/9"; when done the book is rebuilt (`rebuild`) where the video is.

### 4.6 Voice-call instructions (`live.ts liveInstructions`, verbatim skeleton)
```
You are the learner's own English teacher, in a live voice call while they watch a YouTube video. Their first language is Chinese; their English is about CEFR level <level>.

Talk like a real phone call: short turns of one to four sentences, warm and natural, easy spoken English. Never use lists, headings or labels. Never ask the learner to repeat; speech recognition may mishear them, so work out what they most likely meant. When you give a Chinese meaning, say it in Mandarin Chinese.

The learner may ask about anything: a word or sentence on the screen, anything else in the video, or any English question at all. Always answer the question itself, fully and kindly: explain the word or idea in easy English with a short everyday example (two if they ask), even when it is not on the screen. Never say that something is not on the screen or not in the video. The part of the video on the screen now (below) is your context: use it when it helps, and when you quote the video, quote only its real words.

[byText (Claude call):] This call works through text: speech recognition writes down what the learner says (it may mishear, so work out what they meant and never ask them to repeat), and a voice reads your answer aloud. Write only plain spoken sentences: no lists, symbols, brackets or emojis. Keep each answer short, one to four sentences and under about 60 words, unless the learner asks for more. Sometimes end with a short, friendly question to keep the talk going. When the learner wants to go back to the video, tell them to say go on.
[realtime (OpenAI):] When the learner wants to watch on (go on, let's go, continue, next, play, OK got it, bye bye), call continue_video right away. When they say they know a word now, call mark_word with status known.

The learner's own instructions for their teacher (follow them):
<DEFAULT_TEACHER or the edited text>

<ALWAYS_RULES>

Video: "<title>"

On the screen now (<from> to <to> in the video):
1. <sentence> …

Hard words on the screen, with their Chinese meaning here: <hints>
You just stopped the video at "<word>" and explained it. Your explanation was: "<≤700 chars>" The learner may ask about it now.   | or: You just explained this part. Your explanation was: "…"
```

---

## 5. Voices and sound (`voice.ts`, `bg.ts synthesize`, `vendor/core/tts/*`, `tts-cache.ts`, `video-engine.ts`)

- **Engine interface** (`vendor/core/tts/engine.ts`): `speak(text, {voiceId, rate, onStart, onWord}) → SpeakHandle { done: Promise<'ended'|'cancelled'|'error'>, cancel(), error }`, `prefetch(text, voiceId, rate)`, `pause/resume/cancelAll/stopReadAhead`, `listVoices()`.
- **System voice** (`webspeech.ts`, `speechSynthesis`): default voice ranking prefers Premium/Enhanced, then Daniel, Samantha, Karen, Moira, Tessa…; joke voices filtered. On iPhone: `speechSynthesis` exists in WKWebView, but the better choice is native `AVSpeechSynthesizer` (section 7.6).
- **Cloud engine** (`AudioTtsEngine`, `cloudEngine(id, lang)`): asks the background `{type:'dream-tts', engine, text, voice, lang}`, gets base64 audio, plays it with an `<audio>` element (LRU cache 32, read-ahead/prefetch, speed changed live, `segment:false` = whole sentences). `VoiceWithBackup`: if the cloud fails → system voice for the rest, one toast. `WithVolume`: volume = `sliderGain(slider)` (squared) × video volume.
- **OpenAI:** `gpt-4o-mini-tts`, voices `marin, cedar, coral, sage, ballad, verse, shimmer, alloy, ash, echo`, `instructions` = VOICE_STYLE en/zh, mp3; ≈ $0.015/min.
- **ElevenLabs:** `POST /v1/text-to-speech/{voice}/with-timestamps?output_format=mp3_44100_128`, model `eleven_multilingual_v2` (Best) or `eleven_flash_v2_5` (Fast), `voice_settings {stability 0.5, similarity_boost 0.8, style 0.1, use_speaker_boost true}`; word timings from `alignment`. Voices George, Alice, Daniel, Lily, Sarah. (The owner cancelled ElevenLabs.)
- **Microsoft Azure Speech (free F0):** `POST https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`, headers `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`, `X-Microsoft-OutputFormat: audio-48khz-192kbitrate-mono-mp3`; SSML `<speak … xml:lang="en-GB"><voice name="en-GB-AdaMultilingualNeural">text <lang xml:lang="zh-CN">中文</lang></voice></speak>` (`azureSsml`; `<lang>` only for `*Multilingual*` voices; 400 → retry without tags). Limiter: **19 requests per minute** queue (`azureTurn`, F0 allows 20), 429 → wait `retry-after` (≤ 10 s) up to 4 times. Errors: 401 key/region, 403 quota used up, 404 region wrong. Key test = `GET /cognitiveservices/voices/list` (free) → saves `drAzureVoices`. Voices (`AZURE_VOICES`, by accent, woman/man): British Ada★/Ollie★/Sonia/Ryan/Libby/Thomas; American Ava★/Andrew★/Emma/Brian/Jenny/Steffan; Australian Natasha/William★; Canadian Clara/Liam; Irish Emily/Connor; New Zealand Molly/Mitchell. ★ = multilingual (says the Chinese itself); others → Chinese goes to `zh-CN-XiaoxiaoNeural` (woman) / `zh-CN-YunxiNeural` (man) (`azureZhVoice`). Words are **not** prefetched with Azure (the 20/min budget is kept for real speech).
- **Sound cache** (`tts-cache.ts`): texts ≤ 80 chars are kept in IndexedDB `dreamVoice` (3000 max) by `engine|voice|lang|quality|text`; a word said once is never paid again.
- **From the video:** `VideoEngine.speak()` plays `target` sentence from `timing.start − 0.15 s` to `timing.end` (polls every ~50 ms, reports words), marks its own play/pause/seek events (`own.*`, 700 ms) so they are not taken for the learner's; `hold()` pauses; `forceStart`, `resumeHere`, `teacherPlayed` (a sentence just played is not played twice). `SentenceFromVideo` routes the taught sentence to the video; `QuotesFromVideo` routes any ≥ 4-word quote that equals a sentence of the part on the page (or the taught sentence ±2) to the video, restores the target after.
- **Mixed English/Chinese:** cloud voices and multilingual Azure voices say a mixed sentence in one piece (`mixedVoice()`); the system voice splits by script (`splitByScript`) and uses a Chinese system voice (`chineseVoiceId()`).

---

## 6. Listening, calls and voice commands

- **Speech recognition** (`youtube.js`): `webkitSpeechRecognition`, `continuous`, `interimResults`, `lang en-US`, restarted on end; started only when `settings.voiceOn && (sendOn || (dreamOwns() && dreamWantsMic()))` (checked every 500 ms); partial results combined into one line; `finishSpeech()` = `rec.stop()` (closes the words as final). Results go to `window.__ytcDream.heard(text, isFinal, key)` (`key = session:index`, acted once). **Not available in WKWebView** → iPhone uses `SFSpeechRecognizer` and calls `heard()` itself (section 7.7).
- **`heard()` rules** (`yt.ts`): voice-mode commands first (`hello / stop / play / bye bye`, ≤ 4 words, final, not when the video or the tutor itself just said them); the live call hears itself (ignore); in the Claude call: while the tutor speaks only `stop / wait / hold on / shut up` (≤ 4 words) interrupt; while thinking, words < 3 are ignored, more words are added to the question; 900 ms after the tutor spoke = ignored; within 4 s an 80 % word overlap with the tutor's last two lines = echo, ignored; `let's go / go on / continue / back to the video / play the video` (≤ 6 words) = `goOn()` (allowed right after the tutor stops unless the tutor itself just said those words); else `chat.ask(text)`. `watchStill`: partial words unchanged for 1.3 s → `finishSpeech()`, 1.2 s more → counted as final (noisy rooms). Talk bar: `Send ➤` (what is being heard now, sends on pointerdown), `Go on ▶ (Enter)`, `✕`. Outside a call: `bye bye`, `shut up`, `hi bro`, `I know / I don't know` in a window (`detectCommand`), a question while the talk is open (`ask(text, spoken=true)`).
- **ChatCall** (`chat-call.ts`): `greet()` (random of 3 greetings, synthetic first user turn), `ask(text)` merges consecutive user turns, `chatStream(system, last 9 turns)`, `StreamSentenceSplitter` → `enqueue` (per script run when not mixed) → `prefetch` → `pump()` speaks sequentially; `interrupt()`, `close()`, `events` log with ms, `lastActivity`, `busy`.
- **Talk life:** `openTalk(pos, word, explanation, greet)` (live call if `liveAvailable()` = OpenAI key + `liveOn` + `callEngine 'openai'`, else ChatCall if any AI key); `talkTick()` every 1 s: quiet = `talkSilenceSec` (real call: ≥ 60 s) after the last activity → `goOn()`; `closeTalk()`; `talkUntilGoOn()` for flows.
- **OpenAI realtime** (`live.ts`): WebRTC to `POST /v1/realtime/calls` (SDP through the background), model `gpt-realtime-2.1` (or `-mini`), voice = `openaiVoice`, `server_vad` threshold 0.25 (mic 3) / 0.35, `prefix_padding_ms 400`, `silence_duration_ms 700`, `noise_reduction far_field`, tools `continue_video` and `mark_word`, transcription on, volume gain + compressor, cost from usage (`realtimeUsd`). Needs an OpenAI key with credit.
- **Push-to-talk** (`pushToTalk`, 🎤 Speak): its own recognizer for one question, `pttActive` blocks the always-on mic, auto-stop after 20 s.
- **Microphone gating** (`wantsMic()`): true when the tutor waits for an answer, a talk is open, `voiceMode`, or `micAlways`; false while `pttActive`. On a Mac an open mic muffles all sound, hence "only when needed".

---

## 7. The iPhone version

### 7.1 The existing YT Learn app (`ios/`), explained
- SwiftUI app, XcodeGen `project.yml`: bundle `local.ytlearn.app`, name "YT Learn", iOS 15+, iPhone + iPad, Info.plist keys `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`.
- `AppModel.swift` (563 lines): owns two `WKWebView`s: **youtube** (`https://m.youtube.com/...`) and **chat** (claude.ai / chatgpt.com). `makeConfig()`: `allowsInlineMediaPlayback = true`, `mediaTypesRequiringUserActionForPlayback = []` (autoplay allowed), a `WKUserScript` at document end in a private `WKContentWorld` concatenating `shim-common, shim-youtube, lib, background, youtube` (`.js` files in `YTLearn/Scripts`, copied by `ios/sync-scripts.sh`; `background.js` wrapped in a function so it runs **inside the YouTube page** instead of a worker); `mic-mix.js` at document start in the page world; a `WKScriptMessageHandlerWithReply` named `ytc` (`window.webkit.messageHandlers.ytc.postMessage(obj)` returns a Promise).
- `shim-common.js`: emulates `chrome.storage.local/session/onChanged` (in-memory + `storageSet` to Swift → `UserDefaults`; initial values injected as `window.__ytcStorageInit`), `chrome.runtime.onMessage/sendMessage` (in-page dispatch, first `sendResponse` wins), console → Swift log. `shim-youtube.js`: fake `chrome.tabs` (tab 1 = YouTube, tab 2 = chat web view; `tabs.sendMessage(2, msg)` → Swift `tabsSend` → `window.__ytcDeliver(msg)` in the chat view), `chrome.scripting/debugger` stubs, speech events from Swift via `window.__ytcSpeech(event)`.
- `SpeechListener.swift`: `SFSpeechRecognizer(en-US)` + `AVAudioEngine` buffer request, partial results. `Voice.swift`: `AVSpeechSynthesizer` en-US. `CallFeeder.swift`: feeds the app's own TTS into the chat site's microphone line (`mic-mix.js`).
- `ContentView.swift`: layouts (video big / half / chat big), top bar (Ask, Claude|ChatGPT, AI size, … menu), toasts.
- **What it lacks:** everything in section 1 (dream-yt.js is not loaded; no ports; no `dream-tts`; no keys; no dictionary resource; no IndexedDB use; speech only for "let's go"/questions to the chat site).

### 7.2 Chosen architecture
One app, one main `WKWebView` on `m.youtube.com` (the chat web view stays for the old mode, hidden by default). Load, in the YouTube page's content world at document end, in this order: `shim-common.js` (extended), `shim-youtube.js`, `shim-dream.js` (new: ports, getURL, tabs for the vocab/options pages), `lib.js`, `youtube.js`, **`dream-bg.js` wrapped** `(function(self){ … })(window)` so `installDreamBackground()` runs in the page (it only needs `chrome.runtime.onConnect/onMessage`, `chrome.storage`, `fetch`, `indexedDB` — all present), then `dream-yt.js`. The content script connects to the "background" through the shimmed `chrome.runtime.connect` (same page, in-process). Native Swift provides: file storage, cross-origin `fetch` (`nativeFetch`), speech recognition, system TTS, audio session, the dictionary and page resources through a custom URL scheme, keys in the Keychain, the settings/vocabulary pages as in-app sheets.

```
┌──────────── YT Learn (Swift / SwiftUI) ───────────────────────────────┐
│ AppModel: WKWebView(youtube) ← user scripts: shims + lib + youtube +   │
│           dream-bg (wrapped) + dream-yt                                │
│ Bridge (WKScriptMessageHandlerWithReply "ytc"):                        │
│   storageGet/Set/Remove (JSON file per area)  nativeFetch (URLSession) │
│   keychainGet/Set (API keys)   speakNative / stopNative (AVSpeech)     │
│   micStart / micStop (SFSpeechRecognizer → window.__ytcDream.heard)    │
│   audioSession(mode)   openPage(options|vocab)   log                   │
│ WKURLSchemeHandler "ytlearn://" → dream/dict.json.gz, options.html …   │
│ Bottom bar (native): ⏸/▶  Explain 30 s  ←  📞  🎙  📄  📖  📒  ⚙       │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.3 `chrome.*` → iOS mapping

| Chrome API (where) | iOS replacement |
|---|---|
| `chrome.storage.local.get/set/remove`, `onChanged` (store.ts, yt.ts, youtube.js) | shim-common `area()`, persisted by Swift to `Documents/storage-local.json` (not UserDefaults: vocab + subtitle caches can reach MBs); debounce writes 300 ms; `onChanged` fired in-page. `chrome.storage.session` = in-memory. |
| `chrome.storage.sync` (vocab-sync.ts) | same file store under `storage-sync.json` (acts as the "online copy"; real iCloud via `NSUbiquitousKeyValueStore` is optional, 1 MB limit → keep `drSyncPart` ≤ 100 KB each). |
| `chrome.runtime.connect({name:'dream-ai'})` + `Port.onMessage/postMessage/onDisconnect/disconnect`, `chrome.runtime.onConnect` (ai-client.ts ↔ bg.ts) | shim-dream: an in-page `Port` pair (two objects sharing two listener lists); `onConnect` listeners get the server end. Streaming works because both sides are the same page. |
| `chrome.runtime.sendMessage` / `onMessage` (`dream-tts`, `dream-test-azure`, `dream-live-sdp`, `dream-usage`, `dream-open`, `dream-vocab-online`, `dream-dev-check`, `heard`, `ask`, `voice-wake`) | shim-common `dispatch()` (already there). `dream-dev-check` → return `{reloading:false}`. |
| `chrome.runtime.getURL('dream/dict.json.gz')` (ai-client.ts) | `ytlearn://app/dream/dict.json.gz` served by a `WKURLSchemeHandler` from the app bundle (also `options.html`, `vocab.html`, `pages.css`, `options.js`, `vocab-page.js`). |
| `chrome.runtime.getManifest()` (version, `update_url` check in bg.ts) | return `{ version: '3.2', name: 'YT Learn', update_url: 'ios' }` (so `isUnpacked()` is false → no self-update). |
| `chrome.runtime.reload`, `getPlatformInfo` | no-ops (`getPlatformInfo` → `Promise.resolve({os:'ios'})`). |
| `fetch()` to api.anthropic.com / api.openai.com / api.elevenlabs.io / *.tts.speech.microsoft.com from the page | **Route through Swift** (`nativeFetch {url, method, headers, body(base64), stream}`) to avoid CORS/ATS problems; streaming responses are forwarded as `window.__ytcFetchChunk(id, base64)` events. In `bg.ts` the SDKs accept a custom `fetch` (`new Anthropic({ fetch: shimFetch })`, `new OpenAI({ fetch: shimFetch })`); Azure/ElevenLabs use `fetch` directly → replace the global `fetch` for those hosts in shim-dream. (Anthropic and OpenAI do support CORS from a browser with `dangerouslyAllowBrowser`, so a first version can try the page `fetch` directly; Azure TTS and ElevenLabs also answer CORS. Keep `nativeFetch` as the robust path.) |
| `chrome.tabs.query/sendMessage/create/get/update/reload`, `chrome.scripting`, `chrome.debugger`, `chrome.tts` (old mode in youtube.js/background.js) | already stubbed by shim-youtube (tab 1/2), `debugger` rejects (no screenshots), `tts` → `speakNative`. |
| `window.open` / `dream-open` pages (options, vocab) | Swift opens a sheet with a second `WKWebView` on `ytlearn://app/dream/options.html` (same shims + storage). |
| `webkitSpeechRecognition` (youtube.js) | not in WKWebView → Swift `SFSpeechRecognizer` (section 7.7). |
| `speechSynthesis` (webspeech.ts) | works in WKWebView on iOS 16+, but use `speakNative` for quality (section 7.6) by registering a new engine id `'ios'` or by making `webspeech.ts` call the bridge when `window.__ytcIOS`. |
| `<audio>` playback of cloud TTS (audio.ts) | works; requires `allowsInlineMediaPlayback` and `mediaTypesRequiringUserActionForPlayback = []` (already set). AVAudioSession `.playback` + `.mixWithOthers` (section 7.8). |
| `getUserMedia` + WebRTC (live.ts, OpenAI call) | works in WKWebView (iOS 14.3+) with `NSMicrophoneUsageDescription`; page origin is https. |
| `indexedDB` (tts-cache.ts, in the worker) | works in the page (WKWebView, persistent with the default data store). |
| `localStorage` backup | works (same origin m.youtube.com). |
| keyboard shortcuts | native bottom bar buttons call `window.__ytcDream.action(id)` (add a small `action(id)` to the DreamHook that runs the same code as `runShortcut`). |

### 7.4 Swift bridge skeletons (new or changed files in `ios/YTLearn/`)
`Bridge.swift` — one handler for all kinds:
```swift
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var model: AppModel?
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage,
                               replyHandler reply: @escaping (Any?, String?) -> Void) {
        guard let body = m.body as? [String: Any], let kind = body["kind"] as? String else { reply(nil, "bad message"); return }
        switch kind {
        case "storageGet":    reply(Store.shared.get(area: body["area"] as? String ?? "local", keys: body["keys"]), nil)
        case "storageSet":    Store.shared.set(area: body["area"] as? String ?? "local", obj: body["obj"] as? [String: Any] ?? [:]); reply(nil, nil)
        case "storageRemove": Store.shared.remove(area: body["area"] as? String ?? "local", keys: body["keys"] as? [String] ?? []); reply(nil, nil)
        case "keychainGet":   reply(Keys.get(body["name"] as? String ?? ""), nil)
        case "keychainSet":   Keys.set(body["name"] as? String ?? "", body["value"] as? String); reply(nil, nil)
        case "nativeFetch":   NativeFetch.run(body, web: m.webView, reply: reply)           // streams chunks back via evaluateJavaScript
        case "speak":         model?.voice.speak(body["text"] as? String ?? "", voice: body["voice"] as? String, rate: body["rate"] as? Double ?? 1, volume: body["volume"] as? Double ?? 1, id: body["id"] as? String ?? ""); reply(nil, nil)
        case "speakStop":     model?.voice.stop(); reply(nil, nil)
        case "voices":        reply(model?.voice.list(), nil)                                  // AVSpeechSynthesisVoice.speechVoices()
        case "micStart":      model?.speech.start(); reply(nil, nil)
        case "micStop":       model?.speech.stop(); reply(nil, nil)
        case "audioSession":  AudioSession.set(mode: body["mode"] as? String ?? "play"); reply(nil, nil)
        case "openPage":      model?.openSheet(page: body["page"] as? String ?? "options"); reply(nil, nil)
        case "log":           NSLog("[web] %@", body["text"] as? String ?? ""); reply(nil, nil)
        default:              reply(nil, "unknown kind \(kind)")
        }
    }
}
```
`Store.swift` — JSON files: `Documents/storage-local.json`, `storage-sync.json`; `get` returns the picked keys; `set` merges, writes atomically (debounced), and posts `window.__ytcStorageChanged({...}, area)` is **not** needed because the shim fires `onChanged` itself; on launch the whole local store is injected as `window.__ytcStorageInit` (keep `drKeys` out of it: keys come from the Keychain through `keychainGet`).
`Keys.swift` — `SecItemAdd/CopyMatching` under service `local.ytlearn.keys`, account = provider (`anthropic | openai | elevenlabs | azure`). In the shim, `chrome.storage.local.get('drKeys')` is answered from the Keychain and `set({drKeys})` writes to it.
`NativeFetch.swift` — `URLSession.dataTask` for non-stream, `URLSessionDataDelegate` for streams: on each chunk `webView.evaluateJavaScript("window.__ytcFetchChunk(\(id), '\(base64)')")`, at the end `__ytcFetchEnd(id, status, headersJSON)`; the JS side builds a `Response` with a `ReadableStream` (SSE streaming from Anthropic/OpenAI works through this). Timeout 60 s. Allowed hosts only: `api.anthropic.com, api.openai.com, api.elevenlabs.io, *.tts.speech.microsoft.com`.
`Voice.swift` (extend) — `AVSpeechSynthesizer`; `speak(text, voice, rate, volume, id)`; `utterance.voice = AVSpeechSynthesisVoice(identifier:)` (e.g. `com.apple.voice.premium.en-GB.Malcolm`, `…en-US.Zoe`; list with `AVSpeechSynthesisVoice.speechVoices()` filtered `language hasPrefix "en"`, quality `.premium`/`.enhanced` first; the user downloads premium voices in iOS Settings → Accessibility → Spoken Content → Voices); `utterance.rate = AVSpeechUtteranceDefaultSpeechRate * rate`; `utterance.volume`; delegate `didStart/didFinish/didCancel/willSpeakRangeOfSpeechString` → `window.__ytcSpeech({kind:'tts', id, event:'start'|'end'|'cancel'|'word', charIndex, charLength})`; Chinese: `AVSpeechSynthesisVoice(language:"zh-CN")`.
`SpeechListener.swift` (extend) — continuous `SFSpeechAudioBufferRecognitionRequest` with `shouldReportPartialResults = true`, `requiresOnDeviceRecognition = false` (on-device possible on iOS 13+ for en-US: more private, no 1-minute limit), restart every ~55 s (server limit) and on error; results → `webView.evaluateJavaScript("window.__ytcDream && window.__ytcDream.heard(\(json text), \(isFinal), '\(sessionKey)')")`; `finishSpeech` = end audio + new request (the shim maps `window.__ytcApi.finishSpeech` to `micStop`+`micStart`). Start/stop driven by `wantsMic()`: the shim polls `window.__ytcDream.wantsMic()` every 500 ms (as youtube.js does) and calls `micStart/micStop`; push-to-talk uses the same with a 20 s cap.
`AudioSession.swift` — `AVAudioSession.sharedInstance()`; mode `play`: `.playback`, options `[.mixWithOthers, .duckOthers]` (the TTS plays over the video; the video is in the same web view so no duck needed, keep `.mixWithOthers`); mode `record`: `.playAndRecord`, options `[.defaultToSpeaker, .allowBluetooth, .mixWithOthers]`; `UIBackgroundModes: audio` so the tutor keeps talking with the screen off (video audio from the web view also continues when `allowsPictureInPictureMediaPlayback` is set).
`SchemeHandler.swift` — `WKURLSchemeHandler` for `ytlearn://app/<path>` → bundle file in `YTLearn/Web/` (`dream/dict.json.gz` with `Content-Type: application/gzip`, `dream/options.html`, …). Register with `config.setURLSchemeHandler(SchemeHandler(), forURLScheme: "ytlearn")`.
`ContentView.swift` (extend) — native bottom bar (SF Symbols) calling `model.dream(action)` → `evaluateJavaScript("window.__ytcDream.action('\(id)')")` for: `stop`, `explainLast`, `explainSentence`, `talk`, `voiceMode`, `pageAuto`, `listening`, `page`, `vocab`, `quick`. Keep the existing top bar for the old mode.

### 7.5 JS shim additions (`ios/YTLearn/Scripts/shim-dream.js`, new)
```js
(function () {
  const post = (o) => window.webkit.messageHandlers.ytc.postMessage(o);
  // ports: chrome.runtime.connect ↔ chrome.runtime.onConnect, both in this page
  const connectListeners = [];
  function makePair(name) {
    const mk = (other) => { const l = { msg: [], dis: [] }; return { name, _l: l, _other: null,
      onMessage: { addListener: (f) => l.msg.push(f) }, onDisconnect: { addListener: (f) => l.dis.push(f) },
      postMessage: (m) => setTimeout(() => this_._other._l.msg.forEach((f) => f(JSON.parse(JSON.stringify(m)))), 0),
      disconnect: () => { const o = this_._other; if (o) o._l.dis.forEach((f) => f()); } }; };
    const a = {}, b = {}; /* build with closures so each side reaches the other */
    // (implementation: two objects, each postMessage delivers to the other's msg listeners asynchronously;
    //  disconnect fires the other's dis listeners once)
    return [a, b];
  }
  chrome.runtime.connect = ({ name }) => { const [client, server] = makePair(name); setTimeout(() => connectListeners.forEach((f) => f(server)), 0); return client; };
  chrome.runtime.onConnect = { addListener: (f) => connectListeners.push(f) };
  chrome.runtime.getURL = (p) => 'ytlearn://app/' + p;
  chrome.runtime.getManifest = () => ({ version: '3.2', name: 'YT Learn', update_url: 'ios' });
  chrome.runtime.reload = () => {}; chrome.runtime.getPlatformInfo = () => Promise.resolve({ os: 'ios' });
  // keys live in the Keychain
  const origGet = chrome.storage.local.get, origSet = chrome.storage.local.set;
  chrome.storage.local.get = async (keys) => { const r = await origGet(keys); if (wants(keys, 'drKeys')) r.drKeys = JSON.parse(await post({ kind: 'keychainGet', name: 'drKeys' }) || '{}'); return r; };
  chrome.storage.local.set = async (obj) => { if ('drKeys' in obj) { await post({ kind: 'keychainSet', name: 'drKeys', value: JSON.stringify(obj.drKeys) }); const { drKeys, ...rest } = obj; obj = rest; fireChanged({ drKeys: { newValue: drKeys } }); } return origSet(obj); };
  // cross-origin fetch through Swift (streaming)
  const API_HOSTS = /^(https:\/\/)(api\.anthropic\.com|api\.openai\.com|api\.elevenlabs\.io|[a-z0-9-]+\.tts\.speech\.microsoft\.com)\//;
  const pageFetch = window.fetch.bind(window);
  window.fetch = (url, init) => (API_HOSTS.test(String(url instanceof Request ? url.url : url)) ? nativeFetch(url, init) : pageFetch(url, init));
  // speech from Swift → the tutor; mic on/off from the tutor's wantsMic()
  setInterval(() => { const want = !!(window.__ytcDream && window.__ytcDream.wantsMic && window.__ytcDream.wantsMic()); if (want !== micOn) { micOn = want; post({ kind: want ? 'micStart' : 'micStop' }); } }, 500);
  window.__ytcApi && (window.__ytcApi.finishSpeech = () => post({ kind: 'micStop' }).then(() => micOn && post({ kind: 'micStart' })));
  // the system voice: AVSpeechSynthesizer behind the WebSpeech interface
  window.__ytcIOS = { speak: (text, voice, rate, volume, id) => post({ kind: 'speak', text, voice, rate, volume, id }), stop: () => post({ kind: 'speakStop' }), voices: () => post({ kind: 'voices' }) };
})();
```
Then in `dream-ext/vendor/core/tts/webspeech.ts` add: if `window.__ytcIOS` exists, `speak()` calls `__ytcIOS.speak` and resolves on the `window.__ytcSpeech({kind:'tts', id, event})` events; `listVoices()` from `__ytcIOS.voices()`; `defaultVoiceId()` prefers `premium`/`enhanced` en-GB/en-US identifiers. (Alternative: keep `speechSynthesis` of WKWebView; it works but voice choice and events are weaker.)

### 7.6 Files and layout
```
ios/
  project.yml                 add: UIBackgroundModes [audio], NSMicrophoneUsageDescription (new text), NSSpeechRecognitionUsageDescription,
                              NSAppTransportSecurity not needed (all https), CFBundleURLTypes none
  sync-scripts.sh             add: cp ../youtube-to-claude/dream/dream-bg.js, dream-yt.js, options.js, vocab-page.js, options.html, vocab.html, pages.css, dict.json.gz → YTLearn/Web/dream/ ; wrap dream-bg.js: (function(self){ <file> })(window)
  YTLearn/
    YTLearnApp.swift ContentView.swift AppModel.swift WebHost.swift (existing)
    Bridge.swift Store.swift Keys.swift NativeFetch.swift AudioSession.swift SchemeHandler.swift (new)
    Voice.swift SpeechListener.swift CallFeeder.swift (extended)
    Scripts/ shim-common.js shim-youtube.js shim-dream.js(new) shim-chat.js lib.js background.js youtube.js chat.js mic-mix.js dream-bg.js dream-yt.js
    Web/dream/ dict.json.gz options.html options.js vocab.html vocab-page.js pages.css
```
Content-script order in `makeConfig()` for the YouTube view: `shim-common, shim-youtube, shim-dream, lib, background(wrapped), youtube, dream-bg(wrapped), dream-yt`. YouTube on the phone: `m.youtube.com` (mobile page: the player is `<video>` too; `#secondary` panel does not exist → the panel mounts under the player: `yt.ts mountPanel` must fall back to inserting after `ytm-item-section-renderer`/the player container; the band and stage are position:fixed and work as they are).

### 7.7 Step-by-step build plan (what the AI does, in order)
1. **Prepare the extension bundles for WebKit:** in `dream-ext/build.mjs` add a second target `['safari16']` output `youtube-to-claude/dream-ios/` (same entries) — esbuild only; or keep one bundle (chrome116 syntax is fine for Safari 16+). Add the `DreamHook.action(id)` method and `window.__ytcIOS` support in `webspeech.ts`. Build, run `npx vitest run` (33) and `tests/dream-e2e.js` (105) to be sure Chrome still passes.
2. **WebKit test first (no Xcode):** extend `tests/safari-webkit-test.js` (Playwright `webkit`): a fake m.youtube.com page (reuse the fake of `dream-e2e.js`), inject the same script list as the app with a fake `window.webkit.messageHandlers.ytc` (Node answers storage/fetch/speak), and run the main checks: subtitles → book, a stop, an explanation streamed, the pause flow, a Claude call turn through `heard()`, Azure TTS request shape. This finds most WebKit bugs on the Mac.
3. **Swift:** add the six new files (7.4), extend `Voice`, `SpeechListener`, `AppModel.makeConfig` (scheme handler, new script list, `__ytcStorageInit` from `Store`), `ContentView` bottom bar. `project.yml`: background audio, iOS 16 minimum.
4. **Scripts:** `shim-dream.js`; update `sync-scripts.sh`; run it.
5. **GitHub Actions:** the `ios` job already produces `YTLearn-unsigned.ipa` + `YTLearn-Xcode-project.zip` on every push (macos-14 runner, XcodeGen, `CODE_SIGNING_ALLOWED=NO`). Update its "check the JavaScript files are inside the app" list and the simulator self-test (`-selftest` launch argument writes `Documents/selftest.json`: add checks "dream-yt loaded", "dictionary loaded", "a stop happened", "TTS request built").
6. **Push:** `git add -A && git commit -m "iOS: My tutor" && git push origin claude/new-session-pxh22u` (the owner has the GitHub login; the AI cannot push). Download the artifact `ios` from the Actions run.
7. **Install on the iPhone (way A):** Sideloadly on the Mac → the `.ipa` → Apple ID → the phone. iOS: Settings → General → VPN & Device Management → Trust; Settings → Privacy & Security → Developer Mode → On (iOS 16+), restart. 7 days with a free ID.
8. **First run on the phone:** ⚙ → API keys: Claude key, Microsoft key + region (the keys go to the Keychain); allow Microphone and Speech Recognition when asked; pick the voice (Microsoft Ada, or an iOS premium voice).
9. **Fix rounds:** the owner reports; the app's status line and a `🩺 Check` sheet (reuse `diag()`) show the exact error; `NSLog` lines are visible in Xcode/Console.app if a Mac with Xcode is used later.
10. **Way B later (Xcode on the Mac):** `ios/build-on-my-mac.sh` generates and opens the project; Signing & Capabilities → Team = Apple ID; Run on the Simulator (`xcrun simctl`) or the device. Then the AI can test everything itself.

### 7.8 iPhone-specific rules to respect
- **Autoplay:** the video and the TTS `<audio>` start without a tap because `mediaTypesRequiringUserActionForPlayback = []`; still, the very first `play()` after app start may need one user tap (iOS policy) → the first stop waits for the user's first tap on the video (already how the Chrome version behaves when `v.play()` is blocked: it shows "Press play on the video").
- **Speech recognition:** `SFSpeechRecognizer` server mode = 1-minute sessions and a daily limit per device; use `requiresOnDeviceRecognition = true` when `supportsOnDeviceRecognition` (en-US on iPhone XS and newer) for the always-on voice mode; restart sessions silently.
- **Microphone + playback together:** `.playAndRecord` with `.defaultToSpeaker`; echo: the Claude call's echo filter in `heard()` (80 % overlap, 4 s) stays; when the tutor speaks, `micStop` (the shim already follows `wantsMic()`, which is false while the tutor talks in a call).
- **Background:** with `UIBackgroundModes audio` the tutor's voice and the video audio continue with the screen off (hands-free listening); speech recognition does not run in the background (iOS) → voice mode works with the screen on only.
- **Memory:** `dict.json.gz` decompressed is ~15 MB in JS; fine. Keep the subtitle/AI caches in files, not UserDefaults.
- **Keys:** Keychain only; never in the JSON store, never in logs; the settings page shows `saved (…xxxx)` as in Chrome.
- **App Store:** showing YouTube in a web view and automating it conflicts with YouTube's ToS and App Store Review Guideline 5.2.3; keep it for personal use (sideload / TestFlight internal) unless legal advice says otherwise.
- **iPad:** same app (`TARGETED_DEVICE_FAMILY "1,2"`); the panel can sit beside the video in landscape (reuse `layoutIndex`).

### 7.9 Testing checklist on the phone (what the owner checks, 5 minutes)
1. Open a TED video; the status says "N sentences (complete, by the AI)"; subtitles band shows.
2. The video stops at a hard word; the word is said 3 times; the card shows; "I know" plays on.
3. "I don't know": the explanation is spoken (no gaps), the sentence plays again from the video, the video goes on.
4. Pause the video: the part replays once, the explanation starts with "what is happening", the original sentences come from the video.
5. ⏸ stops everything; ▶ plays on. 📄 off: no big page at stops.
6. 📞: the tutor greets; say "what does X mean"; the answer is spoken; say "go on": the video plays.
7. 🎙 voice mode: "stop", "play", "hello", "bye bye".
8. ⚙ → Voice shows "Microsoft this month: … of 500,000"; change the voice; ▶ Test.
9. Close the app, open the same video: "Back where you stopped".
10. Screen off: the tutor keeps talking.

---

## 8. Costs and how usage is kept low (already built)
- Explanations: Claude Opus 5.5 with `effort low`, prompt caching of the system prompt, lean context (80/40 words), only the last explanation as history. About $0.2–1 per day of use (measured: $3.73 in the first week).
- Background jobs (sentences, hints, phrases, Chinese): Haiku 5.5.
- Voice calls: Haiku 5.5, last 10 turns, 2000 max tokens.
- Voice: Microsoft free F0 = 500,000 characters/month (≈ 9 h of tutor speech; paid S0 ≈ $15–16 per million ≈ $0.85/h). The voice reads only the AI's own words: quoted video sentences play from the video; short texts (words ×3, phrases, Chinese meanings) are cached on the device and never paid twice; no prefetch of words with Azure.
- Monthly AI stop at `monthlyStopUsd` 10 (settable).
- The ⚙ counter shows the Microsoft characters used this month and the hours left.

## 9. Tests to keep green
- `cd dream-ext && npx vitest run` — 33 unit tests (sentence split/alignment, Azure SSML/limiter/counter, ChatCall empty-answer retry and mixed voice, resume spot, level suggestion, shortcuts, live session, playback flows).
- `node tests/dream-e2e.js` — 105 browser checks in Chromium with a fake API (needs `CHROME` = a full Chromium, `PWMOD`, `PLAYWRIGHT_BROWSERS_PATH`; takes ~7 min). Sections: subtitles and the AI split, stops and windows, pause flow and replay, ←, listening mode, sizes/volumes/quick settings, teaching ways, OpenAI voice + live call, Claude call (greeting, spoken question, "let's go", stuck words), Explain button, selection, Speak, voice mode, Microsoft voice (Auto, SSML, wrong box, counter), page on/off and ⏸, slow page, check report, settings page, vocabulary, backup/restore.
- `node tests/safari-webkit-test.js` — old mode in WebKit; extend for My tutor (section 7.7 step 2).
- `node tests/lib-unit.js`, `tests/extension-e2e.js` (old mode; one known flaky check "talk mode: the AI answer is read aloud").

## 10. Appendix: repo map (important files)
```
youtube-to-claude/            the Chrome extension (load unpacked); manifest.json (v3.2), background.js, lib.js, youtube.js, chat.js, mic-mix.js, popup.*
youtube-to-claude/dream/      built bundles + dict.json.gz + options/vocab pages + build-stamp.txt
dream-ext/src/
  yt.ts            My tutor content script (the session class: panel, band, stage, flows, talk, voice mode, memory, level, diagnostics)
  bg.ts            background: AI (explain/complete/chat), TTS (OpenAI/ElevenLabs/Azure), key tests, usage, keep-awake, self-update, vocab sync
  ai-client.ts     ports to the background; dictionary loading
  chat-call.ts     the Claude voice call (speech → Claude → voice)
  live.ts          OpenAI realtime call; liveInstructions
  voice.ts         voice lists; cloud engine; backup/volume/router engines (SentenceFromVideo, QuotesFromVideo)
  tts-cache.ts     IndexedDB sound cache
  video-engine.ts  plays sentences from the YouTube video
  video-book.ts    TimedSentence → book with positions and timings
  sentences-ai.ts  AI complete sentences (split, align, join)
  hard-sentences.ts zh.ts   cheap-model jobs
  store.ts         storage keys, defaults, migrations, spots/done, Azure counter helpers
  vocab.ts vocab-sync.ts vocab-page.ts   My Vocabulary, progress, level suggestion, online copy
  quick.ts options.ts   quick settings panel / full settings page
  teacher-text.ts teaching-ways.ts   prompts
  shortcuts.ts     keyboard shortcuts
  dream.css        styles of panel/band/stage/card/quick
dream-ext/vendor/  "Dream Read" core: listen/controller.ts (the teacher state machine), listen/playback.ts, ai/prompts.ts, tts/*, dict/*, nav, model; shared/settings.ts, shared/styles.ts
dream-ext/test/    vitest unit tests;  tests/  Playwright e2e and WebKit tests
ios/               YT Learn app (SwiftUI, XcodeGen);  safari/  Safari extension variant;  .github/workflows/build.yml  cloud builds (Mac app, iOS .ipa, Safari app)
research_notes/    the 7 teaching styles;  reports/  "Tutor art voices and sleep listening"
FEATURES.md README.md   older feature lists and the release page
```
Glossary: **stop** = the tutor pauses the video at a hard item; **part** = the last 20–60 s as sentences; **stage** = the big reading page; **band** = subtitles over the video; **window** = the "Do you know …?" buttons; **talk/call** = the conversation with the tutor; **voice mode** = always-listening commands; **way** = a teaching style; **F0** = Microsoft's free plan.
