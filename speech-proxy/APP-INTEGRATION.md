# The Speechify voice in the apps: what the UI engineer wires in

The shared code (dream-ext) has the Speechify voice ready and tested (`dream-ext/test/speechify.test.ts`), but
**nothing uses it yet**: every existing page calls `resolveVoice()` without the new option, so it never gets
'speechify' and behaves exactly as before. To turn it on, do the steps below.

The Worker itself: `speech-proxy/src/index.ts`; the owner's steps: `speech-proxy/SETUP.md`.

## 1. Settings and the key

| What | Where | Type / default |
|---|---|---|
| Worker address | `extras.speechifyUrl` (`store.patchExtras({ speechifyUrl })`) | `string`, default `''` (= not set up). `https://…`; a trailing `/` is fine |
| App code | `store.setKey('speechify', code)` (kept with the other keys: drKeys = iPhone Keychain) | `Keys.speechify?: string`. It is the Worker's APP_CODE, **not** the Speechify API key |
| Voice | `extras.speechifyVoice` | `string`, default `''` = the Worker's default (natural British English) |
| Daily limit on this device | `extras.speechifyDailyChars` | `number`, default `20000`; `0` = Speechify sends nothing |
| Voice choice | `extras.voice = 'speechify'` | `VoiceChoice` now includes `'speechify'` |

## 2. The voice engine (book.ts, yt.ts, reader.ts, tutor-say.ts)

```ts
import { resolveVoice, cloudEngine, VoiceWithBackup, type VoiceKind } from './voice';

const kind: VoiceKind = resolveVoice(extras.voice, keys, { speechifyUrl: extras.speechifyUrl /*, noOpenAi: true in I Know Book */ });
// kind === 'speechify' when chosen and set up, or when 'auto' and BOTH the address and keys.speechify are set (first in auto)
const tts = kind === 'mac' ? mac : new VoiceWithBackup(cloudEngine(kind, 'en'), mac, () => macVoice, (e) => toast(e.message, 6000));
// the voiceId to speak with: kind === 'speechify' ? extras.speechifyVoice : (azureVoice / openaiVoice / elevenVoice as now)
```

- Signatures (`dream-ext/src/voice.ts`):
  - `type CloudVoice = 'openai' | 'elevenlabs' | 'azure' | 'speechify'`, `type VoiceKind = 'mac' | CloudVoice`
  - `resolveVoice(choice, keys, o?: { noOpenAi?: boolean }): Exclude<VoiceKind, 'speechify'>` (the old call, unchanged)
  - `resolveVoice(choice, keys, o: { noOpenAi?: boolean; speechifyUrl: string }): VoiceKind` (the new call)
  - `cloudEngine(id: CloudVoice, lang: 'en' | 'zh', o?: CloudOptions): AudioTtsEngine`. For 'speechify': label
    `SPEECHIFY_LABEL` ('Speechify voice'), `id` = `SPEECHIFY_ENGINE` ('speechify', cast to an engine id because
    vendor/shared is not edited), word times from Speechify's speech marks, only **one** sentence of read-ahead.
  - `ttsError(id, reply): Error` (how a failed sentence becomes an error; every Speechify error has `code: 'busy'`,
    a `note` and `once: true`).
- Widen these types from `'mac' | 'openai' | 'elevenlabs' | 'azure'` to `VoiceKind`: `book.ts` `voiceKind`,
  `yt.ts` `voiceKind`, `quick.ts` `QuickCtx.voiceNow`, and `native-audio.ts` `NativeAudioEngine` constructor id
  (`CloudVoice`). Add the name "Speechify" where the pages print the voice name (book.ts line ~596, yt.ts ~780).
- `VoiceWithBackup` already does the rule "any error = the iPhone voice for that sentence at once": a Speechify
  error is not tried again, the iPhone voice says the sentence, the next sentence tries Speechify again, and
  `onTrouble` gets the short message **only the first time** (per engine). After the daily limit every sentence goes
  to the iPhone voice at once with no network request. Just show `e.message` in a toast as for the other voices.
