#!/bin/sh
# Runs the end-to-end test on a virtual screen WITH a window manager (needed to switch windows).
# Exit code = the test's verdict (0 = all checks passed).
cd "$(dirname "$0")/../.." || exit 1
mkdir -p test/e2e/out && rm -f test/e2e/out/result
xvfb-run -a --server-args='-screen 0 1280x800x24' sh test/e2e/inner.sh
[ -f test/e2e/out/result ] && exit "$(cat test/e2e/out/result)"
echo "e2e produced no verdict" >&2
exit 4
