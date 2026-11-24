#!/usr/bin/env bash
# review-redispatch-wait.sh — how long to wait, after a review failed, before
# review-redispatch.yml asks whether to re-request it.
#
#   scripts/review-redispatch-wait.sh <runs.json>
#
# review-redispatch.yml runs on `workflow_run` when a claude-code-review run
# fails, as well as on its cron (which GitHub fires a few times a day here, not
# every 10 minutes: ledger 261124-161126). The retry ladder in
# scripts/should-redispatch-review.sh refuses a retry until a rung has passed
# since the newest attempt (10, 20, then 40 minutes), so a scan right after the
# failure would always answer `SKIP backoff`. This prints the whole seconds
# from NOW until that rung has passed, plus MARGIN_SECONDS (60), so the scan
# lands just after it. It reads the rungs and the attempt ceiling from
# should-redispatch-review.sh, so the two cannot disagree.
#
# <runs.json> is every claude-code-review run for the PR's head SHA, as the
# workflow reads it: [{id, status, conclusion, run_attempt, updated_at}].
# Attempts are counted the ladder's way: skipped and cancelled runs are not
# attempts, a re-run adds its run_attempt. Prints 0 when there is nothing to
# wait for (a run in flight, the ceiling reached, or the rung already passed),
# and never more than MAX_WAIT_SECONDS (2700, 45 minutes). The quota rung
# (hours) is not waited for here; the cron and later reviews cover it.
# An unreadable file prints FALLBACK_SECONDS (660: the first rung plus margin).
#
# NOW (ISO 8601 UTC) overrides the clock. Exit codes: 0 a number was printed;
# 2 usage, or the ladder's constants could not be read.
#
# Fixtures: scripts/test-review-redispatch-wait.sh.
set -uo pipefail

LADDER=${LADDER:-$(dirname "${BASH_SOURCE[0]}")/should-redispatch-review.sh}
MARGIN_SECONDS=60
MAX_WAIT_SECONDS=2700
FALLBACK_SECONDS=660

[ $# -eq 1 ] || {
  sed -n '5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

backoff=$(sed -n "s/^BACKOFF_MINUTES='\(.*\)'$/\1/p" "$LADDER" 2>/dev/null)
maxruns=$(sed -n 's/^MAX_RUNS=\([0-9][0-9]*\)$/\1/p' "$LADDER" 2>/dev/null)
jq -e 'type == "array" and length > 0 and all(type == "number")' <<<"${backoff:-x}" >/dev/null 2>&1 ||
  { echo "review-redispatch-wait: no BACKOFF_MINUTES in $LADDER" >&2; exit 2; }
[[ "${maxruns:-}" =~ ^[0-9]+$ ]] || { echo "review-redispatch-wait: no MAX_RUNS in $LADDER" >&2; exit 2; }

now=${NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
secs=$(jq -r --arg now "$now" --argjson backoff "$backoff" --argjson maxruns "$maxruns" \
  --argjson margin "$MARGIN_SECONDS" --argjson cap "$MAX_WAIT_SECONDS" '
  def t: try fromdateiso8601 catch null;
  if type != "array" then error("not an array") else . end
  | [.[] | select(((.conclusion // "") | ascii_downcase) | (. == "skipped" or . == "cancelled") | not)] as $runs
  | ([$runs[] | (.run_attempt // 1) | if type == "number" then . else 1 end] | add // 0) as $attempts
  | ([$runs[] | (.updated_at // "") | t | select(. != null)] | max) as $last
  | ($now | t) as $n
  | if any(.[]; (.status // "") != "completed") then 0
    elif $attempts == 0 or $attempts >= $maxruns then 0
    elif $last == null or $n == null then error("no time")
    else ($last + 60 * ($backoff[$attempts - 1] // ($backoff | last)) + $margin - $n)
      | floor | if . < 0 then 0 elif . > $cap then $cap else . end
    end' "$1" 2>/dev/null) || secs=''
[[ "$secs" =~ ^[0-9]+$ ]] || secs=$FALLBACK_SECONDS
echo "$secs"
