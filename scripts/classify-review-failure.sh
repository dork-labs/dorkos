#!/usr/bin/env bash
# Explain why an automated Claude review failed, from the action's execution log.
#
# `anthropics/claude-code-action` writes every SDK message it received to
# $RUNNER_TEMP/claude-execution-output.json (a JSON array). The last `result`
# message says how the run ended. .github/workflows/claude-code-review.yml calls
# this to word its failure comment.
#
# Why this is a script with fixtures and not inline jq (DOR-457): the workflow
# used to split failures two ways and announce "ran out of its turn budget" for
# everything that was not an instant no-op — which was false for all nine of the
# failures that prompted DOR-457, and would stay false for any usage limit
# crossed mid-review. A wrong message here sends the next maintainer to the wrong
# place, so the classification is pinned by
# scripts/test-review-classifier.sh (run by `pnpm verify`) against fixtures built
# from real runs.
#
# Usage:
#   scripts/classify-review-failure.sh class    <execution-file>
#   scripts/classify-review-failure.sh reported <execution-file>
#   scripts/classify-review-failure.sh stands   <execution-file> <verdict-posted>
#
# `class` prints exactly one word:
#   no         The review never started: the run named no cause of its own, took
#              one turn or fewer, and spent nothing — so Claude never got a usable
#              model response and nothing in the PR was looked at. The cause is
#              upstream of this repo — the subscription behind
#              CLAUDE_CODE_OAUTH_TOKEN hit a usage limit, or the token is invalid.
#              This is the shape of the nine real DOR-457 failures: subtype
#              "success" with is_error:true at turn 1 for $0.
#   max_turns  The turn budget really was exhausted (subtype error_max_turns).
#   died       The run ended with an error. Either it named one itself (any
#              error_* subtype: error_during_execution, error_max_budget_usd,
#              error_max_structured_output_retries, or a future one), or it hit
#              the action's own distinct failure class — subtype "success" with
#              is_error:true, which says nothing about turns
#              (base-action/src/run-claude-sdk.ts) — after doing real work.
#   completed  The review itself finished cleanly (subtype "success",
#              is_error:false). The action marks exactly that shape a success
#              (run-claude-sdk.ts: `conclusion = subtype === "success" &&
#              !is_error`), so if the workflow is asking why a step went red the
#              failure is in the action AROUND the review, not in the review.
#   unknown    No result message, or an unreadable log: the run left no record of
#              how it ended, so nothing here explains the red check.
#
# `reported` prints the result message's own error/summary string, flattened to
# one short line, ready to embed in a public PR comment: newlines collapsed,
# backticks and token-shaped strings removed, truncated, and re-validated as
# UTF-8 so truncation cannot leave a half-written multi-byte character.
#
# Two different fields carry that string, because the SDK's two result shapes
# differ: SDKResultSuccess has `result` (a string) and SDKResultError has
# `errors` (an array) and no `result` at all. Read `result` first, fall back to
# `errors`. Without the fallback every error_* subtype — the whole `died` and
# `max_turns` space after DOR-457's re-ordering — would report nothing.
#
# `stands` answers the one question that may turn a FAILED review step into a
# GREEN check (DOR-1665): did the review finish, and is its verdict really on the
# PR? It prints `yes` only when both halves hold — the class is `completed`, and
# the caller passes the literal `yes` for <verdict-posted> having verified the
# reviewer's summary comment is there. Everything else prints `no`.
#
# Only `completed` may stand, and the distinction is the whole point. `max_turns`
# and `died` are the run stating that it ended abnormally; a summary comment may
# have landed first, but the pass was cut short, so a re-review is genuinely owed
# and the check has to keep saying so. `completed` is the opposite shape: the
# review's own result message says it ended cleanly and the action failed AROUND
# it. That is the shipped case — after a run ends, the action re-checks
# `num_turns` against `--max-turns` and throws if a clean run overshot
# (base-action/src/run-claude-sdk.ts), which on PR #1409 turned a finished review
# that had already posted "0 important, 1 nit" into a red check for being two
# turns over a cap of 50.
#
# `yes` is deliberately the only accepted <verdict-posted> value, and an
# unreadable log is deliberately `no`. Every way of getting this wrong therefore
# lands on the OLD behaviour — a red check — rather than on a green one nobody
# verified. A green check with no review posted is a failure mode this repo has
# actually had, so it must not be reachable by a typo.

set -uo pipefail

usage() {
  echo "usage: $(basename "$0") class|reported <execution-file>" >&2
  echo "       $(basename "$0") stands <execution-file> <verdict-posted>" >&2
  exit 2
}

