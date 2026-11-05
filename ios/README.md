# YT Learn — iPhone & iPad app

Your own app: YouTube inside it (search, your account, any video), with **My tutor**, the same AI English teacher as the
Chrome extension, with your own API key. Version 1.1: the tutor is the only mode (the Claude / ChatGPT chat window was
removed).

## What you see
* YouTube, as it is (no bar at the top). My tutor's panel sits under the video; its big reading page covers the screen
  at stops.
* One bar, at the bottom. Five small buttons are always in view: **Tutor ● on / ○ off** · ⏯ **Play / stop** ·
  **Explain 20 s** (the last 20 seconds; the number is the part length you chose in the tutor's settings) ·
  **Sentence** (explain the last sentence) · 📞 **Call** (talk with the tutor).
* Swipe the bar sideways for the rest: 🎙 Voice · 🌙 Sleep (off → 30 min → 60 min) · 📒 Words · Settings (the tutor's
  quick settings), and at the end the app's own three: **Home** (YouTube's home page) · **Paste link** (open a copied
  YouTube link) · **App settings** (all settings, the vocabulary file).
* With the tutor off the bar shows only **Tutor ○ off**, Home, Paste link and App settings.

## First run
1. Open a video. Swipe the bottom bar to its end → **App settings** → **All settings** → **API keys**: your Claude key →
   Save → Test. (Optional: a Microsoft key for the free natural voice.)
2. **Allow** Microphone and Speech Recognition when iOS asks (for I know / I don't know, questions, the call, voice mode).
   The tutor takes what you say after a short pause (about one second): say “I know”, then wait. If it does not hear
   you well: **Settings** in the bar → **Microphone** → High (Low / Mid / High).
3. The **Level Check** screen comes before each video: tap the words you know, or skip it. Then the video is analyzed
   once and plays in Listening mode (stops at the hardest sentences, 50 % at most).
4. **Better iPhone voice:** iOS Settings → Accessibility → Spoken Content → Voices → English → download a *Premium* or
   *Enhanced* voice; the tutor picks it.

## One vocabulary file for the Mac and the phone
* On the Mac, Chrome writes `vocabulary.json` in Documents ▸ MEH English, in **iCloud Drive ▸ MEH English**, and in
  Google Drive ▸ MEH English (when Google Drive for desktop is installed).
* On the phone: **App settings** (the last button of the bottom bar) **→ Choose the folder** → pick that **MEH
  English** folder in iCloud Drive (or Google Drive) in the Files app. From then on both devices read and write the same file: each one's words
  are merged in, nothing is lost (the newest status of a word wins).
* Without a folder, the words stay in the app (Files ▸ On My iPhone ▸ YT Learn ▸ vocabulary.json). **Copy my level for
  Claude** (⚙ on the page) always works.

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


## If the video says "Sign in to confirm you're not a bot"
YouTube sometimes asks this on some internet connections. Sign in to YouTube inside the app (**Home** in the bottom bar, then your
account), or try another connection.

## Limits (honest)
* Needs an Apple ID for signing (see above). The app is not on the App Store. With a free Apple ID: reinstall every 7 days.
* Works with videos that have captions or YouTube's *Show transcript*.
* How it is built: `My-tutor-iPhone-build-guide.md` (section 7). The app runs the same `youtube-to-claude/dream/` files
  as Chrome (`./sync-scripts.sh` copies them in). The app's own JavaScript is in `YTLearn/Scripts/` (the shims that make
  `chrome.*` work inside the app) and `YTLearn/Web/` (the tutor's pages and dictionary).
