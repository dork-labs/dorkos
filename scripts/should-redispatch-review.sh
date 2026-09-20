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
# THE BACKOFF IS INERT TODAY, AND SAYING SO IS THE POINT.
# plans/ci-steward-plan.md §5.3 asks for 10, 20, 40 minutes up to two hours, and
# those numbers are here — but every rung is shorter than one tick. GitHub
# throttles scheduled workflows hard: over 200 merge-tail runs (2026-08-25 to
# 09-19) the MEDIAN gap between ticks was 162 minutes, p90 305, max 748. So the
# longest rung, 40 minutes, has always elapsed by the time anything asks, and
# `SKIP backoff` will essentially never fire. Do not describe this as "retries
# after 10 minutes"; it is a FLOOR, and on today's trigger it is not a binding
# one.
#
# WHAT THAT MEANS FOR THE THING THE BACKOFF WAS SUPPOSED TO STOP — a systematic
# failure burning every PR's ceiling in three consecutive ticks. The backoff does
# not stop it, so two other limiters do:
#   * MAX_RUNS, which bounds the damage per head SHA at three retries; and
#   * the quota rung below, which holds off a retry for roughly the length of the
#     window the last attempt died against. A spent weekly window is the exact
#     case where the ladder would otherwise spend three runs and post three more
#     red comments on every open PR, none of which could have succeeded. It is a
#     rung and not a terminus, and that distinction is load-bearing: see
#     QUOTA_WAIT_MINUTES.
# The rungs become meaningful the day this runs on an event rather than a cron;
# ledger 260919-204500 proposes exactly that trigger.
#
# Usage:
#   scripts/should-redispatch-review.sh <pr.json>
#   ... | scripts/should-redispatch-review.sh -
#
# Prints exactly one line:
#   RETRY             apply the `re-review` label to this PR
#   CLEAR <reason>    REMOVE a `re-review` label that can never be cleared by a
#                     run, because no run will ever happen (see the DIRTY arm)
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
#     "mergeStateStatus": "CLEAN",
#     "labels": [{"name": "re-review"}],
#     "files": [{"path": ".github/workflows/claude-code-review.yml"}],
#     "checks": [{"name": "review", "bucket": "fail"}],
#     "reviewRuns": [{"status": "completed", "conclusion": "failure",
#                     "updated_at": "2026-09-20T11:00:00Z"}],
#     "reviewClass": "turn_budget",
#     "now": "2026-09-20T12:00:00Z"
#   }
#
# `reviewRuns` is every claude-code-review run for THIS PR's CURRENT head SHA,
# newest or oldest order, it does not matter. The head SHA is what makes the
# attempt count mean something: a new push is new code and starts its own ladder,
# which is the same unit `review-completes` is keyed by. `conclusion` is read,
# not decoration: a `skipped` or `cancelled` run never reviewed anything and must
# not count against the ceiling (see `def runs`).
#
# `reviewClass` is the newest attempt's `review-outcome-class`, as the review
# workflow records it. Only the `quota_*` values change anything; everything
# else, including an absent value, leaves the ladder to decide.
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

# A ceiling on ATTEMPTS per head SHA, not on retries: 4 attempts is the first
# review plus three retries. An attempt is a run that tried to review, counted
# by `run_attempt` rather than by row, because GitHub REUSES a run id when a run
# is re-run by hand — three hand re-runs are three reviews that spent three
# slices of the subscription and one row in the API response.
MAX_RUNS=4

# HOW LONG A SPENT SUBSCRIPTION WINDOW IS A REASON TO WAIT, in minutes, keyed by
# the window the run named. This is a RUNG, NOT A TERMINUS, and the distinction
# is the whole point: a quota stall that never retried again would strand every
# open PR at once for the duration of a subscription outage and leave a person
# pressing the button by hand, which is the exact failure this gate exists to
# remove.
#   session 300  The 5-hour window, plus nothing. Waiting slightly past a reset
#                costs one tick; retrying before it costs a wasted run and a red
#                comment. 300 is the window itself because the clock starts at
#                the FAILED RUN, which is at or after the moment the window was
#                already spent — so the true remaining wait is always shorter
#                than 300, never longer.
#   weekly  360  Six hours, which is plan §5.3's default hold for a weekly
#                limit. A weekly window can be days from resetting and no wait
#                this gate could pick would cover it, so the honest design is a
#                short-ish rung plus the attempt ceiling: at most three more
#                runs per head SHA for the whole outage, each of which also
#                re-reads the class and re-arms the wait.
#   unknown 300  A limit that did not name its window. Treated as the shorter
#                one on purpose: under-waiting costs a wasted run bounded by the
#                ceiling, over-waiting strands the PR.
# NOT YET USED, and worth knowing: the SDK's own error string carries the reset
# time — `Claude AI usage limit reached|<epoch>` — so a later change can make
# this wait exact instead of nominal. It would have to travel through the
# outcome-class annotation, which today carries only the class.
QUOTA_WAIT_MINUTES='{"session":300,"weekly":360,"unknown":300}'

