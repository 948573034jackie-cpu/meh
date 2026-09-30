#!/bin/bash
# Usage: selftest.sh "<simulator name fragment>" <screenshot path>
# Starts that simulator, installs the freshly built app, runs it with -selftest (no microphone,
# no internet: it uses built-in test pages), waits for its report and fails if any check failed.
set -u
KIND="$1"; SHOT="$2"
APP="build-sim/Build/Products/Debug-iphonesimulator/ClaudeEyes.app"
test -d "$APP" || { echo "app not built: $APP"; exit 1; }
UDID=$(xcrun simctl list devices available | grep -F "$KIND" | head -1 | grep -oE "[0-9A-F-]{36}")
echo "=========== simulator for '$KIND': $UDID"
if [ -z "$UDID" ]; then echo "NO SIMULATOR FOUND for $KIND"; xcrun simctl list devices available; exit 1; fi
xcrun simctl list devices available | grep "$UDID"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" local.claudeeyes.app -selftest
DATA=$(xcrun simctl get_app_container "$UDID" local.claudeeyes.app data)
REPORT="$DATA/Documents/selftest.json"
for i in $(seq 1 90); do
  if [ -f "$REPORT" ] && python3 -c "import json,sys; sys.exit(0 if json.load(open('$REPORT')).get('done') else 1)" 2>/dev/null; then break; fi
  sleep 2
done
sleep 1
xcrun simctl io "$UDID" screenshot "$SHOT" || true
echo "----- self-test report ($KIND) -----"
cat "$REPORT" 2>/dev/null || echo "NO REPORT WRITTEN"
python3 - "$REPORT" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("could not read the report:", e); sys.exit(1)
for c in d.get("checks", []):
    print(("PASS " if c["ok"] else "FAIL ") + c["name"] + "  " + str(c.get("detail", "")))
print("done=%s passed=%s failed=%s" % (d.get("done"), d.get("passed"), d.get("failed")))
sys.exit(0 if d.get("done") and d.get("failed") == 0 and d.get("passed", 0) > 0 else 1)
PY
RC=$?
xcrun simctl shutdown "$UDID" || true
exit $RC
