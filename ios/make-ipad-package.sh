#!/bin/bash
# Makes "YT Learn.swiftpm": the same app as a Swift Playgrounds project, so it can be built and run
# on the iPad itself (free, private, no Mac, no 7-day limit).
set -e
cd "$(dirname "$0")"
./sync-scripts.sh >/dev/null
OUT=../downloads/pkg
PKG="$OUT/YT Learn.swiftpm"
rm -rf "$OUT"; mkdir -p "$PKG/Resources"
cp YTLearn/*.swift "$PKG/"
cp YTLearn/Scripts/*.js "$PKG/Resources/"
cat > "$PKG/Package.swift" <<'SWIFT'
// swift-tools-version: 5.8
// Swift Playgrounds app project (iPad / Mac). Open this folder in Swift Playgrounds and tap Run.
import PackageDescription
import AppleProductTypes

let package = Package(
    name: "YT Learn",
    platforms: [
        .iOS("16.0")
    ],
    products: [
        .iOSApplication(
            name: "YT Learn",
            targets: ["AppModule"],
            bundleIdentifier: "local.ytlearn.playgrounds",
            displayVersion: "3.0",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .play),
            accentColor: .presetColor(.blue),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad]))
            ],
            capabilities: [
                .microphone(purposeString: "The microphone hears your voice commands (\"hi bro\", \"shut up\") and your questions for the AI."),
                .speechRecognition(purposeString: "Speech recognition turns your voice commands and questions into text.")
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: ".",
            resources: [
                .process("Resources")
            ]
        )
    ]
)
SWIFT
(cd "$OUT" && rm -f ../YTLearn-iPad.zip && zip -qr ../YTLearn-iPad.zip "YT Learn.swiftpm")
rm -rf "$OUT"
echo "made downloads/YTLearn-iPad.zip"
