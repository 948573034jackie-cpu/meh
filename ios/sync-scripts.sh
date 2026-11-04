#!/bin/bash
# Copies the extension's JavaScript into the iOS app (so the app and the Chrome extension run the same code).
set -e
cd "$(dirname "$0")"
SRC=../youtube-to-claude
DST=YTLearn/Scripts
WEB=YTLearn/Web/dream
cp "$SRC/lib.js" "$DST/lib.js"
cp "$SRC/youtube.js" "$DST/youtube.js"
cp "$SRC/chat.js" "$DST/chat.js"
cp "$SRC/mic-mix.js" "$DST/mic-mix.js"
# the extension's background script runs inside the YouTube page here; wrap it so its names stay private
{ echo "(function () {"; cat "$SRC/background.js"; echo "})();"; } > "$DST/background.js"
# My tutor (built by dream-ext/build.mjs): its background runs in the page too ("self" = the page's window)
{ echo "(function (self) {"; cat "$SRC/dream/dream-bg.js"; echo "})(window);"; } > "$DST/dream-bg.js"
cp "$SRC/dream/dream-yt.js" "$DST/dream-yt.js"
# the files the tutor opens by address (ytlearn://app/dream/…): the dictionary and the settings / vocabulary pages
mkdir -p "$WEB"
for f in dict.json.gz zipf.json.gz options.html options.js vocab.html vocab-page.js pages.css; do cp "$SRC/dream/$f" "$WEB/$f"; done
echo "scripts synced"