verdict=$(jq -r \
  --arg check "$REVIEW_CHECK" \
  --arg wf "$REVIEW_WORKFLOW" \
  --argjson backoff "$BACKOFF_MINUTES" \
  --argjson maxruns "$MAX_RUNS" \
  --argjson quotawait "$QUOTA_WAIT_MINUTES" '
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
  # ATTEMPTS, NOT RUNS, and the difference is the whole ceiling. Over 30 days
  # this workflow logged 519 SKIPPED and 258 CANCELLED review runs against 740
  # successes: the skipped ones are label events that never reviewed, and the
  # cancelled ones are the concurrency dedupe doing its job. Counting either
  # against the ladder means a PR opened with two labels arrives with three runs
  # on its head SHA and gets ONE retry instead of three — or none, once a
  # cancellation is in the mix. The collector for this very metric already draws
  # the same line (`packages/ci-steward/src/series.ts`: skipped runs are filtered
  # out of the population and a cancelled first run is counted separately).
  #
  # A run still in flight has a null conclusion and is therefore an attempt,
  # which is correct: `run-in-flight` below refuses on it before the ladder is
  # ever consulted, and it uses `all_runs` so that an in-flight run destined to
  # skip still blocks a retry that would race it.
  def all_runs: (.reviewRuns // []);
  def runs: [all_runs[]
             | select(((.conclusion // "") | ascii_downcase)
                      | (. == "skipped" or . == "cancelled") | not)];
  def parse_time: (try (. | fromdateiso8601) catch null);
  def now_t: ((.now // "") | parse_time);
  # The newest completed run decides when the clock started. `null` propagates
  # out of max_by on an empty list, and every branch below treats null as
  # "cannot tell", which is a SKIP.
  def last_end: ([runs[] | (.updated_at // "") | parse_time | select(. != null)] | max);
  # Minutes since the newest attempt ended. Only ever evaluated after the
  # null-time arm below, because jq errors on `null - number` rather than
  # returning null.
  def elapsed: ((now_t - last_end) / 60);
  # Attempts, counted by `run_attempt` (default 1) rather than by row: GitHub
  # reuses a run id when a run is re-run, so three hand re-runs are one row and
  # three reviews. Under-counting would quietly hand out more retries than the
  # ceiling says.
  def attempts: ([runs[] | ((.run_attempt // 1) | if type == "number" then . else 1 end)] | add // 0);
  # "session", "weekly", "unknown" — or null when the newest attempt did not die
  # against the subscription at all.
  def quota_window: ((.reviewClass // "") | ascii_downcase
                     | if startswith("quota_") then .[6:] else null end);

  if (.state // "") != "OPEN"                         then "SKIP not-open"
  elif (.isDraft // false)                            then "SKIP draft"

  # A CONFLICTING PR STRANDS THE BUTTON, so it gets its own arm above every
  # other one. GitHub builds the test-merge ref of a PR before it creates any
  # `pull_request` workflow run, and when the branch conflicts that ref cannot
  # be built, so labelling produces NO RUN AT ALL — not a failed one, nothing.
  # The review workflow clears `re-review` from inside a run, so a label applied
  # to a conflicting PR is never cleared and the human button stays pressed
  # down: the author fixes the conflict, wants a review, applies a label that is
  # already there, and nothing happens. Meanwhile the stale red review check
  # from before the conflict is still showing, so the gate would keep saying
  # RETRY. Both halves have to be handled, in this order.
  elif ((.mergeStateStatus // "") | ascii_upcase) == "DIRTY"
    then (if ((labels) | index("re-review")) != null
          then "CLEAR stranded-label"
          else "SKIP conflicting" end)

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
  elif (all_runs | any((.status // "") != "completed")) then "SKIP run-in-flight"

  elif (runs | length) == 0                           then "SKIP no-runs"

  # Time has to be readable before anything below can weigh it, so this moved
  # above the ceiling: every remaining arm is a comparison against the clock.
  elif (now_t == null or last_end == null)            then "SKIP unreadable-time"

  # THE LAST ATTEMPT DIED AGAINST THE SUBSCRIPTION, NOT AGAINST THIS REPO — so
  # wait out the window and then ask again. Retrying immediately spends another
  # slice of the same spent quota, fails the same way and posts another red
  # comment, three times per PR across every open PR. But refusing FOREVER is
  # worse than that and was this gate shipped wrong once: the class is
  # immutable, only this gate creates new attempts, so an unconditional skip
  # means the 5-hour window reopens and nothing ever notices. Every open PR
  # would lose its ladder at once for a whole outage, and the only exit would be
  # a human pressing the button — which is what this exists to remove.
  #
  # The class comes from the `review-outcome-class` annotation of the newest
  # ATTEMPT, derived from the error fields of the SDK result message and never
  # from model prose (scripts/classify-review-failure.sh). An absent or
  # unreadable class is empty, which matches nothing, so the ladder proceeds:
  # the safe direction is one wasted run, not a stalled gate.
  elif ((quota_window) != null
        and (elapsed < ($quotawait[quota_window] // ($quotawait.unknown))))
                                                      then "SKIP quota"

  elif (attempts) >= $maxruns                         then "SKIP retry-ceiling"

  # Elapsed minutes since the newest attempt, against the step of the ladder
  # that the attempt count picks: one attempt so far waits 10 minutes, two wait
  # 20, three wait 40. A shorter elapsed time is a SKIP, so the wait is a floor.
  # `// ($backoff | last)` covers a ceiling raised past the end of the ladder,
  # which would otherwise index past it and yield null — and a null comparison
  # in jq is not an error, it is `true`, i.e. retry immediately.
  elif (elapsed < ($backoff[(attempts) - 1] // ($backoff | last)))
                                                      then "SKIP backoff"
  else "RETRY"
  end
' <<<"$payload" 2>/dev/null)

if [[ -z "$verdict" ]]; then
  echo "SKIP unreadable-payload"
  exit 2
fi

echo "$verdict"
