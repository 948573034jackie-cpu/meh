#!/bin/bash
# Builds the YT Learn Xcode project on YOUR Mac (private, free) and opens it in Xcode.
# Use: open Terminal, drag this file into it, press Enter.
set -e
cd "$(dirname "$0")"
echo "== YT Learn: preparing the Xcode project"
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Xcode is not installed yet. Install 'Xcode' from the Mac App Store, open it once, then run this again."
  open "macappstore://apps.apple.com/app/xcode/id497799835" || true
  exit 1
fi
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "Downloading XcodeGen (a small tool that writes the project file)..."
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/xcodegen.zip" https://github.com/yonaskolb/XcodeGen/releases/latest/download/xcodegen.zip
  unzip -q "$TMP/xcodegen.zip" -d "$TMP"
  XG="$TMP/xcodegen/bin/xcodegen"
else
  XG="$(command -v xcodegen)"
fi
./sync-scripts.sh
"$XG" generate --spec project.yml
# readable by older Xcode versions too
sed -i '' -e 's/objectVersion = [0-9]*;/objectVersion = 56;/' -e 's/preferredProjectObjectVersion = [0-9]*;/preferredProjectObjectVersion = 56;/' YTLearn.xcodeproj/project.pbxproj || true
echo "== Done. Opening Xcode..."
echo "In Xcode: click YTLearn (left) > Signing & Capabilities > Team: your Apple ID."
echo "Plug in the iPad/iPhone, choose it at the top, press Run (the play button)."
open YTLearn.xcodeproj
