# ReadAlong – install and first use (10 minutes)

## 1. Which zip?
- Apple menu → About This Mac.
- "Chip: Apple M1 / M2 / M3 / M4" → use **ReadAlong-0.1.0-arm64-mac.zip**
- "Processor: Intel …" → use **ReadAlong-0.1.0-mac.zip**
- macOS 13 Ventura or newer is required.

## 2. Install (the app is not Apple-signed, so this needs two Terminal commands once)
1. Double-click the zip to unzip it. Drag **ReadAlong.app** into **Applications**.
2. Open **Terminal** (Launchpad → search "Terminal"). Paste this one line and press Return:

   xattr -cr /Applications/ReadAlong.app && codesign --force --deep --sign - /Applications/ReadAlong.app

3. Open ReadAlong from Applications (or Launchpad).
   If macOS still complains: System Settings → Privacy & Security → scroll down → **Open Anyway**.

## 3. Better British voice (free, 2 minutes)
System Settings → Accessibility → Spoken Content → System Voice → **Manage Voices…** → English (UK) →
download **Daniel (Enhanced)**, **Serena (Premium)** or **Jamie (Premium)**.
Then in ReadAlong: Settings → Voice & speed → pick the voice → Preview.
Optional: "Microsoft neural voices" (Sonia, Ryan) are free too, need internet, no key.

## 4. Claude API key (the only thing that costs money, about 50 cents a month on Haiku)
1. In your browser open https://platform.claude.com and sign up (Google or email). This is separate from claude.ai; the same email is fine. You will be asked to verify a mobile phone number by SMS.
2. Settings → Billing → **Buy credits** → 5 dollars with a credit or debit card.
   On the same page set a **Spend limit** (for example 5 dollars a month) so it can never run away.
3. **API keys** → **Create key** → name it "ReadAlong" → copy the key (it is shown only once).
4. In ReadAlong: Settings → AI explanations → choose the Claude model → paste the key → **Save key** → **Test**.
Note: Anthropic does not accept mainland China, Hong Kong or Macau phone numbers or billing addresses.

## 5. Read
- Library → "Open EPUB / PDF / text…" or drag a file onto the window, or "Paste text…".
- Space = play/pause. Tap any word for pronunciation and Chinese meaning. Double-click a highlighted word = known.
- Q = listening mode: hard words are explained automatically; any key interrupts. Shift+E = explain the last 30 seconds.
- Settings → Level & stops: your level (B2 by default), how often it stops, how many times words and sentences are repeated.

## If something does not work
View → Diagnostics → **Test speech voice** → **Copy all**, and paste the text back to me.
