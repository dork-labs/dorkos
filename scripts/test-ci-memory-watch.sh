#!/usr/bin/env bash
# Fixture suite for scripts/ci-memory-watch.sh, the credential-free-build memory watch
# (DOR-4813).
#
# The watch's one number is the peak, and the ledger's revert rule reads it, so a
# wrong peak sends the next person the wrong way. The first draft picked the
# sample with the most SWAP: `swap_used_mb=` also ends in `used_mb=`. These cases
# feed `report` a made-up sample log, so they run the same on a Mac (no /proc)
# and on a Linux runner, and never depend on this machine's memory:
#
#   1. the peak is the highest used_mb, even when a lower sample has more swap;
#   2. the peak reaches the step summary;
#   3. `report` exits 0 with samples, with an empty log and with no log at all,
#      since a diagnostics step must never turn a green build red;
#   4. an unknown mode is a usage error (exit 2), not a silent 0.
#
#   bash scripts/test-ci-memory-watch.sh
#   WATCH=/path/to/other.sh bash scripts/test-ci-memory-watch.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WATCH="${WATCH:-$repo_root/scripts/ci-memory-watch.sh}"

pass=0
fail=0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

ok() { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }

# Run `report` with RUNNER_TEMP and GITHUB_STEP_SUMMARY in a fresh case folder.
report_in() {
  local dir=$1
  RUNNER_TEMP="$dir" GITHUB_STEP_SUMMARY="$dir/summary.md" bash "$WATCH" report > "$dir/out.txt" 2>&1
}

# --- 1 and 2: the peak is the most memory used, not the most swap --------------
case1="$work/peak"
mkdir -p "$case1"
cat > "$case1/ci-memory-watch.log" <<'LOG'
00:00:05 used_mb=3000 avail_mb=12000 swap_used_mb=0 top=node@apps/server:900MB
00:00:10 used_mb=9000 avail_mb=6000 swap_used_mb=0 top=node@apps/server:6300MB
00:00:15 used_mb=5000 avail_mb=10000 swap_used_mb=200 top=node@apps/client:4700MB
00:00:20 used_mb=4000 avail_mb=11000 swap_used_mb=0 top=node@packages/cli:3700MB
LOG
report_in "$case1"
rc=$?
[ "$rc" -eq 0 ] && ok "report exits 0 with samples" || bad "report exited $rc with samples"
peak_line=$(grep -A1 '^== peak of 4 samples' "$case1/out.txt" | tail -1)
case "$peak_line" in
  *'used_mb=9000 '*) ok "the peak is the highest used_mb, not the most swap" ;;
  *) bad "the peak line was: $peak_line" ;;
esac
grep -q 'used_mb=9000 ' "$case1/summary.md" 2>/dev/null \
  && ok "the peak reaches the step summary" \
  || bad "the step summary has no used_mb=9000 line"

# --- 1b: ties and a single sample ----------------------------------------------
case1b="$work/single"
mkdir -p "$case1b"
echo '00:00:05 used_mb=1234 avail_mb=14000 swap_used_mb=0 top=bash@.:4MB' > "$case1b/ci-memory-watch.log"
report_in "$case1b"
single_line=$(grep -A1 '^== peak of 1 samples' "$case1b/out.txt" | tail -1)
grep -q 'used_mb=1234 ' <<<"$single_line" \
  && ok "a single sample is its own peak" \
  || bad "a single sample did not come back as the peak"

# --- 3: never fails, with an empty log or none ---------------------------------
case3="$work/empty"
mkdir -p "$case3"
: > "$case3/ci-memory-watch.log"
report_in "$case3"
rc=$?
[ "$rc" -eq 0 ] && ok "report exits 0 on an empty log" || bad "report exited $rc on an empty log"
grep -q '^== no samples' "$case3/out.txt" \
  && ok "an empty log says there were no samples" \
  || bad "an empty log did not say 'no samples'"

case3b="$work/none"
mkdir -p "$case3b"
report_in "$case3b"
rc=$?
[ "$rc" -eq 0 ] && ok "report exits 0 with no log at all" || bad "report exited $rc with no log"

# --- 4: an unknown mode is a usage error ---------------------------------------
bash "$WATCH" nonsense > /dev/null 2>&1
rc=$?
[ "$rc" -eq 2 ] && ok "an unknown mode exits 2" || bad "an unknown mode exited $rc"

echo "ci-memory-watch fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
