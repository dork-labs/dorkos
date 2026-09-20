#!/usr/bin/env bash
# Decide whether one pull request should have its automated Claude review
# re-requested.
#
# WHY THIS EXISTS. `review-completes` — "the automated review finishes the first
# time" (ci/slos.yaml) — reads 88.5% against a 90% floor, and the reason it never
# recovers is that NOTHING ever asks again. A review that dies of an
# infrastructure failure leaves a red `claude-code-review` check, merge-tail
# refuses to arm the PR, and the PR waits for a person to notice and apply the
# `re-review` label. Over 30 days, 14 of 779 merged PRs (1.8%) merged with a red
# review notice and no second attempt, and another 24 died on the turn budget
# (research/20260919_ci-pipeline-supporting/07-claude-review-effectiveness.md
# §1, §6). `review-recovery` — p90 time from a failed review to the next
# completed one — was never measured at all, because there were no retries to
# measure.
#
# .github/workflows/merge-tail.yml asks again, and this script is the decision.
# It is a separate script with fixtures, like the arming decision beside it, for
# the same reason: the expensive mistake is not a crash but a wrong RETRY, and a
# wrong RETRY is invisible. It spends the operator's Claude subscription — the
# same subscription the agents writing this repo's code draw on — so every
# branch that refuses is pinned by scripts/test-should-redispatch-review.sh.
#
# THE MECHANISM IS THE `re-review` LABEL, not a workflow dispatch, and that is a
# deliberate choice rather than a shortcut. Dispatching
# claude-code-review.yml would need `actions: write`, which the merge-tail app
# does not hold; GITHUB_TOKEN cannot substitute, because GitHub creates NO
# workflow run for an event its own token triggered. Labelling needs only the
# `pull-requests: write` the app already has, reuses the button a person would
# press, and the review workflow clears the label afterwards so the button pops
# back up. The cost is that the resulting run's ACTOR is the merge-tail app, so
# that app has to be in the review workflow's `allowed_bots`.
#
# THE BACKOFF IS A MINIMUM, NEVER A SCHEDULE. plans/ci-steward-plan.md §5.3 asks
# for 10, 20, 40 minutes up to two hours. Those numbers are here, but GitHub
# throttles scheduled workflows hard: over 200 merge-tail runs (2026-08-25 to
# 09-19) the MEDIAN gap between ticks was 162 minutes, p90 305, max 748. So a
# "10 minute" backoff means "not before 10 minutes", and in practice the first
# retry usually lands hours later. Do not write "retries within 10 minutes"
# anywhere; it is not true and never was. What the backoff actually buys is that
# a systematic failure (a revoked token, a spent weekly window) cannot burn the
# ceiling in three consecutive ticks.
#
# Usage:
#   scripts/should-redispatch-review.sh <pr.json>
#   ... | scripts/should-redispatch-review.sh -
#
# Prints exactly one line:
#   RETRY             apply the `re-review` label to this PR
#   SKIP <reason>     leave it alone; <reason> is a stable machine-readable slug
#
# Exit status is 0 for a readable verdict and 2 only when the input could not be
# parsed, so a malformed payload can never be mistaken for a quiet SKIP that
# something later treats as "checked, nothing to do".
#
# Expected input (a superset is fine; unknown keys are ignored):
#   {
#     "number": 537,
#     "state": "OPEN",
#     "isDraft": false,
#     "labels": [{"name": "re-review"}],
#     "files": [{"path": ".github/workflows/claude-code-review.yml"}],
#     "checks": [{"name": "claude-code-review", "bucket": "fail"}],
#     "reviewRuns": [{"status": "completed", "conclusion": "failure",
#                     "updated_at": "2026-09-20T11:00:00Z"}],
#     "now": "2026-09-20T12:00:00Z"
#   }
#
# `reviewRuns` is every claude-code-review run for THIS PR's CURRENT head SHA,
# newest or oldest order, it does not matter. The head SHA is what makes the
# attempt count mean something: a new push is new code and starts its own ladder,
# which is the same unit `review-completes` is keyed by.
#
# `now` is passed in rather than read from the clock so the fixtures can pin the
# backoff. A missing or unparseable `now` is a SKIP, never an implicit "now".

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

# The name of the review check as it appears in `gh pr checks`, and the workflow
# file a PR cannot get reviewed while it edits.
#
# THE CHECK IS CALLED `review`, NOT `claude-code-review`. GitHub names a check
# run after the JOB, not the workflow, and that workflow's one job is `review:`
# with no `name:` override — verified against PR #1936, whose check list has
# `review` and no `claude-code-review` in it. Getting this wrong is a silent
# total no-op: the gate would match no check, report `no-review-check` for every
# PR forever, and look exactly like a repo where no review ever fails. Both
# constants are pinned by scripts/test-should-redispatch-review.sh against the
# workflow itself.
REVIEW_CHECK='review'
REVIEW_WORKFLOW='.github/workflows/claude-code-review.yml'

