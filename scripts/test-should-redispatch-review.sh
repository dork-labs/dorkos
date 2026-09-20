#!/usr/bin/env bash
# Fixture suite for scripts/should-redispatch-review.sh, the gate that decides
# whether .github/workflows/merge-tail.yml re-requests a lost Claude review.
#
# It exists for the mirror image of the reason its sibling
# scripts/test-should-arm-automerge.sh does. There, the dangerous bug is a SKIP
# that stops matching, because the gate then arms something unreviewed. Here the
# dangerous bug is a RETRY that fires when it should not: every RETRY spends a
# slice of the operator's Claude subscription — the same subscription the agents
# writing this repo draw on — and a gate that retries a PR forever, or retries
# the one PR that can never be reviewed, converts a quiet failure into a loud
# recurring cost that nothing in the run list makes obvious.
#
# So each refusal is pinned by shape, and the ceiling and the backoff are pinned
# by arithmetic rather than by inspection.
#
#   bash scripts/test-should-redispatch-review.sh
#   GATE=/path/to/other.sh bash scripts/test-should-redispatch-review.sh

# Every mutation below is a jq program, and `$r` in one is a JQ variable. The
# single quotes are the point, file-wide.
# shellcheck disable=SC2016

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gate=${GATE:-$repo_root/scripts/should-redispatch-review.sh}

if ! command -v jq >/dev/null 2>&1; then
  echo "should-redispatch-review fixtures: needs jq on PATH" >&2
  exit 2
fi

pass=0
fail=0

