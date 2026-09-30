#!/bin/sh
# The "attach the picture to the chat" script is shared with the Chrome extension (and tested there):
# copy it into the app. Run before building; CI does it too.
cd "$(dirname "$0")" || exit 1
cp ../extension/attach.js ClaudeEyes/Resources/attach.js
echo "copied attach.js"