# Attempt n has already happened; wait this many minutes before asking for n+1.
# Doubling from 10, capped at 120 (plan §5.3). The ceiling below stops the ladder
# before the cap is ever reached, so the cap is there for the day someone raises
# the ceiling and forgets to think about the tail.
BACKOFF_MINUTES='[10,20,40,80,120]'

# A ceiling on runs per head SHA, not on retries, because runs are what the API
# reports and what costs money: 4 runs is the first review plus three retries.
MAX_RUNS=4

verdict=$(jq -r \
  --arg check "$REVIEW_CHECK" \
  --arg wf "$REVIEW_WORKFLOW" \
  --argjson backoff "$BACKOFF_MINUTES" \
  --argjson maxruns "$MAX_RUNS" '
  # gh emits labels as objects; some callers pass bare strings. Indexing a
  # string with .name is a jq error rather than a null, which would turn the
  # whole gate into unreadable-payload.
  def labels: [(.labels // [])[]
               | (if type == "object" then (.name // "") else tostring end)
               | ascii_downcase];
  def paths:  [(.files // [])[]
               | (if type == "object" then (.path // "") else tostring end)];
  def review_buckets: [(.checks // [])[]
                       | select(((.name // "") | ascii_downcase) == $check)
                       | (.bucket // "") | ascii_downcase];
  def runs: (.reviewRuns // []);
  def parse_time: (try (. | fromdateiso8601) catch null);
  def now_t: ((.now // "") | parse_time);
  # The newest completed run decides when the clock started. `null` propagates
  # out of max_by on an empty list, and every branch below treats null as
  # "cannot tell", which is a SKIP.
  def last_end: ([runs[] | (.updated_at // "") | parse_time | select(. != null)] | max);

  if (.state // "") != "OPEN"                         then "SKIP not-open"
  elif (.isDraft // false)                            then "SKIP draft"

  # The button is already down. Asking again would be a no-op at best, and at
  # worst it races the review workflow clearing the label.
  elif ((labels) | index("re-review")) != null        then "SKIP already-requested"

  # The author opted out. A retry loop must not be a way around that.
  elif ((labels) | index("skip-review")) != null      then "SKIP skip-review"

  # A PR that edits the review workflow CANNOT be reviewed by it: the action
  # refuses to start when the running workflow differs from the copy on the
  # default branch, an anti-exfiltration guard (see the KNOWN LIMITATION note in
  # the review workflow header). Retrying
  # is guaranteed futile, and three futile retries means three more misleading
  # red comments on the PR least able to act on them.
  elif ((paths) | index($wf)) != null                 then "SKIP edits-review-workflow"

  # No review check on this head at all. That is the conflicted-PR blind spot
  # (GitHub builds no run of any kind while a PR conflicts with its base), and a
  # label event produces no run either, so labelling would not help. Rebasing is
  # the fix and only a person or the author can do it.
  elif ((review_buckets) | length) == 0               then "SKIP no-review-check"
  elif ((review_buckets) | any(. == "pass"))          then "SKIP review-green"
  elif ((review_buckets) | any(. == "pending"))       then "SKIP review-in-flight"
  elif ((review_buckets) | any(. == "fail") | not)    then "SKIP review-not-failed"

  # An unfinished run on this SHA means a review is already happening; the check
  # bucket can lag behind it by a minute or two.
  elif (runs | any((.status // "") != "completed"))   then "SKIP run-in-flight"

  elif (runs | length) == 0                           then "SKIP no-runs"
  elif (runs | length) >= $maxruns                    then "SKIP retry-ceiling"
  elif (now_t == null or last_end == null)            then "SKIP unreadable-time"

  # Elapsed minutes since the newest completed run, against the step of the
  # ladder that the attempt count picks: one run so far waits 10 minutes, two
  # wait 20, three wait 40. A shorter elapsed time is a SKIP, so the wait is a
  # floor. `// ($backoff | last)` covers a ceiling raised past the end of the
  # ladder, which would otherwise index past it and yield null — and a null
  # comparison in jq is not an error, it is `true`, i.e. retry immediately.
  elif (((now_t - last_end) / 60)
        < ($backoff[(runs | length) - 1] // ($backoff | last)))
                                                      then "SKIP backoff"
  else "RETRY"
  end
' <<<"$payload" 2>/dev/null)

if [[ -z "$verdict" ]]; then
  echo "SKIP unreadable-payload"
  exit 2
fi

echo "$verdict"
