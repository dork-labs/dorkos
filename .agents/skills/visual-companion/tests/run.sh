#!/usr/bin/env bash
# Run the visual companion's headless checks (playwright-core + a Chromium,
# found by scripts/locate.cjs). Full TAP output goes to $TMPDIR, not the repo.
set -o pipefail
cd "$(dirname "$0")" || exit 1
log="${TMPDIR:-/tmp}/visual-companion-tests.tap"
node --test --test-timeout=60000 --test-concurrency=1 ./*.test.cjs 2>&1 | tee "$log" | grep -E "^(not )?ok|^# (tests|pass|fail)"
status=${PIPESTATUS[0]}
echo "# full output: $log"
exit "$status"
