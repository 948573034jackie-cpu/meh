#!/bin/sh
# Builds the Intel Mac app on Linux/Mac: electron-builder -> keep only English -> ad-hoc sign -> zip.
# Needs `rcodesign` (github.com/indygreg/apple-platform-rs) on PATH or in $RCODESIGN when not on a Mac.
set -e
cd "$(dirname "$0")/.."
rm -rf dist
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac zip --x64 -c.mac.identity=null --publish never
APP="dist/mac/Claude Eyes.app"
# the app only speaks English: drop the ~50 other language packs (saves ~35 MB)
find "$APP" -name "*.lproj" ! -name "en.lproj" ! -name "Base.lproj" -prune -exec rm -rf {} +
if [ "$(uname)" = "Darwin" ]; then codesign --force --deep -s - "$APP"; else "${RCODESIGN:-rcodesign}" sign "$APP"; fi
mkdir -p downloads
rm -f downloads/Claude-Eyes-Mac-Intel.zip
(cd dist/mac && zip -qry9 "../../downloads/Claude-Eyes-Mac-Intel.zip" "Claude Eyes.app")
ls -l downloads/Claude-Eyes-Mac-Intel.zip
