#!/bin/bash
# Builds ClaudeSnap.app (macOS 12+, Intel or Apple Silicon).
set -e
cd "$(dirname "$0")"

if ! command -v swiftc >/dev/null; then
    echo "Swift is not installed. Run:  xcode-select --install   then run this script again."
    exit 1
fi

APP="ClaudeSnap.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

swiftc -O -target "$(uname -m)-apple-macos12.0" main.swift -o "$APP/Contents/MacOS/ClaudeSnap"
cp Info.plist "$APP/Contents/Info.plist"

# Ad-hoc signature (needed so macOS will remember the permissions you give).
codesign --force --deep --sign - "$APP"

echo "Done: $(pwd)/$APP"
echo "Start it with:  open \"$(pwd)/$APP\""
