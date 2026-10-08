# ClaudeSnap

A tiny macOS app (macOS 12 Monterey or newer). A small panel sits at the top-right of your screen with two buttons: **Open** and **Quit**.

After you press **Open**, each time you start speaking the app will:

1. Take a screenshot of your screen (without its own panel).
2. Switch to the **Claude desktop app** and paste the picture.
3. Switch **back** to the app you were reading or studying.

Your voice itself goes to Claude through Claude's own voice mode — this app only listens to know *when* you start talking.

## Install

1. Open **Terminal** and install the build tools once (skip if you already have them):
   ```
   xcode-select --install
   ```
2. Build the app:
   ```
   cd ClaudeSnap
   ./build.sh
   ```
3. Start it:
   ```
   open ClaudeSnap.app
   ```

## First time: 3 permissions

Press **Open**. macOS will ask for these, one by one (System Preferences → Security & Privacy → Privacy):

| Permission | Why |
|---|---|
| Screen Recording | to take the screenshot |
| Accessibility | to press Cmd+V in the Claude app |
| Microphone | to hear when you speak |

After you allow one, **quit and reopen ClaudeSnap**, then press **Open** again. (If you rebuild the app, macOS may ask again.)

## How to use

1. Open the Claude desktop app and start a voice conversation.
2. Start ClaudeSnap and press **Open**. The green bar shows your microphone level.
3. Read or study as normal. When you speak, the screen is sent to Claude and you return to your page.

## Ignoring Claude's voice

The app only reacts to sound that is clearly louder than the room. **Wear headphones** — then Claude's voice can never reach the microphone, and only your voice triggers a screenshot. With laptop speakers, Claude's voice can leak into the mic; raise the sensitivity number so only your (closer, louder) voice counts:

```
defaults write local.claudesnap sensitivity -float 5
```

(default is 3; higher = needs a louder voice). Restart the app after changing it.

The picture is pasted in the first moment you speak (about half a second), so it travels together with your voice. Return is **not** pressed by default, because that would send the picture as a separate message. Only if pasting alone does not attach the picture to your voice turn, try:

```
defaults write local.claudesnap pressReturn -bool true
```

## Notes

- Only the main screen is captured.
- Two screenshots are at least 4 seconds apart, and a new one needs a short pause in your speech first.
- If the Claude app is not running, the panel says "Open Claude app first".
