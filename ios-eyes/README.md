# Claude Eyes for iPad and iPhone

One app for iPad **and** iPhone. Two web views side by side (iPad sideways) or stacked (iPhone, iPad upright):

* **Left / top: the page you are reading** (type any web address or a search).
* **Right / bottom: your chat**: Claude (claude.ai) or ChatGPT (switch at the top). Sign in once (use *email* sign-in; "Sign in with Google" is blocked inside apps).

Tap **ON** (green dot). From then on, **when you start speaking, the app takes a picture of the page on the left and puts it into the chat's message box**: exactly like attaching a file. Then it waits (30 seconds by default; menu: 30 s / 1 min / 2 min) before it will do it again. No speech = no picture. The line under the buttons always says what happened last ("picture attached to Claude ✓" or why not).

* It listens to the **microphone only**. It changes no volume (other audio keeps playing at its own level), records nothing and sends nothing except the picture.
* Then say or type your question in the chat (the chat's own keyboard / dictation key works).

## Why an app with its own browser?
iOS does not let one app take pictures of, or put things into, another app (like the Claude app). Inside this app it can do both, so it only works for the page shown **in this app**.

## Install
Apple only lets signed apps onto a device. Pick one:

**A. With Xcode (free Apple ID, works 7 days, then press Run again)**
1. Mac App Store → install **Xcode** (version 15 recommended), open it once.
2. Download `ClaudeEyes-Xcode-project.zip` from the repository's **Releases** page, unzip, open `ios-eyes/ClaudeEyes.xcodeproj`.
3. Click *ClaudeEyes* (top left) → **Signing & Capabilities** → *Automatically manage signing* → choose your Apple ID as **Team**. If it complains about the name, change the **Bundle Identifier** to something unique, e.g. `local.claudeeyes.yourname`.
4. Plug in the iPad, unlock it, pick it at the top of Xcode, press **Run ▶**.
5. On the iPad: **Settings → General → VPN & Device Management → your Apple ID → Trust**. (If needed: Settings → Privacy & Security → **Developer Mode** → On, then restart.)

**B. Without Xcode (Sideloadly or AltStore)**: download `ClaudeEyes-unsigned.ipa` from **Releases**; install *Sideloadly* (sideloadly.io) or *AltStore* on your Mac, sign in with your Apple ID, install the .ipa. Same 7-day rule with a free Apple ID; a paid developer account (99 USD/year) lasts a year.

First start: allow the **microphone**. If you block it by accident: Settings → Claude Eyes → Microphone.

## What was tested (and what was not)
Tested automatically on every build, in a simulated iPad and iPhone (no microphone or internet needed): the speech detector (same numbers as the Mac app; unit tests), the voice-band level meter, and the full chain "speech → picture of the page → picture arrives in a chat page" with test pages, including the 30-second wait, OFF switch, "no message box" failure and retry. The attach script is also tested in WebKit (Safari's engine) and Chromium.

**Not tested (needs a real iPad + real accounts):** the real microphone, the real claude.ai / chatgpt.com pages (their message box may change; if the picture is not attached the status line says so), and whether the chat's own dictation/voice works while this app also listens to the microphone.

## Limits (honest)
* Only pages **inside this app** can be photographed (Apple's rules).
* Claude's own voice mode (Claude app) is not available here; use the chat's text box / keyboard dictation.
* "Only my voice" (speaker recognition) is **not** in the iPad app yet; it would hear the iPad's own speaker (use headphones).
* With a free Apple ID the app expires after 7 days.
