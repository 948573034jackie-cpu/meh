#!/bin/bash
# Makes the Safari version of the extension (safari/Extension) from the Chrome one (youtube-to-claude), with My tutor.
# Differences: Safari's "browser" API (browser-shim.js), no Chrome-only permissions (nativeMessaging), m.youtube.com too (the iPhone's YouTube), and
# My tutor's buttons at the bottom of the page (tutor-bar.js: there is no keyboard on the phone).
set -e
cd "$(dirname "$0")"
SRC=../youtube-to-claude
OUT=Extension
test -f "$SRC/dream/dream-yt.js" -a -f "$SRC/dream/dream-bg.js" || { echo "My tutor is not built: run (cd dream-ext && npm run build) first"; exit 1; }
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R "$SRC/icons" "$SRC/dream" "$OUT/"
cp browser-shim.js tutor-bar.js "$SRC/lib.js" "$SRC/youtube.js" "$SRC/popup.js" "$OUT/"
# (the background loads My tutor's background, dream/dream-bg.js, itself)
cat browser-shim.js "$SRC/background.js" > "$OUT/background.js"
# (one sed with no -i: the same on macOS and Linux)
sed -e 's#<script src="lib.js">#<script src="browser-shim.js"></script><script src="lib.js">#' "$SRC/popup.html" > "$OUT/popup.html"
grep -q "browser-shim.js" "$OUT/popup.html" || { echo "popup.html: could not add browser-shim.js"; exit 1; }
for f in options.html vocab.html reader.html; do
  sed -e 's#<script#<script src="../browser-shim.js"></script><script#' "$SRC/dream/$f" > "$OUT/dream/$f"
  grep -q "browser-shim.js" "$OUT/dream/$f" || { echo "dream/$f: could not add browser-shim.js"; exit 1; }
done
python3 - "$SRC/manifest.json" "$OUT/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
YT = ['https://www.youtube.com/*', 'https://m.youtube.com/*']
m['permissions'] = [p for p in m['permissions'] if p not in ('debugger', 'tts', 'nativeMessaging')]
m['host_permissions'] = list(dict.fromkeys(m['host_permissions'][:1] + YT[1:] + m['host_permissions'][1:]))
cs = []
for c in m['content_scripts']:
    if 'https://www.youtube.com/*' in c['matches']:
        c['matches'] = YT
        c['js'] = c['js'] + ['tutor-bar.js']
    c['js'] = ['browser-shim.js'] + c['js']
    cs.append(c)
m['content_scripts'] = cs
for w in m.get('web_accessible_resources', []):
    w['matches'] = YT
m['browser_specific_settings'] = {'safari': {'strict_min_version': '16.4'}}  # My tutor needs Safari 16.4 (iOS 16.4)
m['description'] = 'Safari (iPhone/iPad): My tutor, your own AI English teacher on YouTube (your own API key): a Level Check, stops at what is hard for you, explanations with a voice, Chinese.'
json.dump(m, open(sys.argv[2], 'w'), indent=2)
PY
echo "Safari extension made in safari/$OUT (version $(python3 -c "import json;print(json.load(open('$OUT/manifest.json'))['version'])"))"
