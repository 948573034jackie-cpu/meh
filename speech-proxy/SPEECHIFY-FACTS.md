# Speechify and Cloudflare: the facts the speech proxy is built on

Checked on **26 Nov 2026** on the official pages (links below). Where pages disagree, it says so.

## Speechify text to speech API

The docs moved: `docs.sws.speechify.com` now redirects (301) to **docs.speechify.ai**. The API address is
**https://api.speechify.ai** (the old `api.sws.speechify.com` is the previous domain, see the changelog).

### Make a clip: `POST https://api.speechify.ai/v1/audio/speech`
Source: https://docs.speechify.ai/v1/api-reference/api-reference/tts/audio/speech

- Auth: header `Authorization: Bearer <API key>`. One key per account.
- Body (JSON):
  - `input` (required): plain text or SSML. **At most 2,000 billable characters** per request (20,000 with markup).
  - `voice_id` (required): from `GET /v1/voices`.
  - `audio_format`: `wav` (default!), `mp3`, `ogg`, `aac`, `pcm`. The docs say to always set it. The Worker sends `mp3`.
  - `model`: `simba-3.0` (default), `simba-3.2` (English only), `simba-3.5` (recommended, 48 languages).
    `simba-english` and `simba-multilingual` are retired (`400 model_retired`).
  - `language`: like `en-US`; only needed when the text is not in the voice's own language. The Worker sends
    `zh-CN` for the Chinese meanings only.
  - `options`: `loudness_normalization` (default false), `text_normalization` (default true).
  - `output_format` (optional, e.g. `mp3_24000_…`): overrides `audio_format`. Not sent unless the var OUTPUT_FORMAT is set.
  - also `pronunciations` (up to 200) and `safety_identifier`.
- Answer (JSON): `audio_data` (**base64**), `audio_format`, `billable_characters_count`, `speech_marks`
  (`chunks` with `type`, `start`, `end`, `start_time`, `end_time`, `value`).
  - The docs do **not** say if `start_time` / `end_time` are milliseconds or seconds, nor if `end` is inclusive. The
    Worker works it out (more than 1 time unit per character = ms; it checks `value` against the text) and sends the
    apps word times in seconds. **Check this with the first real answer** (a wrong guess only moves the word line).
- Errors: 400, 401, 402 (no credit), 403, 404, 409, 413, 429, 500, 502, 503. Body:
  `{ "error": { "code", "message", "fields"? }, "request_id" }`. Match on `code`, not on `message`.

### Streaming: `POST https://api.speechify.ai/v1/audio/stream`
Source: https://docs.speechify.ai/v1/api-reference/api-reference/tts/audio/stream

Raw audio bytes (chunked), `Accept: audio/mpeg|ogg|aac|pcm`, up to 20,000 billed characters, **no speech marks**.
Not used: the apps play whole sentences / paragraphs and use the word times for the line under the spoken word.

### Voices: `GET https://api.speechify.ai/v1/voices`
Source: https://docs.speechify.ai/v1/api-reference/api-reference/tts/voices/list

- Query: `cursor`, `limit` (default 50, max 200), `type` (`personal` / `shared`), `locale` (prefix match: `en`
  matches `en-GB` and `en-US`), `gender`, `model`.
- Answer: `{ "voices": [...], "next_cursor": string|null, "has_more": bool }` (follow `next_cursor` while
  `has_more`; a short page does not mean the end).
