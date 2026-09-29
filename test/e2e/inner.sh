#!/bin/sh
# Runs inside the virtual screen: window manager + the Electron test; ends Electron as soon as it has a verdict.
OB=""
if command -v openbox >/dev/null 2>&1; then openbox >/dev/null 2>&1 & OB=$!; sleep 1; fi
node_modules/.bin/electron test/e2e/run.js --no-sandbox --disable-gpu &
EP=$!
i=0
while [ ! -f test/e2e/out/result ] && kill -0 "$EP" 2>/dev/null && [ "$i" -lt 2000 ]; do sleep 0.2; i=$((i+1)); done
sleep 1
pkill -9 -f "[e]lectron/dist/electron" 2>/dev/null
kill -9 "$EP" 2>/dev/null
[ -n "$OB" ] && kill "$OB" 2>/dev/null
exit 0
