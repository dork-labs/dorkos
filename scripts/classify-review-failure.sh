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
#
# `class` prints exactly one word:
#   no         The review never started: one turn or fewer and zero spend, so
#              Claude never got a usable model response and nothing in the PR was
#              looked at. The cause is upstream of this repo — the subscription
#              behind CLAUDE_CODE_OAUTH_TOKEN hit a usage limit, or the token is
#              invalid.
#   max_turns  The turn budget really was exhausted (subtype error_max_turns).
#   died       The run did real work and then errored partway through. Covers the
#              action's own distinct failure class — subtype "success" with
#              is_error:true, which says nothing about turns
#              (base-action/src/run-claude-sdk.ts) — plus error_during_execution
#              and every other error subtype.
#   unknown    No result message, an unreadable log, or a result that reports
#              clean success: nothing here explains the red check.
#
# `reported` prints the result message's own error/summary string, flattened to
# one short line, ready to embed in a public PR comment: newlines collapsed,
# backticks and token-shaped strings removed, truncated, and re-validated as
# UTF-8 so truncation cannot leave a half-written multi-byte character.

set -uo pipefail

usage() {
  echo "usage: $(basename "$0") class|reported <execution-file>" >&2
  exit 2
}

mode=${1:-}
file=${2:-}
[ -n "$mode" ] && [ -n "$file" ] || usage

# Take the LAST result message: a run that retries can emit more than one, and
# the final one is how it actually ended. Order matters below — `subtype` is the
# field that says why the run died, so it is read before any heuristic. Reading
# turns/cost first is what produced DOR-457's false turn-budget claim.
readonly CLASS_PROGRAM='
  [.[]? | select(.type == "result")] | last
  | if . == null then "unknown"
    elif (.subtype == "success" and ((.is_error // false) | not)) then "unknown"
    elif .subtype == "error_max_turns" then "max_turns"
    elif ((.num_turns // 0) <= 1 and (.total_cost_usd // 0) == 0) then "no"
    else "died"
    end
'

readonly REPORTED_PROGRAM='
  [.[]? | select(.type == "result")] | last | .result // ""
'

case "$mode" in
  class)
    class=unknown
    if [ -f "$file" ]; then
      class=$(jq -r "$CLASS_PROGRAM" "$file" 2>/dev/null) || class=unknown
    fi
    # Anything unexpected (empty output, a jq error, a hand-edited log) reports
    # `unknown`, whose comment points at the Actions log instead of guessing.
    case "$class" in
      no | max_turns | died | unknown) ;;
      *) class=unknown ;;
    esac
    echo "$class"
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
