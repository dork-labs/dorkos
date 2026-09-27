#!/usr/bin/env bash
# Decide whether one pull request may have auto-merge armed on it.
#
# Why this exists: nothing in this repo ever armed auto-merge. The only
# implemented merge tail is ADR-0276's auto-merge recovery ladder, which lives in
# the flow plugin behind autonomous Pulse mode (`enabled: false` in v1). Outside
# that loop, `flow__flow-drain` stops agents at the review gate and the
# `gh pr merge --auto` line in the creating-pull-requests skill is prose that
# nothing executes. So finished, green, reviewed PRs sat open indefinitely and a
# human armed each one by hand. .github/workflows/merge-tail.yml does that job
# now, and this script is the decision it makes.
#
# It is a separate script with fixtures, rather than jq inline in the workflow,
# because this is the gate that decides to LAND CODE without a human in the loop.
# The failure that matters is not a crash, it is arming something that should not
# have been armed, which is invisible until it merges. Every SKIP branch is
# pinned by scripts/test-should-arm-automerge.sh.
#
# The rule is affirmative, not permissive: a PR is armed only when every signal
# is explicitly good. Anything unknown, unsettled, or unreadable is a SKIP. In
# particular an in-flight check is NOT treated as "probably fine" — arming on a
# pending suite would merge the PR the instant it went green, which is exactly
# the review-gate bypass the repo's approval work has been closing.
#
# Usage:
#   scripts/should-arm-automerge.sh <pr.json>
#   gh pr view N --json ... | scripts/should-arm-automerge.sh -
#   scripts/should-arm-automerge.sh --repeat-failure <pr.json>
#
# Prints exactly one line:
#   ARM               arm auto-merge on this PR
#   SKIP <reason>     leave it alone; <reason> is a stable machine-readable slug
#
# `--repeat-failure` prints, one per line, the checks behind a
# `SKIP repeat-queue-failure` (nothing when there are none), so the caller can
# name them without restating the rule. Both modes share one jq definition.
#
# Exit status is 0 for a readable verdict and 2 only when the input itself could
# not be parsed, so a malformed payload can never be mistaken for a quiet ARM.
#
# Expected input (a superset is fine; unknown keys are ignored):
#   {
#     "number": 537,
#     "state": "OPEN",
#     "isDraft": false,
#     "mergeStateStatus": "BEHIND",
#     "autoMergeRequest": null,
#     "mergeQueueEntry": null,
#     "reviewDecision": "APPROVED",
#     "labels": [{"name": "hold"}],
#     "unresolvedThreads": 0,
#     "checks": [{"name": "typecheck", "bucket": "pass"}],
#     "headSince": "2026-09-21T15:02:45Z",
#     "queueRemovals": [{"at": "2026-09-21T14:10:19Z",
#                        "failedChecks": ["browser-shard (2/3)", "browser-test"]}]
#   }
#
# `bucket` follows `gh pr checks --json bucket`: pass | fail | pending | skipping | cancel.
#
# `autoMergeRequest` and `mergeQueueEntry` are BOTH needed, and neither implies
# the other: a pull request sitting in the merge queue reports
# `autoMergeRequest: null`, so the first field alone cannot tell you the merge is
# already handled. `mergeQueueEntry` is GraphQL-only — `gh pr view --json` does
# not expose it, so a caller building this payload from `gh pr view` alone will
# silently omit it — and the gate refuses such a payload (`SKIP
# queue-entry-unknown`) rather than reading the gap as "not queued". Likewise
# `unresolvedThreads` must be a number. merge-tail builds this payload with
# scripts/should-arm-automerge-input.sh, which refuses a GraphQL error body
# before any of these fields are read from it.
#
# `headSince` and `queueRemovals` are the queue's memory, which the PR's own
# checks do not have. The browser suite runs only in the merge queue, so a PR
# that breaks a browser test reads fully green on the PR, is ejected, and before
# this rule was re-armed unchanged on the next tick: PR #1964 was ejected five
# times for one assertion (17 queue builds, its own and everything stacked
# behind it) before anyone pushed a fix.
#   headSince      when the current head was first pushed: the earliest check
#                  suite on the head commit. GitHub records no push time for a
#                  plain push (`pushedDate` is null) and a commit's own date is
#                  when it was written, not pushed, so it would count an
#                  ejection of the OLD head against a fix written before it.
#   queueRemovals  the PR's recent REMOVED_FROM_MERGE_QUEUE_EVENTs, each with
#                  the names of the check runs that failed on the queue's
#                  merge-group commit. An entry with no failed check is not a
#                  failure (merged, a conflict, a manual dequeue, a timeout),
#                  which is why `reason` is not read: it is often null.
# The rule: a check that failed in REPEAT_EJECTIONS or more removals since the
# current head was pushed is a regression the queue keeps finding, not a flake.
# A new commit moves `headSince` and resets it. Both fields are REQUIRED:
# a missing `queueRemovals` is unknown history, and unknown is a skip.

set -uo pipefail

# Two ejections for the same check on the same head. The first is allowed a
# re-arm because 85% of failed-checks ejections re-pass unchanged; the second is
# the documented point at which a failure counts as real.
REPEAT_EJECTIONS=2

