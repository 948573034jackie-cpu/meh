#!/bin/bash
# Makes the Safari version of the extension (safari/Extension) from the Chrome one (youtube-to-claude).
# Differences: Safari's "browser" API (browser-shim.js), no Chrome-only permissions (debugger, tts),
# and no voice-call mixer (Safari on iPhone/iPad cannot play the video into a call).
set -e
cd "$(dirname "$0")"
SRC=../youtube-to-claude
OUT=Extension
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R "$SRC/icons" "$OUT/"
cp browser-shim.js "$SRC/lib.js" "$SRC/youtube.js" "$SRC/chat.js" "$SRC/popup.js" "$OUT/"
cat browser-shim.js <(grep -v "dream/dream-bg.js" "$SRC/background.js") > "$OUT/background.js"
sed 's#<script src="lib.js">#<script src="browser-shim.js"></script><script src="lib.js">#' "$SRC/popup.html" > "$OUT/popup.html"
sed -i "/dream-settings/d" "$OUT/popup.html"
grep -q "browser-shim.js" "$OUT/popup.html" || { echo "popup.html: could not add browser-shim.js"; exit 1; }
python3 - "$SRC/manifest.json" "$OUT/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
m['permissions'] = [p for p in m['permissions'] if p not in ('debugger', 'tts')]
m.pop('web_accessible_resources', None); m.pop('options_page', None)
m['host_permissions'] = [h for h in m['host_permissions'] if 'api.' not in h]
cs = []
for c in m['content_scripts']:
    if c.get('world') == 'MAIN':
        continue  # the voice-call mixer: not on Safari
    c['js'] = ['browser-shim.js'] + [j for j in c['js'] if not j.startswith('dream/')]  # the Dream Tutor is Chrome only for now
    cs.append(c)
m['content_scripts'] = cs
m['description'] = 'Safari (iPhone/iPad): YouTube English: send the video and the part you paused at to Claude / ChatGPT, with subtitles, replay and your voice.'
json.dump(m, open(sys.argv[2], 'w'), indent=2)
PY
echo "Safari extension made in safari/$OUT (version $(python3 -c "import json;print(json.load(open('$OUT/manifest.json'))['version'])"))"
