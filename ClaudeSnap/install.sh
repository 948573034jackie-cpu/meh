#!/bin/bash
# One-step installer for ClaudeSnap: build → copy to /Applications → open → open the permission pages.
set -e
cd "$(dirname "$0")"

echo "== ClaudeSnap installer =="

# 1. Build tools
if ! command -v swiftc >/dev/null 2>&1; then
    echo
    echo "Swift build tools are missing. A window will ask to install them (about 5-10 minutes)."
    echo "When it finishes, run this same installer command again."
    xcode-select --install || true
    exit 1
fi

# 2. Build
./build.sh

# 3. Install (stop an old copy first)
pkill -x ClaudeSnap 2>/dev/null || true
rm -rf /Applications/ClaudeSnap.app
cp -R ClaudeSnap.app /Applications/ClaudeSnap.app
xattr -dr com.apple.quarantine /Applications/ClaudeSnap.app 2>/dev/null || true

# 4. Forget old permission answers for a clean start
tccutil reset ScreenCapture local.claudesnap >/dev/null 2>&1 || true
tccutil reset Accessibility local.claudesnap >/dev/null 2>&1 || true
tccutil reset Microphone   local.claudesnap >/dev/null 2>&1 || true

# 5. Start the app (it asks for each permission when you press Open)
open /Applications/ClaudeSnap.app
sleep 1

cat <<'EOF'

Installed: /Applications/ClaudeSnap.app  (small panel, top-right of the screen)

Next, 3 permission pages will open. In each one:
  - click the lock (bottom-left) and type your Mac password,
  - press "+", choose  Applications > ClaudeSnap  (or tick it if it is already in the list),
  - Screen Recording only: click "Quit & Reopen" / then reopen ClaudeSnap.
EOF

open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
read -r -p "Press Enter after Screen Recording is done... " _
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
read -r -p "Press Enter after Accessibility is done... " _
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
read -r -p "Press Enter after Microphone is done... " _

pkill -x ClaudeSnap 2>/dev/null || true
sleep 1
open /Applications/ClaudeSnap.app
echo
echo "All set. Press Open on the panel, then speak."