- One voice: `id`, `display_name`, `locale` (e.g. `en-GB`), `gender` (`male` / `female` / `not_specified`),
  `tags` (list of strings, no fixed list in the docs), `type` (`shared` / `personal` = someone's own clone),
  `models: [{ name, languages: [{ locale, preview_audio }] }]`, `preview_audio`, `avatar_image`, and
  `staff_pick_rank` (1 = the voice Speechify recommends first for that locale; missing for the others).
- So "the most natural British voice" = `locale` en-GB, `type` shared, lowest `staff_pick_rank`. The Worker picks it
  that way (then tags like "natural / conversational / audiobook", then the model).
- Popular built-in voices named in the docs: george, henry, carly, sabrina (accents not stated).

### Rate limits (per account, all speech endpoints together)
Source: https://docs.speechify.ai/build/guides/concepts/api-limits.md ("As of 30 Sep 2026")

| Plan | At once | Per second | Burst |
|---|---|---|---|
| Free | 3 | 1 | 10 |
| Starter | 15 | 20 | 60 |
| Pro | 30 | 40 | 120 |

Over the limit: `429` with `Retry-After`, `error.code` `rate_limited` or `concurrency_limit_reached`.
(The changelog of 24 Dec 2025 said "20 per second for paid users"; older docs said 200 a minute. The table of
30 Sep 2026 is the newest.) The apps send about one request per sentence, well under 1 a second.

### Price and the free amount
Official pricing page: https://speechify.ai/pricing (no date on the page; read 26 Nov 2026). Also https://speechify.ai/api.

| Plan | Per month | Included | Extra, per 1 million characters |
|---|---|---|---|
| Free | $0 | **500,000 characters of Simba 3.0 / 3.2, or 333,000 of Simba 3.5** | cannot top up: refused until next month |
| Starter | $10 | 2,000,000 (3.0 / 3.2) or 1,300,000 (3.5) | $10 (3.0 / 3.2), $15 (3.5) |
| Pro | $99 | 13,600,000 (3.0 / 3.2) or 9,000,000 (3.5) | $8 / $12 |
| Scale | $499 | 99,800,000 or 59,800,000 | $6 / $10 |

- Billing: spaces between words count; spaces at the start and end do not; SSML tags do not.
- **The pages disagree:** some third-party pages say the free plan is 50,000 characters, and one says the Simba 3.5
  prices were a "launch price until 21 Nov 2026". Speechify's own pricing page (above) says 500,000 / 333,000 free.
  Trust the numbers in your Speechify dashboard (https://platform.speechify.ai) after you make the account.
- What this means here: 20,000 characters a day x 30 days = 600,000 a month. On the free plan with Simba 3.5 that is
  more than the 333,000 free characters: the free balance would end after about 16 days, and then Speechify says 402
  and the apps use the iPhone voice. For the free plan with Simba 3.5, a daily limit of **11,000** fits the month.
- About 54,000 characters = 1 hour of speech.

## Cloudflare Workers (free plan)

Sources: https://developers.cloudflare.com/workers/platform/limits/ , https://developers.cloudflare.com/durable-objects/platform/pricing/ ,
https://developers.cloudflare.com/workers/runtime-apis/cache/ (read 26 Nov 2026)

- 100,000 requests a day (resets at midnight UTC), **10 ms CPU** per request (waiting for Speechify does not count),
  50 subrequests per request, 128 MB memory.
- **The counter: one Durable Object with SQLite storage** (on the free plan since April 2025; SQLite-backed only).
  Free plan, about: 100,000 Durable Object requests a day, 5 million rows read and 100,000 rows written a day, 5 GB.
  A paid clip is 3 counter requests (reserve, settle, and /usage when the app shows the count) and about 3 row
  writes; a cached clip is none. 20,000 characters a day in sentences of about 100 characters = about 200 clips =
  about 600 writes a day: far under the limit.
  A Durable Object runs one request at a time and its SQLite is synchronous, so "is there room?" and "take the
  characters" are one step: two requests at the same moment can never both pass DAILY_CHAR_LIMIT. The characters
  are reserved before Speechify is called, then changed to what Speechify billed (or given back when it failed).
- **Cache API (the clips):** keeps GET keys only (the Worker uses a made-up GET address per clip), per data centre
  (not shared world-wide), `Cache-Control` decides how long. **Not sure:** older Cloudflare pages say the Cache API
  does nothing on `*.workers.dev` addresses (only on your own domain); newer pages name only the dashboard editor and
  previews. The Worker works either way; if the Worker cache does nothing, the clips are still kept on each iPhone
  (the apps never ask twice for the same text), so only "the same text in the OTHER app" would be paid again.
  Test: say the same sentence in both apps, then open `/usage`: the second time must add 0.

## Other notes

- "Only my apps": the app code is a shared secret; anyone who reads it from a phone could use it. The daily limit caps
  the cost of a leaked code. The strongest lock (Apple App Attest) needs a real App Store / TestFlight setup; later.
- The Worker sends no Speechify key to the apps and never writes it in a file; `wrangler secret put` stores it
  encrypted at Cloudflare.
