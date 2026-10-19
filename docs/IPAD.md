# Dream Read on iPad (web app)

The iPad version is the same app, built for Safari: the reader, Listening mode, the word card, My Vocabulary,
Progress, the level test and Settings are the exact screens of the Mac app (`src/renderer`). Only the layer
underneath is different: instead of the Mac app's background process, a small browser layer (`src/web`) keeps
your books and settings in Safari's storage and talks to the AI and voice services directly.

Add it to the home screen and it opens full screen like an app, with its own icon, and works offline for
reading (AI explanations and cloud voices need the internet, as on the Mac).

## 1. Build

```sh
npm install            # once
node scripts/build-web.mjs
```

Everything lands in `dist/web/` (a plain folder of static files, about 5 MB, most of it the dictionary and the
PDF reader, which only loads when you open a PDF). `node scripts/build-web.mjs --watch` rebuilds on every change.

Smoke test (Chromium, iPad-sized touch screen): `npx playwright test -c test/web/playwright.config.ts`.

## 2. Host it

Any static web host works; it must serve the files as they are (no server code is needed).
**Use HTTPS** if you can: Safari only allows offline use, "works without internet" caching and secure IDs on
HTTPS (or on `localhost`).

**GitHub Pages (free, HTTPS, recommended).** Push the contents of `dist/web/` to a `gh-pages` branch (or a
`docs/` folder) of a repository and turn on Pages in the repository settings. The app works from a sub-path
(`https://you.github.io/dream-read/`) because every file is referenced relatively. Netlify, Cloudflare Pages
and Vercel work the same way: drag the `dist/web` folder onto their "deploy" page.

**Your Mac, on the same Wi-Fi (quick test).**

```sh
cd dist/web && python3 -m http.server 8080
```

then on the iPad open `http://<your-mac-name>.local:8080/` (System Settings → General → Sharing shows the
name). Reading, listening and AI work, but over plain `http` Safari will not cache the app for offline use.
For HTTPS on the local network you can use a tool such as `caddy file-server --listen :8443` with an internal
certificate, or a tunnel (Tailscale Funnel, cloudflared).

Updating: build again and upload again. The service worker has a new version number on every build, so the
iPad picks the new version up the next time the app is opened while online (sometimes it takes a second
launch).

## 3. Add to the home screen

1. Open the address in **Safari** on the iPad (other browsers on iPad cannot add web apps on older iPadOS).
2. Tap the **Share** button (square with an arrow), then **Add to Home Screen**, then **Add**.
3. Open **Dream Read** from the home screen. The first launch downloads the dictionary (2.2 MB); after that the
   app starts offline.

Requires iPadOS 16.4 or newer (the dictionary is unpacked with a browser feature that arrived in 16.4).
A hint about step 2 appears once at the bottom of the screen when you open the site in Safari.

Your books and settings stay when you update the app. Safari keeps the storage of home-screen apps; it can
delete the data of a site that is only used in a Safari tab and not opened for several weeks, so use the
home-screen icon.

## 4. What works and what does not

| | Mac app | iPad web app |
|---|---|---|
| EPUB, PDF, text files | Open… / drag and drop | **Open a book…** shows the Files picker (iCloud Drive, On My iPad, other apps); dropping a file from the Files app in Split View should also work |
| Pasted text | yes | yes |
| Reading and Listening modes, word card, hints, My Vocabulary, Progress, level test | yes | yes (same screens) |
| Built-in voices | Mac voices | the iPad's own voices (Settings → Accessibility → Spoken Content → Voices to download Enhanced / Premium ones) |
| **Dream voice (Kokoro, free, local)** | yes | **no**: it needs the Mac's neural engine runtime; the iPad voices are used instead |
| Microsoft Edge neural voices (free) | yes | **no** (the free service cannot be reached from a web page) |
| OpenAI and ElevenLabs voices (your key) | yes | yes, called directly from the iPad |
| AI explanations (Claude or OpenAI, your key) | yes | yes, called directly from the iPad, same prompts, styles, cost meter and monthly budget |
| Chapter hints (Chinese under hard words) | yes | yes, same cache rules, stored on the iPad |
| **Asking by voice (local speech recognition)** | yes | **no**: the speech model runs only on the Mac; **the typed question box still works**, and the iPad keyboard's dictation (microphone key) can fill it |
| Vocabulary CSV | written to Documents/Dream Read automatically | **Export** opens the share sheet (Save to Files, AirDrop, Mail) |
| Keyboard shortcuts | yes | yes with a hardware keyboard (Magic Keyboard, Smart Keyboard) |
| Menu bar | yes | no (every action has a button) |
| Offline | yes | yes after the first visit, over HTTPS |

### API keys on the iPad

