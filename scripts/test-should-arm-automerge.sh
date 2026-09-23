#!/usr/bin/env bash
# Fixture suite for scripts/should-arm-automerge.sh, the gate that decides
# whether .github/workflows/merge-tail.yml may arm auto-merge on a pull request.
#
# It exists because the failure this gate can produce is silent. A crash is
# obvious and harmless: nothing gets armed. The dangerous bug is a SKIP branch
# that quietly stops matching — a renamed field, a `bucket` value nobody
# anticipated, a `labels` payload shaped as strings instead of objects — because
# then the gate keeps returning ARM and the first symptom is unreviewed code on
# `main`. Nothing about the source makes that visible, so every refusal is pinned
# here by shape.
#
#   bash scripts/test-should-arm-automerge.sh
#   GATE=/path/to/other.sh bash scripts/test-should-arm-automerge.sh
#
# GATE exists so a candidate rewrite can be run against the same fixtures.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gate=${GATE:-$repo_root/scripts/should-arm-automerge.sh}

if ! command -v jq >/dev/null 2>&1; then
  echo "should-arm-automerge fixtures: needs jq on PATH" >&2
  exit 2
fi

pass=0
fail=0

# A pull request in the one state that should arm: open, undrafted, unarmed,
# unlabelled, cleanly mergeable, reviewed, every check settled green. Each case
# below is this shape with exactly one field bent, so a failure names the field.
green() {
  cat <<'JSON'
{
  "number": 1,
  "state": "OPEN",
  "isDraft": false,
  "mergeStateStatus": "BEHIND",
  "autoMergeRequest": null,
  "mergeQueueEntry": null,
  "reviewDecision": "APPROVED",
  "labels": [],
  "unresolvedThreads": 0,
  "checks": [
    {"name": "typecheck", "bucket": "pass"},
    {"name": "fragment-present", "bucket": "pass"},
    {"name": "no-fragment-under-skip-label", "bucket": "skipping"},
    {"name": "review", "bucket": "pass"}
  ],
  "headSince": "2026-09-21T15:00:00Z",
  "queueRemovals": []
}
JSON
}

# check <name> <expected-verdict> <jq-mutation-of-the-green-fixture>
check() {
  local name=$1 expected=$2 mutation=$3 got
  got=$(green | jq "$mutation" | "$gate" - 2>/dev/null)
  if [[ "$got" == "$expected" ]]; then
    pass=$(( pass + 1 ))
  else
    fail=$(( fail + 1 ))
    printf 'FAIL  %-34s expected %-26s got %s\n' "$name" "$expected" "${got:-<empty>}"
  fi
}

# The one ARM case. If this regresses to a SKIP the bot silently does nothing,
# which is the pre-existing bug it was written to fix.
check "fully green PR"            "ARM"                       '.'

# Lifecycle states that are not a finished PR.
check "closed"                    "SKIP not-open"             '.state = "CLOSED"'
check "merged"                    "SKIP not-open"             '.state = "MERGED"'
check "draft"                     "SKIP draft"                '.isDraft = true'
check "already armed"             "SKIP already-armed"        '.autoMergeRequest = {"enabledAt": "now"}'

# A queued PR reports autoMergeRequest:null, so the armed check above cannot see
# it. Without its own branch the bot re-arms every queued PR on every tick.
check "already queued"            "SKIP already-queued"       '.mergeQueueEntry = {"position": 1, "state": "AWAITING_CHECKS"}'
check "queued and armed"          "SKIP already-armed"        '.mergeQueueEntry = {"position": 1} | .autoMergeRequest = {"enabledAt": "now"}'

# The two facts only merge-tail's GraphQL read supplies must be PRESENT, not
# defaulted: a payload built without them (a failed read, or a caller using
# `gh pr view` alone) used to read as "not queued" and "no open threads".
check "queue entry absent"        "SKIP queue-entry-unknown"  'del(.mergeQueueEntry)'
check "thread count absent"       "SKIP review-threads-unknown" 'del(.unresolvedThreads)'
check "thread count null"         "SKIP review-threads-unknown" '.unresolvedThreads = null'
check "thread count not a number" "SKIP review-threads-unknown" '.unresolvedThreads = "0"'

# A hold label outranks every green signal, including on an otherwise
# perfect PR. Both payload shapes gh can produce are covered: objects and
# bare strings.
check "hold label (object)"       "SKIP held-by-label"        '.labels = [{"name": "hold"}]'
check "hold label (string)"       "SKIP held-by-label"        '.labels = ["do-not-merge"]'
check "hold label (mixed case)"   "SKIP held-by-label"        '.labels = [{"name": "WIP"}]'
check "hold among others"         "SKIP held-by-label"        '.labels = [{"name": "bug"}, {"name": "blocked"}]'
check "unrelated label is fine"   "ARM"                       '.labels = [{"name": "review:light"}]'

# A conflicting PR runs no CI at all, so its green checks are stale and
# meaningless. This is the trap the creating-pull-requests skill documents.
check "conflicting"               "SKIP conflicting"          '.mergeStateStatus = "DIRTY"'

# GitHub reports UNKNOWN until it has computed mergeability. Treating that as
# clean would arm the conflicting case the line above refuses, one poll early.
check "mergeability unknown"      "SKIP mergeability-unknown" '.mergeStateStatus = "UNKNOWN"'
check "mergeability absent"       "SKIP mergeability-unknown" 'del(.mergeStateStatus)'

# Human review signals.
check "changes requested"         "SKIP changes-requested"    '.reviewDecision = "CHANGES_REQUESTED"'
check "unresolved threads"        "SKIP unresolved-threads"   '.unresolvedThreads = 3'
check "exactly one open thread"   "SKIP unresolved-threads"   '.unresolvedThreads = 1'
check "no review decision yet"    "ARM"                       '.reviewDecision = ""'

