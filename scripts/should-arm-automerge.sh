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
#
# Prints exactly one line:
#   ARM               arm auto-merge on this PR
#   SKIP <reason>     leave it alone; <reason> is a stable machine-readable slug
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
#     "reviewDecision": "APPROVED",
#     "labels": [{"name": "hold"}],
#     "unresolvedThreads": 0,
#     "checks": [{"name": "typecheck", "bucket": "pass"}]
#   }
#
# `bucket` follows `gh pr checks --json bucket`: pass | fail | pending | skipping | cancel.

set -uo pipefail

src=${1:-}
if [[ -z "$src" ]]; then
  echo "usage: $0 <pr.json>|-" >&2
  exit 2
fi
if [[ "$src" == "-" ]]; then payload=$(cat); else payload=$(cat "$src" 2>/dev/null); fi

if ! jq -e . >/dev/null 2>&1 <<<"$payload"; then
  echo "SKIP unreadable-payload"
  exit 2
fi

# Labels that mean "a human is not done with this yet". Checked before anything
# else that could look green, so a hold always wins.
HOLD_LABELS='["hold","do-not-merge","do not merge","wip","blocked"]'

verdict=$(jq -r --argjson hold "$HOLD_LABELS" '
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
  elif ((.unresolvedThreads // 0) | tonumber) > 0   then "SKIP unresolved-threads"

  # No checks at all means the suite has not been created yet, or path filters
  # excluded everything. Either way there is nothing to stand on.
  elif ((buckets) | length) == 0                    then "SKIP no-checks"
  elif ((buckets) | any(. == "fail"))               then "SKIP failing-checks"
  elif ((buckets) | any(. == "cancel"))             then "SKIP cancelled-checks"
  elif ((buckets) | any(. == "pending"))            then "SKIP checks-in-flight"
  else "ARM"
  end
' <<<"$payload" 2>/dev/null)

if [[ -z "$verdict" ]]; then
  echo "SKIP unreadable-payload"
  exit 2
fi

echo "$verdict"