The Mac app encrypts your keys in its data folder. A web page has nowhere to hide an encryption key from its
own code, so **on the iPad the keys are stored unencrypted in Safari's storage for this site** (IndexedDB).
They are sent only to the service they belong to (Anthropic, OpenAI, ElevenLabs), directly from the iPad;
there is no Dream Read server in between. Anyone who can unlock the iPad and open the app could find them, as
could any script running on the same web address, so:

- host the app on an address that serves nothing else (a GitHub Pages repository of its own, for example);
- set a monthly spend limit in your Anthropic / OpenAI account (and the app's own monthly AI budget);
- to remove a key, clear it in Settings, or delete the website data (Settings app → Apps → Safari → Advanced →
  Website Data).

Anthropic only answers a browser when the request says so explicitly (the
`anthropic-dangerous-direct-browser-access` header); the app sets it because the key is your own.

### Storage

Everything lives in one IndexedDB database called `dream-read` on the site's address: settings, word
statuses, My Vocabulary, the library list, the books (already split into sentences), AI usage, chapter-hint
caches and the keys. A different address (for example moving from the Mac on Wi-Fi to GitHub Pages) is a
different, empty library. Settings → Diagnostics shows how much space it uses.

## 5. Syncing with the Mac app (later)

Nothing is synced today; the iPad and the Mac have separate libraries. The data was laid out so that syncing
can be added without migrating anything:

- **Same ids.** A book's id is the first 24 hex digits of the SHA-256 of the file (or pasted text) on both
  platforms, so the same EPUB is the same book on both, and reading positions (`chapter.paragraph.sentence`)
  mean the same thing because both use the same importers and segmenter.
- **Same shapes.** Settings, `vocab` (word statuses), `vocabulary` (My Vocabulary), `library`, `usage` and
  `hints/<bookId>` hold exactly the JSON the Mac app writes to `<userData>/data/*.json`.

Possible routes, simplest first:

1. **Export / import file**: a "Backup" button that writes one JSON file (settings, vocabulary, statuses,
   library positions; books optional) and an "Import backup" that merges it, moved through iCloud Drive or
   AirDrop. Merge rules already exist in `mergeEntry` (keep the first sentence, latest explanation, add up the
   counts) and positions can keep the most recent `lastOpenedAt`.
2. **iCloud Drive folder**: the Mac app mirrors that backup file into iCloud Drive automatically; the iPad app
   opens it with the Files picker when you tap "Sync".
3. **The Mac as a sync server on the Wi-Fi**: the Mac app serves the web app *and* a small `/sync` endpoint
   from its own data folder, so the iPad pulls and pushes changes whenever both are at home (no cloud account,
   but only on the same network).
4. **A real sync service** (CloudKit JS, Supabase, or a tiny server) keyed by an account, merging per record
   with timestamps. Most work, but works anywhere.

Books themselves are large; syncing positions and vocabulary while re-importing the same file on each device
(same id) is enough for most people.

## 6. How it is built (for developers)

- `scripts/build-web.mjs` bundles `src/web/main.ts` with esbuild (ESM, code splitting, Safari 16.4 target)
  into `dist/web`, copies `web/` (index.html, manifest, icons), `resources/dict/dict.json.gz` and pdf.js's
  worker, then writes `sw.js` with the list of files and a content-hash version.
- `src/web/main.ts` imports `src/web/install.ts` first, which sets `window.readalong` to the browser
  implementation (`src/web/api.ts`), then imports the unchanged renderer (`src/renderer/main.tsx`), then
  `src/web/web.css` (safe areas, 44 pt touch targets, no hover-only controls).
- `src/web/api.ts` implements every `ReadAlongApi` method. It is wrapped in a Proxy: a method added to the
  interface later and not yet implemented for the web resolves to `undefined` (subscriptions `on…` return an
  unsubscribe function) and logs one warning, instead of crashing the page. Optional methods the renderer
  feature-detects must instead stay absent: the local speech-recognition ones (`stt*`, `onStt*`) are, so the
  renderer shows its "type your question" fallback. A new optional, feature-detected method needs the same
  treatment (add it to `ABSENT_OPTIONAL` in `src/web/api.ts`) or a real implementation.
- Node-only imports of the shared importers are replaced at build time: `node:path` by `src/web/shims/path.ts`,
  pdf.js's legacy build by `src/web/shims/pdfjs.mjs` (same module, with its worker URL set).
- Typecheck: `npx tsc --noEmit -p tsconfig.web.json` (DOM types only, no Node types).
- Icons in `web/icons` were resized from `build/icon.png` with Python PIL (180 px, 192 px, 512 px, a 512 px
  maskable icon and `apple-touch-icon.png`, the 180 px ones flattened onto the night background because iOS
  fills transparency with black).