# Check buckets. Anything unsettled or unhappy refuses.
check "a failing check"           "SKIP failing-checks"       '.checks[0].bucket = "fail"'
check "a cancelled check"         "SKIP cancelled-checks"     '.checks[0].bucket = "cancel"'
check "a check still running"     "SKIP checks-in-flight"     '.checks[0].bucket = "pending"'
check "no checks at all"          "SKIP no-checks"            '.checks = []'
check "all checks skipped"        "ARM"                       '.checks = [{"name":"a","bucket":"skipping"}]'
check "fail outranks pending"     "SKIP failing-checks"       '.checks[0].bucket = "fail" | .checks[1].bucket = "pending"'

# Precedence: a held PR that is also broken still reports the hold, so the
# operator sees the human signal rather than chasing CI.
check "hold outranks failure"     "SKIP held-by-label"        '.labels = [{"name": "hold"}] | .checks[0].bucket = "fail"'

# The queue's memory. The browser suite runs only in the merge queue, so a PR
# that breaks a browser test is fully green on the PR and, before this rule, was
# re-armed unchanged after every ejection: #1964 went round five times for one
# assertion. Pinned in BOTH directions, because the failure that matters here is
# the refusal quietly never matching (the queue burns builds again) and the one
# that hurts next is it matching too much (a flaky first ejection stops arming).
E1='{"at": "2026-09-21T16:00:00Z", "reason": "failed_checks", "failedChecks": ["browser-shard (2/3)", "browser-test"]}'
E2='{"at": "2026-09-21T17:00:00Z", "reason": null, "failedChecks": ["browser-test", "browser-shard (2/3)"]}'
OTHER='{"at": "2026-09-21T17:00:00Z", "reason": "failed_checks", "failedChecks": ["test-shard (1/4)"]}'
check "first queue ejection"         "ARM"                        ".queueRemovals = [$E1]"
check "same check, same head, 2x"    "SKIP repeat-queue-failure"  ".queueRemovals = [$E1, $E2]"
check "reason null still counts"     "SKIP repeat-queue-failure"  ".queueRemovals = [$E1, $E2] | .queueRemovals[].reason = null"
check "new commit resets it"         "ARM"                        ".queueRemovals = [$E1, $E2] | .headSince = \"2026-09-21T18:00:00Z\""
check "one before, one after push"   "ARM"                        ".queueRemovals = [$E1, $E2] | .headSince = \"2026-09-21T16:30:00Z\""
check "different checks each time"   "ARM"                        ".queueRemovals = [$E1, $OTHER]"
check "no failed check, no count"    "ARM"                        ".queueRemovals = [$E1, $E2] | .queueRemovals[].failedChecks = [] | .queueRemovals[].reason = \"merged\""
check "one check repeats in three"   "SKIP repeat-queue-failure"  ".queueRemovals = [$E1, $OTHER, $E2]"
check "queue history absent"         "SKIP queue-history-unknown" 'del(.queueRemovals)'
check "queue history null"           "SKIP queue-history-unknown" '.queueRemovals = null'
check "head push time unknown"       "SKIP queue-history-unknown" ".queueRemovals = [$E1] | .headSince = null"
check "unknown push, no ejections"   "ARM"                        '.headSince = null'
check "junk removal entries ignored" "ARM"                        ".queueRemovals = [\"x\", 3, null, $E1]"
check "hold outranks repeat"         "SKIP held-by-label"         ".queueRemovals = [$E1, $E2] | .labels = [\"hold\"]"
check "red PR check outranks repeat" "SKIP failing-checks"        ".queueRemovals = [$E1, $E2] | .checks[0].bucket = \"fail\""

# merge-tail names the repeated checks in its comment from --repeat-failure,
# which must agree with the verdict: the same names on a repeat, nothing on a
# first ejection or once a new commit has reset the count.
expect_names() {
  local name=$1 expected=$2 mutation=$3 got
  got=$(green | jq "$mutation" | "$gate" --repeat-failure - 2>/dev/null | paste -sd, -)
  if [[ "$got" == "$expected" ]]; then pass=$(( pass + 1 )); else
    fail=$(( fail + 1 )); printf 'FAIL  %-34s expected %-26s got %s\n' "$name" "${expected:-<empty>}" "${got:-<empty>}"
  fi
}
expect_names "names on a repeat"           "browser-shard (2/3),browser-test" ".queueRemovals = [$E1, $E2]"
expect_names "no names on a first eject"   ""                                 ".queueRemovals = [$E1]"
expect_names "no names after a new commit" ""                                 ".queueRemovals = [$E1, $E2] | .headSince = \"2026-09-21T18:00:00Z\""

# Missing fields must never read as permission. An empty object has no state, so
# it is not open.
missing=$(echo '{}' | "$gate" - 2>/dev/null)
if [[ "$missing" == "SKIP not-open" ]]; then pass=$(( pass + 1 )); else
  fail=$(( fail + 1 )); printf 'FAIL  %-34s expected %-26s got %s\n' "empty object" "SKIP not-open" "${missing:-<empty>}"
fi

# Malformed input must refuse loudly (exit 2), never fall through to ARM.
garbage=$(echo 'not json at all' | "$gate" - 2>/dev/null); garbage_rc=$?
if [[ "$garbage" == "SKIP unreadable-payload" && $garbage_rc -eq 2 ]]; then pass=$(( pass + 1 )); else
  fail=$(( fail + 1 )); printf 'FAIL  %-34s expected %-26s got %s (rc=%d)\n' "garbage input" "SKIP unreadable-payload" "${garbage:-<empty>}" "$garbage_rc"
fi

echo
echo "should-arm-automerge fixtures: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
