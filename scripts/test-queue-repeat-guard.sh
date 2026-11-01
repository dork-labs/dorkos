#!/usr/bin/env bash
# Fixture suite for scripts/queue-repeat-guard.sh, the merge queue's door for
# the repeat-ejection rule (.github/workflows/queue-repeat-guard.yml).
#
# Both ways it can be wrong are pinned. A DEQUEUE that stops matching lets a
# broken head back into the queue, where it fails again and takes every build
# stacked behind it down too. A DEQUEUE that matches too much takes a good pull
# request out of the queue: two different failures, a non-required check such
# as security-gate, the old head's ejections, or history nobody could read.
#
#   bash scripts/test-queue-repeat-guard.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
guard=$repo_root/scripts/queue-repeat-guard.sh

if ! command -v jq >/dev/null 2>&1; then
  echo "queue-repeat-guard fixtures: needs jq on PATH" >&2
  exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

# A queued pull request whose head (pushed 15:00) the queue has rejected twice,
# both times on browser-test, plus one ejection of the OLD head before it.
repeat() {
  cat <<'JSON'
{
  "number": 7,
  "headRefOid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "labels": [{"name": "review:light"}],
  "mergeQueueEntry": {"position": 1, "state": "AWAITING_CHECKS"},
  "headSince": "2026-10-20T15:00:00Z",
  "queueRemovals": [
    {"at": "2026-10-20T14:00:00Z", "reason": "failed_checks", "failedChecks": ["browser-test", "browser-shard (2/6)"]},
    {"at": "2026-10-20T16:00:00Z", "reason": "failed_checks", "failedChecks": ["browser-test", "browser-shard (2/6)"]},
    {"at": "2026-10-20T17:00:00Z", "reason": "failed_checks", "failedChecks": ["browser-shard (5/6)", "browser-test"]}
  ]
}
JSON
}

# check <name> <expected-first-line> <jq-mutation-of-the-repeat-fixture>
check() {
  local name=$1 expected=$2 mutation=$3 got
  repeat | jq "$mutation" > "$tmp/p.json"
  got=$(bash "$guard" verdict "$tmp/p.json" 2>/dev/null | head -n 1)
  if [[ "$got" == "$expected" ]]; then
    pass=$(( pass + 1 ))
  else
    fail=$(( fail + 1 ))
    printf 'FAIL  %-40s expected %-28s got %s\n' "$name" "$expected" "${got:-<empty>}"
  fi
}

# expect <name> <expected> <actual>
expect() {
  if [[ "$3" == "$2" ]]; then
    pass=$(( pass + 1 ))
  else
    fail=$(( fail + 1 ))
    printf 'FAIL  %-40s expected %s\ngot:\n%s\n' "$1" "$2" "$3"
  fi
}

# ── verdict ───────────────────────────────────────────────────────────────
check "same required check twice on this head" "DEQUEUE"                '.'

# Only the repeated REQUIRED checks are named; a shard is not a context.
repeat > "$tmp/p.json"
expect "names only the repeated required check" "$(printf 'DEQUEUE\nbrowser-test')" \
  "$(bash "$guard" verdict "$tmp/p.json")"

check "one ejection of this head"          "KEEP no-repeat"              'del(.queueRemovals[2])'
check "two different checks"               "KEEP no-repeat"              '.queueRemovals[1].failedChecks = ["test"] | .queueRemovals[2].failedChecks = ["typecheck"]'
check "old head's ejections do not count"  "KEEP no-repeat"              '.headSince = "2026-10-20T16:30:00Z"'
check "removals that failed nothing"       "KEEP no-repeat"              '.queueRemovals[1:] |= map(.failedChecks = [] | .reason = "manual")'
check "non-required check repeats"         "KEEP no-repeat"              '.queueRemovals[1].failedChecks = ["security-gate","test"] | .queueRemovals[2].failedChecks = ["security-gate","typecheck"]'
# requeue-ok counts only when added after the last failed try (17:00 here),
# so a rebuild of the same try still sees it, and the next failure spends it.
check "requeue-ok added after last failure" "KEEP requeue-ok"            '.labels += [{"name": "requeue-ok"}] | .requeueOkAt = "2026-10-20T17:30:00Z"'
check "label as a bare string"             "KEEP requeue-ok"             '.labels = ["Requeue-OK"] | .requeueOkAt = "2026-10-20T17:30:00Z"'
check "requeue-ok spent by a later failure" "DEQUEUE"                    '.labels += [{"name": "requeue-ok"}] | .requeueOkAt = "2026-10-20T16:30:00Z"'
check "non-required failure spends nothing" "KEEP requeue-ok"           '.labels += [{"name": "requeue-ok"}] | .requeueOkAt = "2026-10-20T17:30:00Z" | .queueRemovals += [{"at": "2026-10-20T18:00:00Z", "reason": "merged", "failedChecks": ["security-gate"]}]'
check "requeue-ok with no label history"   "DEQUEUE"                   '.labels += [{"name": "requeue-ok"}]'
check "label history but label removed"    "DEQUEUE"                     '.requeueOkAt = "2026-10-20T17:30:00Z"'
check "removals unknown"                   "KEEP queue-history-unknown"  'del(.queueRemovals)'
check "removals null"                      "KEEP queue-history-unknown"  '.queueRemovals = null'
check "head time unknown with failures"    "KEEP queue-history-unknown"  '.headSince = null'

repeat > "$tmp/p.json"
got=$(REQUIRED_CHECKS=$tmp/missing.json bash "$guard" verdict "$tmp/p.json")
expect "required list unreadable" "KEEP required-checks-unknown" "$got"

echo 'not json' > "$tmp/bad.json"
got=$(bash "$guard" verdict "$tmp/bad.json"); code=$?
expect "unreadable payload" "KEEP unreadable-payload 2" "$got $code"

# ── pr-from-ref ───────────────────────────────────────────────────────────
sha=0123456789abcdef0123456789abcdef01234567
expect "queue ref"            "3212" "$(bash "$guard" pr-from-ref "refs/heads/gh-readonly-queue/main/pr-3212-$sha")"
expect "queue ref, no prefix" "3212" "$(bash "$guard" pr-from-ref "gh-readonly-queue/main/pr-3212-$sha")"
expect "slashed base branch"  "9"    "$(bash "$guard" pr-from-ref "refs/heads/gh-readonly-queue/release/1.x/pr-9-$sha")"
bash "$guard" pr-from-ref "refs/heads/main" >/dev/null; expect "not a queue ref" "1" "$?"
bash "$guard" pr-from-ref "refs/heads/gh-readonly-queue/main/pr-12-abc" >/dev/null; expect "short sha" "1" "$?"

# ── comment ───────────────────────────────────────────────────────────────
printf 'browser-test\n' > "$tmp/repeats.txt"
body=$(bash "$guard" comment 7 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$tmp/repeats.txt")
# merge-tail's marker, so the author is told once per head by either workflow.
grep -qxF '<!-- merge-tail:repeat-queue-failure head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->' <<<"$body"
expect "comment carries merge-tail's marker" "0" "$?"
grep -qF -- '- `browser-test`' <<<"$body"; expect "comment names the check" "0" "$?"
grep -qF 'pr-7-' <<<"$body";               expect "comment names the run filter" "0" "$?"
grep -qF '`requeue-ok`' <<<"$body";        expect "comment names the way past it" "0" "$?"

# ── merge-tail's comment points at the same way past ─────────────────────
grep -qF 'requeue-ok' "$repo_root/.github/workflows/merge-tail.yml"
expect "merge-tail names requeue-ok" "0" "$?"

echo "queue-repeat-guard fixtures: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
