#!/bin/bash
# Copies the extension's JavaScript into the iOS app (so the app and the Chrome extension run the same code).
set -e
cd "$(dirname "$0")"
SRC=../youtube-to-claude
DST=YTLearn/Scripts
cp "$SRC/lib.js" "$DST/lib.js"
cp "$SRC/youtube.js" "$DST/youtube.js"
cp "$SRC/chat.js" "$DST/chat.js"
cp "$SRC/mic-mix.js" "$DST/mic-mix.js"
# the extension's background script runs inside the YouTube page here; wrap it so its names stay private
{ echo "(function () {"; cat "$SRC/background.js"; echo "})();"; } > "$DST/background.js"
echo "scripts synced"