# The one shape that should retry: an open, undrafted PR whose review check has
# failed once, with the backoff elapsed and the ceiling not reached. Every case
# below is this with exactly one field bent, so a failure names the field.
green() {
  cat <<'JSON'
{
  "number": 1,
  "state": "OPEN",
  "isDraft": false,
  "mergeStateStatus": "CLEAN",
  "labels": [],
  "files": [{"path": "apps/server/src/index.ts"}],
  "checks": [
    {"name": "typecheck", "bucket": "pass"},
    {"name": "review", "bucket": "fail"}
  ],
  "reviewRuns": [
    {"status": "completed", "conclusion": "failure", "updated_at": "2026-09-20T11:00:00Z"}
  ],
  "now": "2026-09-20T12:00:00Z"
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
    printf 'FAIL  %-36s expected %-28s got %s\n' "$name" "$expected" "${got:-<empty>}"
  fi
}

# The one RETRY case. If this regresses to a SKIP the retry loop silently does
# nothing and `review-completes` stops recovering, which is the pre-existing
# state this gate was written to change — and a gate that never fires looks
# exactly like a week with no failed reviews.
check "failed review, backoff elapsed"  "RETRY"                       '.'

# Lifecycle.
check "closed"                          "SKIP not-open"               '.state = "CLOSED"'
check "merged"                          "SKIP not-open"               '.state = "MERGED"'
check "draft"                           "SKIP draft"                  '.isDraft = true'

# The button is already down: the label is on the PR and the review workflow
# will clear it. Asking again races that.
check "re-review already applied"       "SKIP already-requested"      '.labels = [{"name": "re-review"}]'
check "labels as bare strings"          "SKIP already-requested"      '.labels = ["re-review"]'
check "label case is ignored"           "SKIP already-requested"      '.labels = [{"name": "Re-Review"}]'

# An author opt-out is an opt-out. A retry loop must never be a way around it.
check "skip-review"                     "SKIP skip-review"            '.labels = [{"name": "skip-review"}]'
check "unrelated label is fine"         "RETRY"                       '.labels = [{"name": "review:light"}]'

# A PR that edits the review workflow cannot be reviewed by it — the action
# refuses to start when the running workflow differs from the default branch's
# copy. Retrying is futile by construction, so it must be refused BEFORE the
# ladder, or three retries post three more misleading red comments.
check "edits the review workflow"       "SKIP edits-review-workflow"  '.files += [{"path": ".github/workflows/claude-code-review.yml"}]'
check "edits another workflow"          "RETRY"                       '.files += [{"path": ".github/workflows/claude.yml"}]'
check "files as bare strings"           "SKIP edits-review-workflow"  '.files = [".github/workflows/claude-code-review.yml"]'

# Check state. Only a failed review is retried; everything else is either fine
# or not yet an answer.
check "review green"                    "SKIP review-green"           '.checks[1].bucket = "pass"'
check "review pending"                  "SKIP review-in-flight"       '.checks[1].bucket = "pending"'
check "review cancelled"                "SKIP review-not-failed"      '.checks[1].bucket = "cancel"'
check "review skipped"                  "SKIP review-not-failed"      '.checks[1].bucket = "skipping"'
check "no review check at all"          "SKIP no-review-check"        '.checks = [{"name": "typecheck", "bucket": "fail"}]'
check "another check failing"           "RETRY"                       '.checks[0].bucket = "fail"'

# A run still going means a review is already happening; the check bucket can
# lag a completed run by a minute or two, and a retry here would cancel the very
# review it is trying to produce (the review workflow dedupes by head SHA).
check "a run still in flight"           "SKIP run-in-flight"          '.reviewRuns += [{"status": "in_progress", "updated_at": "2026-09-20T11:59:00Z"}]'
check "no runs recorded"                "SKIP no-runs"                '.reviewRuns = []'

# The ceiling: four ATTEMPTS on one head SHA is the first review plus three
# retries, and that is the end of the ladder. Without this a systematically
# broken reviewer retries every PR on every tick, forever.
check "three retries already"           "SKIP retry-ceiling"          '.reviewRuns = [.reviewRuns[0], .reviewRuns[0], .reviewRuns[0], .reviewRuns[0]]'
check "five runs is still the ceiling"  "SKIP retry-ceiling"          '.reviewRuns[0] as $r | .reviewRuns = [$r,$r,$r,$r,$r]'

# ATTEMPTS, NOT RUNS. This is the bug the ladder shipped with, and it is worth
# stating what it cost: over 30 days the review workflow logged 519 skipped and
# 258 cancelled runs against 740 successes, because every label event on a PR
# produces a run that skips and the concurrency dedupe cancels the rest. A PR
# opened with two labels therefore arrives at its FIRST failure with three runs
# already on its head SHA, and counting those gave it one retry instead of
# three — or none once a cancellation joined them. The first two cases are that
# exact shape; the rest pin that neither conclusion can be reached by the
# ladder at all.
check "1 failure + 2 skipped"           "RETRY"                       '.reviewRuns += [{"status":"completed","conclusion":"skipped","updated_at":"2026-09-20T10:59:00Z"},{"status":"completed","conclusion":"skipped","updated_at":"2026-09-20T10:59:00Z"}]'
check "1 failure + 1 cancelled"         "RETRY"                       '.reviewRuns += [{"status":"completed","conclusion":"cancelled","updated_at":"2026-09-20T10:59:00Z"}]'
check "skipped conclusions are ignored" "SKIP no-runs"                '.reviewRuns = [{"status":"completed","conclusion":"skipped","updated_at":"2026-09-20T11:00:00Z"}]'
check "cancelled are ignored too"       "SKIP no-runs"                '.reviewRuns = [{"status":"completed","conclusion":"cancelled","updated_at":"2026-09-20T11:00:00Z"}]'
check "conclusion case is ignored"      "SKIP no-runs"                '.reviewRuns = [{"status":"completed","conclusion":"Skipped","updated_at":"2026-09-20T11:00:00Z"}]'
check "4 attempts + 3 noise is ceiling" "SKIP retry-ceiling"          '.reviewRuns[0] as $r | .reviewRuns = [$r,$r,$r,$r, {"status":"completed","conclusion":"skipped","updated_at":"2026-09-20T11:00:00Z"}]'
# A noop run must not move the clock either, or a skipped label event seconds
# ago would hold the backoff open against a failure from an hour ago.
check "a noop run cannot move the clock" "RETRY"                      '.reviewRuns += [{"status":"completed","conclusion":"skipped","updated_at":"2026-09-20T11:59:00Z"}] | .now = "2026-09-20T11:15:00Z"'

# A run still in flight blocks a retry whatever it is going to conclude as:
# racing it would have the review workflow dedupe by head SHA and cancel the
# very review we are trying to cause. So this one reads ALL runs, not attempts.
check "in-flight noop still blocks"     "SKIP run-in-flight"          '.reviewRuns += [{"status": "queued", "conclusion": null, "updated_at": "2026-09-20T11:59:00Z"}]'

# A CONFLICTING PR gets no workflow run of any kind, so a `re-review` label
# applied to one is never cleared and the human button stays pressed down. Two
# outcomes, in this order: un-stick the button if it is stuck, otherwise leave
# the PR alone. Both outrank the stale red review check still showing on it.
check "conflicting"                     "SKIP conflicting"            '.mergeStateStatus = "DIRTY"'
check "conflicting with stranded label" "CLEAR stranded-label"        '.mergeStateStatus = "DIRTY" | .labels = [{"name": "re-review"}]'
check "conflicting case is ignored"     "SKIP conflicting"            '.mergeStateStatus = "dirty"'
check "conflicting outranks the ceiling" "SKIP conflicting"           '.mergeStateStatus = "DIRTY" | .reviewRuns[0] as $r | .reviewRuns = [$r,$r,$r,$r]'
check "unknown mergeability still retries" "RETRY"                    '.mergeStateStatus = "UNKNOWN"'
check "absent mergeability still retries" "RETRY"                     'del(.mergeStateStatus)'

# A spent subscription window is a wait, not a defect. Retrying burns three runs
# and posts three more red comments on every open PR, none of which could have
# succeeded. Only `quota_*` skips; every other class, and an absent one, leaves
# the ladder to decide, because the safe direction is one wasted run rather than
# a gate that stalls on a value it could not read.
check "last attempt hit the 5-hour cap" "SKIP quota"                  '.reviewClass = "quota_session"'
check "last attempt hit the week cap"   "SKIP quota"                  '.reviewClass = "quota_weekly"'
check "an unnamed quota window"         "SKIP quota"                  '.reviewClass = "quota_unknown"'
check "quota class case is ignored"     "SKIP quota"                  '.reviewClass = "QUOTA_WEEKLY"'
check "turn budget is retriable"        "RETRY"                       '.reviewClass = "turn_budget"'
check "missing credentials is retriable" "RETRY"                      '.reviewClass = "no_credentials"'
check "infra is retriable"              "RETRY"                       '.reviewClass = "infra"'
check "an unreadable class is retriable" "RETRY"                      '.reviewClass = ""'
# The ceiling still binds under a quota stall, and the quota reason is the one
# reported because it is the one a person can act on (by waiting).
check "quota outranks the ceiling"      "SKIP quota"                  '.reviewClass = "quota_weekly" | .reviewRuns[0] as $r | .reviewRuns = [$r,$r,$r,$r]'

# A QUOTA SKIP IS A RUNG, NOT A TERMINUS, and this is the block that says so.
# The gate shipped it as a terminus once: the class is immutable and only this
# gate creates new attempts, so an unconditional skip meant the 5-hour window
# reopened and nothing ever noticed — every open PR losing its ladder at once
# for a whole outage, with a human pressing the button as the only exit. Each
# pair below is one minute short of the window and one minute past it.
# session and unknown wait 300 minutes, weekly 360.
check "session, 299 min after"          "SKIP quota"                  '.reviewClass = "quota_session" | .now = "2026-09-20T15:59:00Z"'
check "session, 300 min after"          "RETRY"                       '.reviewClass = "quota_session" | .now = "2026-09-20T16:00:00Z"'
check "unknown window, 299 min after"   "SKIP quota"                  '.reviewClass = "quota_unknown" | .now = "2026-09-20T15:59:00Z"'
check "unknown window, 300 min after"   "RETRY"                       '.reviewClass = "quota_unknown" | .now = "2026-09-20T16:00:00Z"'
check "weekly, 359 min after"           "SKIP quota"                  '.reviewClass = "quota_weekly" | .now = "2026-09-20T16:59:00Z"'
check "weekly, 360 min after"           "RETRY"                       '.reviewClass = "quota_weekly" | .now = "2026-09-20T17:00:00Z"'
# A window nobody has taught the gate about must still age out rather than
# stranding the PR: it falls back to the shortest wait, not to forever.
check "an unrecognised quota window"    "SKIP quota"                  '.reviewClass = "quota_fortnightly" | .now = "2026-09-20T15:59:00Z"'
check "unrecognised window ages out"    "RETRY"                       '.reviewClass = "quota_fortnightly" | .now = "2026-09-20T16:00:00Z"'
# And the ceiling still ends it. Aging past the window does not resurrect a
# head SHA that has already had its three retries.
check "aged-out quota, ceiling reached" "SKIP retry-ceiling"          '.reviewClass = "quota_session" | .now = "2026-09-20T16:00:00Z" | .reviewRuns[0] as $r | .reviewRuns = [$r,$r,$r,$r]'
# Time that cannot be read outranks the quota rung, because every arm below it
# is a comparison against the clock.
check "quota with unreadable time"      "SKIP unreadable-time"        '.reviewClass = "quota_session" | .now = "whenever"'

# ATTEMPTS ARE COUNTED BY `run_attempt`, NOT BY ROW. GitHub reuses a run id
# when a run is re-run by hand, so three hand re-runs are three reviews that
# each spent a slice of the subscription and ONE row in the runs API. Counting
# rows hands out more retries than the ceiling says.
check "one row, four attempts"          "SKIP retry-ceiling"          '.reviewRuns[0].run_attempt = 4'
check "one row, three attempts"         "RETRY"                       '.reviewRuns[0].run_attempt = 3'
check "attempts sum across rows"        "SKIP retry-ceiling"          '.reviewRuns[0].run_attempt = 2 | .reviewRuns += [{"status":"completed","conclusion":"failure","run_attempt":2,"updated_at":"2026-09-20T11:00:00Z"}]'
check "a missing run_attempt is 1"      "RETRY"                       'del(.reviewRuns[0].run_attempt)'
check "a bogus run_attempt is 1"        "RETRY"                       '.reviewRuns[0].run_attempt = "three"'
# The backoff rung is picked by the attempt count too, so a re-run run moves to
# the next rung rather than repeating the first.
check "2 attempts in one row, 19 min"   "SKIP backoff"                '.reviewRuns[0].run_attempt = 2 | .now = "2026-09-20T11:19:00Z"'
check "2 attempts in one row, 20 min"   "RETRY"                       '.reviewRuns[0].run_attempt = 2 | .now = "2026-09-20T11:20:00Z"'
# A skipped run is not an attempt however many times it was re-run.
check "re-run noop still not an attempt" "SKIP no-runs"               '.reviewRuns = [{"status":"completed","conclusion":"skipped","run_attempt":3,"updated_at":"2026-09-20T11:00:00Z"}]'

# The ladder itself: 10, 20, 40 minutes after the first, second and third run.
# Each pair is one minute short and one minute past, so the boundary is pinned
# rather than approximated.
check "1 run,  9 min elapsed"           "SKIP backoff"                '.now = "2026-09-20T11:09:00Z"'
check "1 run, 10 min elapsed"           "RETRY"                       '.now = "2026-09-20T11:10:00Z"'
check "2 runs, 19 min elapsed"          "SKIP backoff"                '.reviewRuns += [{"status":"completed","updated_at":"2026-09-20T11:00:00Z"}] | .now = "2026-09-20T11:19:00Z"'
check "2 runs, 20 min elapsed"          "RETRY"                       '.reviewRuns += [{"status":"completed","updated_at":"2026-09-20T11:00:00Z"}] | .now = "2026-09-20T11:20:00Z"'
check "3 runs, 39 min elapsed"          "SKIP backoff"                '.reviewRuns[0] as $r | .reviewRuns = [$r,$r,$r] | .now = "2026-09-20T11:39:00Z"'
check "3 runs, 40 min elapsed"          "RETRY"                       '.reviewRuns[0] as $r | .reviewRuns = [$r,$r,$r] | .now = "2026-09-20T11:40:00Z"'

# The clock is read from the NEWEST run, not the first one in the list, so a
# retry that just failed cannot be retried again immediately because an older
# run happens to sit earlier in the array.
check "newest run decides the clock"    "SKIP backoff"                '.reviewRuns += [{"status":"completed","updated_at":"2026-09-20T11:55:00Z"}] | .now = "2026-09-20T12:10:00Z"'

# Time that cannot be read is not permission to retry now.
check "no now"                          "SKIP unreadable-time"        'del(.now)'
check "unparseable now"                 "SKIP unreadable-time"        '.now = "yesterday"'
check "unparseable run time"            "SKIP unreadable-time"        '.reviewRuns[0].updated_at = "a while ago"'

# Precedence: a PR that is both out of retries and editing the workflow reports
# the reason a person can act on.
check "workflow edit outranks ceiling"  "SKIP edits-review-workflow"  '.files += [{"path": ".github/workflows/claude-code-review.yml"}] | .reviewRuns[0] as $r | .reviewRuns = [$r,$r,$r,$r]'

# Missing fields must never read as permission. An empty object has no state.
missing=$(echo '{}' | "$gate" - 2>/dev/null)
if [[ "$missing" == "SKIP not-open" ]]; then pass=$(( pass + 1 )); else
  fail=$(( fail + 1 )); printf 'FAIL  %-36s expected %-28s got %s\n' "empty object" "SKIP not-open" "${missing:-<empty>}"
fi

# Malformed input must refuse loudly (exit 2), never fall through to RETRY.
garbage=$(echo 'not json at all' | "$gate" - 2>/dev/null); garbage_rc=$?
if [[ "$garbage" == "SKIP unreadable-payload" && $garbage_rc -eq 2 ]]; then pass=$(( pass + 1 )); else
  fail=$(( fail + 1 )); printf 'FAIL  %-36s expected %-28s got %s (rc=%d)\n' "garbage input" "SKIP unreadable-payload" "${garbage:-<empty>}" "$garbage_rc"
fi

# The workflow path the gate refuses on must be a file that exists. A rename
# would otherwise leave the gate retrying the one PR it can never help, and
# nothing else in this suite would notice.
wf=$(sed -n "s/^REVIEW_WORKFLOW='\(.*\)'$/\1/p" "$gate")
if [[ -n "$wf" && -f "$repo_root/$wf" ]]; then pass=$(( pass + 1 )); else
  fail=$(( fail + 1 )); printf 'FAIL  %-36s expected %-28s got %s\n' "review workflow path exists" "a file in the repo" "${wf:-<empty>}"
fi

# Same for the check name, and this one is the likeliest thing to get wrong.
# GitHub names a check run after the JOB, not the workflow file, so the gate
# looks for `review` and not `claude-code-review`. Renaming the job — or adding a
# second one, which would make "the job name" ambiguous — silently turns this
# gate into a no-op that reports `no-review-check` for every PR and looks like a
# quiet week. So assert that the workflow still declares exactly one job and that
# its id is the string the gate matches on.
check_name=$(sed -n "s/^REVIEW_CHECK='\(.*\)'$/\1/p" "$gate")
jobs=$(awk '/^jobs:[[:space:]]*$/ { injobs = 1; next }
            injobs && /^[^[:space:]#]/ { exit }
            injobs && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { sub(/:.*/, ""); sub(/^  /, ""); print }' \
  "$repo_root/${wf:-/dev/null}" 2>/dev/null)
if [[ -n "$check_name" && "$jobs" == "$check_name" ]]; then pass=$(( pass + 1 )); else
  fail=$(( fail + 1 )); printf 'FAIL  %-36s expected %-28s got %s\n' "check name is the workflow's one job" "${check_name:-<empty>}" "${jobs:-<empty>}"
fi

# EVERY FIELD THE GATE READS OFF A RUN HAS TO BE A FIELD THE WORKFLOW SENDS, and
# nothing else checks that wire. merge-tail projects the runs API down to a few
# keys before handing them over, so a field the gate reads but the projection
# omits is not an error anywhere: jq returns null, the gate's `// default` takes
# over, and the branch quietly stops doing its job. That is exactly how
# `run_attempt` shipped dead — nine cases above hand-write the field, so they
# stayed green while the workflow never sent it and the ladder went on counting
# rows, with the gate comment and contributing/ci.md both asserting the property
# as fact.
#
# Both ends are asserted, like the verdict-phrase wire in
# scripts/test-review-classifier.sh: the field is in the projection AND the gate
# still reads it. Pinning one end only lets the pair drift apart silently in
# whichever direction is not pinned.
#
# A plain comparison, not the `check` above — that one feeds a jq mutation to the
# gate, and these are assertions about two files.
expect() {
  local name=$1 expected=$2 actual=$3
  if [[ "$expected" == "$actual" ]]; then
    pass=$(( pass + 1 ))
  else
    fail=$(( fail + 1 ))
    printf 'FAIL  %-36s expected %-28s got %s\n' "$name" "$expected" "${actual:-<empty>}"
  fi
}
# A function rather than an inline `case`: a case pattern's `)` inside `$( )` is
# a parse error.
presence() { case "$2" in *"$1"*) echo present ;; *) echo absent ;; esac; }

mt=$repo_root/.github/workflows/merge-tail.yml
projection=$(sed -n 's/.*workflow_runs\[\]? | {\(.*\)}\].*/\1/p' "$mt")
gate_src=$(cat "$gate")
expect "the runs projection was found" yes \
  "$([[ -n "$projection" ]] && echo yes || echo no)"
for field in status conclusion run_attempt updated_at; do
  expect "merge-tail sends .$field" present "$(presence "$field" "$projection")"
  expect "the gate still reads .$field" present "$(presence ".$field" "$gate_src")"
done

echo
echo "should-redispatch-review fixtures: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
