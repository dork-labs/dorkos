#!/usr/bin/env bash
# Fixture suite for scripts/review-redispatch-wait.sh (ledger
# 261124-161126): the wait after a failed review lands just past the
# ladder's rung in should-redispatch-review.sh, never past the cap, and the
# workflow that sleeps on it is wired the way the header says. Pure; needs bash
# and jq.
#
#   bash scripts/test-review-redispatch-wait.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/review-redispatch-wait.sh
tmp=$(mktemp -d -t review-redispatch-wait-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
out=""
rc=0
check() {
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3" >&2
  fi
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }

# w <now> <runs-json>
w() {
  printf '%s' "$2" >"$tmp/runs.json"
  out=$(NOW=$1 "$SCRIPT" "$tmp/runs.json" 2>&1)
  rc=$?
}
failed() { echo "{\"id\": $1, \"status\": \"completed\", \"conclusion\": \"failure\", \"run_attempt\": ${3:-1}, \"updated_at\": \"$2\"}"; }

w 2026-11-24T12:00:00Z "[$(failed 1 2026-11-24T12:00:00Z)]"
check 'first failure, just now: the 10-minute rung plus a minute' 660 "$out"
check 'exits 0' 0 "$rc"
w 2026-11-24T12:04:00Z "[$(failed 1 2026-11-24T12:00:00Z)]"
check 'four minutes later: the rest of it' 420 "$out"
w 2026-11-24T12:30:00Z "[$(failed 1 2026-11-24T12:00:00Z)]"
check 'the rung has passed: no wait' 0 "$out"
w 2026-11-24T13:00:00Z "[$(failed 1 2026-11-24T12:00:00Z), $(failed 2 2026-11-24T13:00:00Z)]"
check 'second attempt failed: the 20-minute rung' 1260 "$out"
w 2026-11-24T13:00:00Z "[$(failed 1 2026-11-24T13:00:00Z 3)]"
check 'a re-run counts its attempts: three attempts, the 40-minute rung' 2460 "$out"
w 2026-11-24T13:00:00Z "[$(failed 1 2026-11-24T12:00:00Z 2), $(failed 2 2026-11-24T13:00:00Z 2)]"
check 'the ceiling (4 attempts) reached: no wait, the ladder says why' 0 "$out"
w 2026-11-24T12:00:00Z "[$(failed 1 2026-11-24T12:00:00Z),
  {\"id\": 2, \"status\": \"completed\", \"conclusion\": \"skipped\", \"run_attempt\": 1, \"updated_at\": \"2026-11-24T12:00:30Z\"},
  {\"id\": 3, \"status\": \"completed\", \"conclusion\": \"cancelled\", \"run_attempt\": 1, \"updated_at\": \"2026-11-24T12:00:40Z\"}]"
check 'skipped and cancelled runs are not attempts and do not move the clock' 660 "$out"
w 2026-11-24T12:00:00Z "[$(failed 1 2026-11-24T12:00:00Z), {\"id\": 2, \"status\": \"in_progress\", \"conclusion\": null, \"run_attempt\": 1, \"updated_at\": \"2026-11-24T12:00:00Z\"}]"
check 'a review in flight: no wait (its own completion wakes the workflow)' 0 "$out"
w 2026-11-24T12:00:00Z '[]'
check 'no runs: no wait' 0 "$out"
w 2026-11-24T12:00:00Z 'not json'
check 'unreadable runs: the first rung, as a fallback' 660 "$out"
check 'and still exits 0' 0 "$rc"
w 2026-11-24T12:00:00Z "[{\"id\": 1, \"status\": \"completed\", \"conclusion\": \"failure\", \"run_attempt\": 1, \"updated_at\": \"soon\"}]"
check 'an unreadable time: the fallback' 660 "$out"

# The cap, with a ladder whose rung is longer than it.
sed "s/^BACKOFF_MINUTES=.*/BACKOFF_MINUTES='[90]'/" "$repo_root/scripts/should-redispatch-review.sh" >"$tmp/ladder.sh"
printf '%s' "[$(failed 1 2026-11-24T12:00:00Z)]" >"$tmp/runs.json"
out=$(NOW=2026-11-24T12:00:00Z LADDER=$tmp/ladder.sh "$SCRIPT" "$tmp/runs.json" 2>&1)
check 'never more than 45 minutes' 2700 "$out"
# The constants come from the ladder, not from a copy.
sed "s/^BACKOFF_MINUTES=.*/BACKOFF_MINUTES='[5]'/" "$repo_root/scripts/should-redispatch-review.sh" >"$tmp/ladder.sh"
out=$(NOW=2026-11-24T12:00:00Z LADDER=$tmp/ladder.sh "$SCRIPT" "$tmp/runs.json" 2>&1)
check 'a different first rung moves the wait' 360 "$out"
grep -v '^BACKOFF_MINUTES=' "$repo_root/scripts/should-redispatch-review.sh" >"$tmp/ladder.sh"
out=$(LADDER=$tmp/ladder.sh "$SCRIPT" "$tmp/runs.json" 2>&1)
check 'a ladder without its rungs is exit 2, not a guess' 2 "$?"
check 'and says so' yes "$(has "$out" 'no BACKOFF_MINUTES')"
grep -v '^MAX_RUNS=' "$repo_root/scripts/should-redispatch-review.sh" >"$tmp/ladder.sh"
out=$(LADDER=$tmp/ladder.sh "$SCRIPT" "$tmp/runs.json" 2>&1)
check 'a ladder without its ceiling is exit 2' 2 "$?"
out=$("$SCRIPT" 2>&1)
check 'no file is usage' 2 "$?"

# --- the wiring in review-redispatch.yml ---
wf=$(cat "$repo_root/.github/workflows/review-redispatch.yml")
check 'it wakes on claude-code-review completing' yes "$(grep -A2 '^  workflow_run:' <<<"$wf" | tr -d ' \n' | grep -F 'workflows:[claude-code-review]types:[completed]' >/dev/null && echo yes || echo no)"
check 'the review workflow is named claude-code-review' yes "$(grep -qx 'name: claude-code-review' "$repo_root/.github/workflows/claude-code-review.yml" && echo yes || echo no)"
check 'the wait job sleeps on this script' yes "$(has "$wf" 'bash scripts/review-redispatch-wait.sh')"
check 'its sparse checkout carries the ladder it reads' yes "$(has "$wf" 'scripts/should-redispatch-review.sh')"
check 'the scan keeps one concurrency group' yes "$(grep -A2 '^    concurrency:' <<<"$wf" | grep -F 'group: review-redispatch' >/dev/null && echo yes || echo no)"
check 'the cron stays as a backstop' yes "$(has "$wf" "- cron: '*/10 * * * *'")"

echo "review-redispatch-wait: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