mode=${1:-}
file=${2:-}
verdict=${3:-}
[ -n "$mode" ] && [ -n "$file" ] || usage

# Take the LAST result message: a run that retries can emit more than one, and
# the final one is how it actually ended.
#
# ORDER IS THE WHOLE POINT. Every branch that reads an explicit `subtype` comes
# before the turns/spend heuristic, because a subtype is the run stating its own
# cause while the heuristic is this script guessing at one. Guessing first is
# what produced DOR-457's false claims — twice. Round 1 read turns and spend
# only, so a usage limit crossed at turn 20 was announced as an exhausted turn
# budget. Round 2 read `subtype` but still ran the heuristic ahead of the
# catch-all, so `error_during_execution` at turn 1 for $0 — an MCP server that
# failed to start — was announced as a credentials-or-quota problem and sent the
# maintainer to rotate a working token.
#
# `error_max_turns` is matched before the generic `error_*` arm because it is the
# one error subtype with a message of its own.
readonly CLASS_PROGRAM='
  [.[]? | select(.type == "result")] | last
  | if . == null then "unknown"
    elif (.subtype == "success" and ((.is_error // false) | not)) then "completed"
    elif .subtype == "error_max_turns" then "max_turns"
    elif ((.subtype // "") | startswith("error_")) then "died"
    elif ((.num_turns // 0) <= 1 and (.total_cost_usd // 0) == 0) then "no"
    else "died"
    end
'

# One code path for the class, so `class` and `stands` can never disagree about
# how a run ended. Anything unexpected (empty output, a jq error, a hand-edited
# log, a log the action never got round to writing) is `unknown`, whose comment
# points at the Actions log instead of guessing — and which `stands` refuses.
classify() {
  local class=unknown
  if [ -f "$1" ]; then
    class=$(jq -r "$CLASS_PROGRAM" "$1" 2>/dev/null) || class=unknown
  fi
  case "$class" in
    no | max_turns | died | completed | unknown) ;;
    *) class=unknown ;;
  esac
  printf '%s\n' "$class"
}

# `.result` (SDKResultSuccess) or `.errors` (SDKResultError) — see the header.
# `$r` is a jq variable, not a shell one, so the single quotes are the point.
# shellcheck disable=SC2016
readonly REPORTED_PROGRAM='
  [.[]? | select(.type == "result")] | last
  | if . == null then ""
    else
      ((.result // "") | tostring) as $r
      | if $r != "" then $r
        else ((.errors // []) | map(tostring) | join("; "))
        end
    end
'

case "$mode" in
  class)
    classify "$file"
    ;;
  stands)
    # Both halves, and nothing less. The literal `yes` is the caller's assertion
    # that it went and looked for the verdict on the PR; `completed` is the run's
    # own statement that it finished. A missing argument, a `true`, a `YES`, an
    # unreadable log or any other class all fall through to `no`, which is the
    # red check this repo had before DOR-1665 — the safe direction.
    if [ "$verdict" = yes ] && [ "$(classify "$file")" = completed ]; then
      echo yes
    else
      echo no
    fi
    ;;
  reported)
    [ -f "$file" ] || exit 0
    # The string is model/API text going into a public comment, so: no newlines
    # (they would break the log annotation), no backticks (they would break out
    # of the comment's code fence), no token-shaped substrings, and a cap short
    # enough to stay one line.
    #
    # LC_ALL=C makes every filter byte-wise, so the cap means the same thing on
    # a maintainer's macOS as on ubuntu-latest — BSD `cut -c` counts characters
    # while GNU's counts bytes, which would otherwise put the truncation point in
    # two different places. `cut -b` (not `head -c`) because `head` closes the
    # pipe early, and SIGPIPE upstream plus `pipefail` would fail this script.
    # `iconv -c` then drops a multi-byte character the cut split in half.
    LC_ALL=C jq -r "$REPORTED_PROGRAM" "$file" 2>/dev/null \
      | LC_ALL=C tr '\n\r\t' '   ' \
      | LC_ALL=C tr -d '`' \
      | LC_ALL=C sed -E 's/(sk-ant-|ghs_|ghp_|gho_|ghu_|ghr_|github_pat_)[A-Za-z0-9_-]{4,}/[redacted]/g' \
      | LC_ALL=C tr -s ' ' \
      | LC_ALL=C cut -b1-120 \
      | iconv -c -f utf-8 -t utf-8 \
      | LC_ALL=C sed -E 's/^ +//; s/ +$//'
    ;;
  *) usage ;;
esac