# The checks that failed in at least $n queue removals of the current head.
# Shared by the verdict and by --repeat-failure so the two cannot disagree.
REPEATS_DEF='
  def repeated_failures($n):
    (.headSince // null) as $since
    | [ (.queueRemovals // [])[]
        | select(type == "object")
        | select($since != null and ((.at // "") > $since))
        | [(.failedChecks // [])[] | tostring] | unique ]
    | [ .[][] ] | group_by(.) | map(select(length >= $n) | .[0]);
  def history_known:
    ((.queueRemovals | type) == "array")
    and ( (.headSince // null) != null
          or ([.queueRemovals[] | select(type == "object")
               | select(((.failedChecks // []) | length) > 0)] | length) == 0 );
'

mode=verdict
if [[ "${1:-}" == "--repeat-failure" ]]; then mode=repeats; shift; fi

src=${1:-}
if [[ -z "$src" ]]; then
  echo "usage: $0 [--repeat-failure] <pr.json>|-" >&2
  exit 2
fi
if [[ "$src" == "-" ]]; then payload=$(cat); else payload=$(cat "$src" 2>/dev/null); fi

if ! jq -e . >/dev/null 2>&1 <<<"$payload"; then
  echo "SKIP unreadable-payload"
  exit 2
fi

if [[ "$mode" == "repeats" ]]; then
  jq -r --argjson n "$REPEAT_EJECTIONS" "$REPEATS_DEF"'
    if history_known then repeated_failures($n)[] else empty end' <<<"$payload" 2>/dev/null \
    || exit 2
  exit 0
fi

# Labels that mean "a human is not done with this yet". Checked before anything
# else that could look green, so a hold always wins.
HOLD_LABELS='["hold","do-not-merge","do not merge","wip","blocked"]'

verdict=$(jq -r --argjson hold "$HOLD_LABELS" --argjson repeat "$REPEAT_EJECTIONS" "$REPEATS_DEF"'
  # gh emits labels as objects; some callers pass bare strings. Indexing a
  # string with .name is a jq error, not a null, so it must be branched on type
  # or the whole gate returns unreadable-payload and arms nothing.
  def labels: [(.labels // [])[]
               | (if type == "object" then (.name // "") else tostring end)
               | ascii_downcase];
  def buckets: [(.checks // [])[] | (.bucket // "") | ascii_downcase];

  if (.state // "") != "OPEN"                       then "SKIP not-open"
  elif (.isDraft // false)                          then "SKIP draft"
  elif (.autoMergeRequest // null) != null          then "SKIP already-armed"

  # A pull request sitting in the merge queue reports `autoMergeRequest: null`,
  # so the branch above does NOT catch it. Without this one, the bot re-arms
  # every queued pull request on every tick. Verified on 2026-07-28: PRs 573,
  # 572 and 566 were at queue positions 1-3 in AWAITING_CHECKS with a null
  # autoMergeRequest.
  # Absent is not null. Only the GraphQL read in merge-tail supplies
  # `mergeQueueEntry`, so a payload without it was built from a failed read
  # or from `gh pr view` alone, and defaulting it to null would call a
  # queued PR unqueued (DOR-2271).
  elif (has("mergeQueueEntry") | not)               then "SKIP queue-entry-unknown"
  elif .mergeQueueEntry != null                     then "SKIP already-queued"
  elif ((labels) as $l | any($hold[]; . as $h | $l | index($h)))
                                                    then "SKIP held-by-label"

  # A conflicting PR gets no CI at all (GitHub cannot build its test-merge
  # commit), so its checks are stale or absent and mean nothing. Arming here is
  # the trap the creating-pull-requests skill documents.
  elif (.mergeStateStatus // "") == "DIRTY"         then "SKIP conflicting"

  # GitHub computes mergeability lazily and reports UNKNOWN until it finishes.
  # UNKNOWN is not "probably clean": a PR that turns out to be DIRTY runs no CI,
  # so arming on UNKNOWN can arm exactly the case the branch above refuses. The
  # next scheduled run sees a resolved value, so waiting costs nothing.
  elif (.mergeStateStatus // "") == "UNKNOWN"       then "SKIP mergeability-unknown"
  elif (.mergeStateStatus // "") == ""              then "SKIP mergeability-unknown"

  elif (.reviewDecision // "") == "CHANGES_REQUESTED" then "SKIP changes-requested"
  # Zero means "counted, none open"; a missing or non-numeric count means the
  # threads were never counted, which is not zero.
  elif (.unresolvedThreads | type) != "number"      then "SKIP review-threads-unknown"
  elif .unresolvedThreads > 0                       then "SKIP unresolved-threads"

  # No checks at all means the suite has not been created yet, or path filters
  # excluded everything. Either way there is nothing to stand on.
  elif ((buckets) | length) == 0                    then "SKIP no-checks"
  elif ((buckets) | any(. == "fail"))               then "SKIP failing-checks"
  elif ((buckets) | any(. == "cancel"))             then "SKIP cancelled-checks"
  elif ((buckets) | any(. == "pending"))            then "SKIP checks-in-flight"

  # Last, because it is the one refusal a fully green PR can earn: the PR
  # checks above cannot see the queue, where the browser suite runs. Unknown
  # history is a skip like any other unknown; merge-tail names the checks and
  # tells the author once, per head (see the workflow).
  elif (history_known | not)                        then "SKIP queue-history-unknown"
  elif (repeated_failures($repeat) | length) > 0    then "SKIP repeat-queue-failure"
  else "ARM"
  end
' <<<"$payload" 2>/dev/null)

if [[ -z "$verdict" ]]; then
  echo "SKIP unreadable-payload"
  exit 2
fi

echo "$verdict"
