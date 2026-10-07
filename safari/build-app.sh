#!/bin/bash
# Turns safari/Extension into an iPhone/iPad app that carries the Safari extension (Apple's own converter, needs Xcode).
#   ./safari/build-app.sh          -> makes the Xcode project and opens it (then press Run with your iPad plugged in)
#   ./safari/build-app.sh --ci     -> makes the project only (used by the GitHub build)
set -e
cd "$(dirname "$0")"
./make-extension.sh
rm -rf build && mkdir build
xcrun safari-web-extension-converter Extension --project-location build --app-name YTSafari \
  --bundle-identifier local.ytsafari.app --swift --ios-only --copy-resources --no-open --no-prompt --force
PROJ=$(find build -name '*.xcodeproj' -maxdepth 3 | head -1)
echo "Xcode project: $PROJ"
if [ "$1" != "--ci" ]; then
  echo "In Xcode: Signing & Capabilities -> choose your Apple ID team for BOTH targets (app + extension), plug in the iPad, press Run."
  open "$PROJ"
fi