- `NativeAudioEngine` (the app's browser pages, tutor-say.ts): its fetch throws a plain Error, so a failure is tried
  once more before the iPhone voice. Better: `throw ttsError(this.id, r)` there (import from voice.ts).
- yt.ts makes a second engine for the Chinese meanings (`cloudEngine(kind, 'zh')`). With Speechify this sends the
  Chinese with `language: zh-CN` (needs MODEL simba-3.5). To save characters you may keep the iPhone Chinese voice
  for 'zh' when `kind === 'speechify'`.

### Read-ahead and "books one paragraph at a time"
- The engine for Speechify fetches only the **next** sentence ahead (AudioEngineOptions `ahead: 1`; other voices 2).
- book.ts `readOn()` passes the next 2 sentences to `tts.readAhead`. For Speechify, pass only the next sentence
  **of the same paragraph** (nothing across a paragraph end):
  `order.slice(index + 1, index + 3).filter((p) => sameParagraph(p, pos))` when `voiceKind === 'speechify'`.
- One request per paragraph (the owner's wish) is possible: `say(paragraphText)` once, and move the "current
  sentence" mark with the word times (`SpeakHandle.words`, charIndex into the paragraph). Fewer requests (fewer counter
  writes, see SPEECHIFY-FACTS.md), but a stop in the middle of a paragraph then needs the paragraph again (from the
  device cache: free). Per sentence works too and stays well under the limits. The Worker takes up to 2,000
  characters per request (Speechify's limit); a longer paragraph fails and is read by the iPhone voice, so split
  paragraphs over 2,000 characters at a sentence end.

## 3. The Settings rows (quick.ts for I Know, book.ts for I Know Book)

| Row | What it does |
|---|---|
| **Voice** segment | add `['speechify', 'Speechify']` to the voice choices. The "missing key" line: Speechify is missing when `!extras.speechifyUrl.trim() || !keys.speechify` ("Add the Speechify address and app code") |
| **Speechify address** (text field) | save: `store.patchExtras({ speechifyUrl: value.trim() })`. Placeholder `https://iknow-speech.yourname.workers.dev` |
| **Speechify app code** (password field, like the other key boxes) | save: `store.setKey('speechify', value)`; empty = remove. Never show it back (show "saved" like the other keys) |
| **Test** button | `chrome.runtime.sendMessage({ type: 'dream-speechify-test' })` -> `{ ok: boolean, message: string }`. Costs nothing |
| **Speechify voice** (select) | `voice.speechifyVoiceList(): Promise<{ voices: SpeechifyVoiceOption[], default: string \| null }>` (throws with a short message when not set up / unreachable). Option text: `voice.speechifyVoiceName(v)` -> "Emma (British, woman) ★ default"; value `v.id`. First option "Default (British)" with value `''`. Save: `store.patchExtras({ speechifyVoice: id })`. `v.preview` is a sample mp3 URL (optional play button) |
| **Counter** | `store.getSpeechifyUsage(): Promise<SpeechifyUsage>` = `{ today, month, dailyLimit, left, stopped }` (this device, local day). Text: `store.speechifyUsageText(u)` -> "Speechify today: 1,234 of 20,000 characters · this month: 15,678". Both apps together, as the Worker counts (UTC day): `chrome.runtime.sendMessage({ type: 'dream-speechify-usage' })` -> `{ local: SpeechifyUsage, server: SpeechifyServerUsage \| null }`, `server = { day, today, month, monthChars, requestsToday, dailyLimit, left }` |
| **Daily limit** (number field) | `store.patchExtras({ speechifyDailyChars: Math.max(0, Math.round(n)) })`. Note under it: "Then the free iPhone voice until tomorrow. The Worker has its own limit too (DAILY_CHAR_LIMIT)." |

Other exports, if useful: `bg.speechifyVoices()`, `bg.speechifyServerUsage()`, `bg.testSpeechify()` (what the
messages call), `store.speechifyCharsSince(list, sinceIso)`, `store.stopSpeechifyToday()`, `store.localDay()`,
`store.SPEECHIFY_MODEL` ('speechify': the model name of the usage records; they also count toward the AI budget
`usdSince`, at $15 per million characters for simba-3.5), `tts-cache.SPEECHIFY_LIMIT` (the limit message).

## 4. REQUIRED outside dream-ext: let the iPhone app's own fetch reach the Worker

The iPhone app fetches the AI and voice services through Swift (no CORS, no page rules), but only the hosts in two
lists. The Worker's host is not in them yet. Without this, the request goes through the page's own fetch: from
the I Know Book page (ytlearn://app) that works (the Worker allows that Origin), but on the **YouTube page** the
site's Content-Security-Policy can block it, and then every sentence falls back to the iPhone voice.

- `ios/YTLearn/NativeFetch.swift`, `allowed(_:)`: add `|| host.hasSuffix(".workers.dev")`.
- `ios/YTLearn/Scripts/shim-dream.js`, the `API` regular expression: add `|[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev`
  (the address is `https://<worker>.<account>.workers.dev`).
- (Chrome extension, optional) `youtube-to-claude/manifest.json` `host_permissions`: `"https://*.workers.dev/*"`.
  Without it the extension's request is a CORS request from `chrome-extension://…`, which the Worker allows.

## 5. Notes

- `dream-ext/VENDOR.md`: add a line for the vendored change: `core/tts/audio.ts`: `AudioEngineOptions.ahead`
  (how many read-ahead texts a cloud voice fetches; default 2) and `label` / `costNote` (an engine not in
  ENGINE_LABELS). Off unless the YouTube side asks for it.
- The device keeps every Speechify clip (IndexedDB `dreamVoice`, store `clips`, at most 600, oldest first; the
  database version went from 1 to 2, the old sounds stay). Same voice + same text = never fetched again.
- Nothing here was run on a real iPhone or against the real Speechify API (no key here): all tests use stand-ins.
