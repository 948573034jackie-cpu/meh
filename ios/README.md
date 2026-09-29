# YT Learn — iPhone & iPad app

The same idea as the Chrome extension, as a real iPhone/iPad app. Inside the app there are two browser windows:

* **YouTube** (top / left) — watch any video.
* **Claude or ChatGPT** (bottom / right) — your chat. Pick which one with the switch at the top.

When you **pause** a video, the app shows the last ~25 seconds as big subtitles (complete sentences), plays that part once, and — in the last second — sends the text to your chat with one plain instruction (explain it like an English teacher, then repeat the sentences). Say **“let's go”** (or press ▶ / tap the video) to play that part again and keep going.

It runs the *same JavaScript* as the Chrome extension (`youtube-to-claude/`), so both behave the same.

## Install on your iPhone / iPad

Apple only lets apps onto a phone if they are *signed*. Nobody can skip this. Pick one way:

### Way A — with Xcode (free Apple ID, works 7 days, then reinstall)
1. On your Mac install **Xcode** (free, Mac App Store). Open it once and let it finish installing.
2. Download `YTLearn-Xcode-project.zip` from the release page, unzip it, open `ios/YTLearn.xcodeproj`.
3. Click **YTLearn** (top of the left list) → **Signing & Capabilities** → tick *Automatically manage signing* → **Team**: choose your Apple ID (add it in Xcode ▸ Settings ▸ Accounts if needed). If it complains about the name, change the **Bundle Identifier** to something unique, e.g. `local.ytlearn.yourname`.
4. Plug in your iPhone/iPad, unlock it, choose it at the top of Xcode, press **Run ▶**.
5. On the phone: **Settings ▸ General ▸ VPN & Device Management** ▸ your Apple ID ▸ **Trust**. (If you don't see "Developer Mode": **Settings ▸ Privacy & Security ▸ Developer Mode ▸ On**, restart.)
6. With a free Apple ID the app stops working after 7 days: plug in and press Run again. A paid Apple Developer account (99 USD/year) lasts a year and allows TestFlight.

### Way B — without Xcode (Sideloadly or AltStore)
1. Download `YTLearn-unsigned.ipa` from the release page.
2. Install **Sideloadly** (sideloadly.io) or **AltStore** (altstore.io) on your Mac, sign in with your Apple ID, and install the `.ipa` on your phone. They sign it for you. Same 7-day rule for free Apple IDs.

## First run
* Sign in to **Claude** or **ChatGPT** inside the app's chat window (use *email* login — “Sign in with Google” is blocked by Google inside apps).
* The first time you say “let's go”, iOS asks for the **microphone** and **speech recognition**. Allow both. (Space/▶/tap always work too.)

## Buttons (top bar)
Claude | ChatGPT switch · **Send video** (link + full transcript) · 🏠 YouTube home · 🔗 open a YouTube link you copied · ▭ change the layout (video big / medium / small) · ⚙ settings (text size 1–10, replay, voice, transcript).

## Limits (honest)
* Needs an Apple ID for signing (see above). The app is not on the App Store.
* Works with videos that have captions or YouTube's *Show transcript*.
* If Claude/ChatGPT change their web pages, the sending step may need an update.
* Use a normal text chat, not voice mode, in Claude/ChatGPT.
* iPhone: put the video in *landscape* or use the layout button (▭) for a bigger video.
