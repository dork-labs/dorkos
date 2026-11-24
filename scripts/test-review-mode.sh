#!/usr/bin/env bash
# Fixture suite for scripts/review-mode.sh, which decides whether a run of
# .github/workflows/claude-code-review.yml is a full review or a push re-check
# (the Security lens only), and for the workflow step that runs it.
#
# The expensive mistake is a push re-check on a PR that never had a full
# review: its code would then never get the general review. So every way a
# comment can fail to count is pinned (wrong author, wrong type, a push
# re-check's own summary, the Security verdict, no tally), as is every trigger
# that is not a push.
#
#   bash scripts/test-review-mode.sh
#   SCRIPT=/path/to/other.sh bash scripts/test-review-mode.sh
#
# Needs bash and jq.
# The workflow checks match literal `${{ }}` and `$VAR` text, so single quotes are meant:
# shellcheck disable=SC2016
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=${SCRIPT:-$repo_root/scripts/review-mode.sh}
WF=$repo_root/.github/workflows/claude-code-review.yml

if ! command -v jq >/dev/null 2>&1; then
  echo "review-mode fixtures: needs jq on PATH" >&2
  exit 2
fi

pass=0
fail=0
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3" >&2
  fi
}
# decide <action> <comments json>: prints "<stdout>:<exit>"
decide() {
  local out rc
  out=$(bash "$SCRIPT" "$1" - <<<"$2" 2>/dev/null)
  rc=$?
  printf '%s:%s' "$out" "$rc"
}
cm() { # login type body
  jq -cn --arg l "$1" --arg t "$2" --arg b "$3" '{user: {login: $l, type: $t}, body: $b}'
}
CB='claude[bot]'
FULL='No blocking issues found. 0 important, 0 nits (review:light: Important findings only).'
RECHECK='Push re-check: the Security lens only. The code review is not repeated on a push (add the re-review label for one), so 0 important, 0 nits here.'
VERDICT='<!-- dorkos-security-verdict v1 head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa verdict=pass musts=0 cats=- -->
Security lens: **pass** at `aaaaaaa`, no Musts.'

# ── a push after a full review is a push re-check ────────────────────────────
check 'push + a full review summary' 'push-recheck:0' "$(decide synchronize "[$(cm "$CB" Bot "$FULL")]")"
for body in '1 important, 3 nits' '0 important, 1 nit. Scope: review:deep.' 'No blocking issues. 0 important, 0 nits.' \
  'Re-review at f895598: No blocking issues. 0 important, 0 new nits.' 'No factual issues found.' \
  'Correction to my summary above: 0 important, 1 nit.'; do
  check "push + a full summary worded '$body'" 'push-recheck:0' "$(decide synchronize "[$(cm "$CB" Bot "$body")]")"
done
check 'push + a full review and later push re-checks' 'push-recheck:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$FULL"),$(cm "$CB" Bot "$RECHECK"),$(cm "$CB" Bot "$VERDICT")]")"
check 'gh --paginate output: several arrays, the summary on page 2' 'push-recheck:0' \
  "$(decide synchronize "[$(cm someone User hi)]
[$(cm "$CB" Bot "$FULL")]")"
check 'CRLF in the body' 'push-recheck:0' "$(decide synchronize "[$(cm "$CB" Bot $'No blocking issues found.\r\n0 important')]")"

# ── a push with no full review of the reviewer's own is a full review ────────
check 'push + no comments' 'full:0' "$(decide synchronize '[]')"
check 'push + only push re-check summaries' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$RECHECK"),$(cm "$CB" Bot "$VERDICT"),$(cm "$CB" Bot "$RECHECK")]")"
check 'push + a push re-check summary with leading space' 'full:0' "$(decide synchronize "[$(cm "$CB" Bot "  $RECHECK")]")"
check 'push + only the Security verdict' 'full:0' "$(decide synchronize "[$(cm "$CB" Bot "$VERDICT")]")"
check 'push + a tally written by a person' 'full:0' "$(decide synchronize "[$(cm someone User "$FULL")]")"
check 'push + a tally from github-actions[bot]' 'full:0' "$(decide synchronize "[$(cm 'github-actions[bot]' Bot "$FULL")]")"
check 'push + a tally from another bot' 'full:0' "$(decide synchronize "[$(cm 'dorkos-merge-tail[bot]' Bot "$FULL")]")"
check 'push + the reviewer login but not a Bot' 'full:0' "$(decide synchronize "[$(cm "$CB" User "$FULL")]")"
check 'push + a login that only contains claude[bot]' 'full:0' "$(decide synchronize "[$(cm 'xclaude[bot]' Bot "$FULL")]")"
check 'push + a reviewer comment with no tally' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot 'This check is red because the review never started.')]")"
check 'push + a comment with no user' 'full:0' "$(decide synchronize '[{"body": "1 important, 3 nits"}]')"
check 'push + a comment with a null body' 'full:0' "$(decide synchronize '[{"user": {"login": "claude[bot]", "type": "Bot"}, "body": null}]')"

# ── only a push can be a push re-check ───────────────────────────────────────
for a in opened reopened ready_for_review labeled ''; do
  check "trigger '${a:-dispatch}' with a full summary on the PR" 'full:0' "$(decide "$a" "[$(cm "$CB" Bot "$FULL")]")"
done
check 'a non-push trigger does not read the comments' 'full:0' "$(decide labeled 'not json')"

# ── input that cannot be read is never a decision ────────────────────────────
check 'unparseable comments' ':2' "$(decide synchronize 'not json')"
check 'a payload that is not a list of comments' ':2' "$(decide synchronize '"a string"')"
out=$(bash "$SCRIPT" synchronize 2>/dev/null)
check 'one argument is a usage error' 2 "$?"
out=$(bash "$SCRIPT" synchronize /no/such/file 2>/dev/null)
check 'an unreadable file is a usage error' 2 "$?"
printf '[%s]\n' "$(cm "$CB" Bot "$FULL")" >"${TMPDIR:-/tmp}/review-mode-fixture.$$.json"
check 'comments from a file' push-recheck "$(bash "$SCRIPT" synchronize "${TMPDIR:-/tmp}/review-mode-fixture.$$.json")"
rm -f "${TMPDIR:-/tmp}/review-mode-fixture.$$.json"
: "$out"

# ── the tally shapes agree with the verdict probe ────────────────────────────
# A full review counts here exactly when the verdict probe in the workflow
# would accept its summary, so the two regexes must not drift apart.
probe_re=$(sed -n "s/.*grep -qE '\([^']*\)'.*/\1/p" "$WF")
mode_re=$(sed -n "s/^TALLY_RE='\([^']*\)'$/\1/p" "$SCRIPT")
check 'the verdict probe regex was found' yes "$([ -n "$probe_re" ] && echo yes || echo no)"
check 'the tally shapes are the verdict probe'"'"'s' "$probe_re" "$mode_re"

# ── the workflow side ────────────────────────────────────────────────────────
step=$(awk '/^      - name: Decide the review mode$/{on=1; print; next}
  on && /^      (- name: |# )/ {exit} on' "$WF")
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }
check 'workflow: the mode step exists' yes "$([ -n "$step" ] && echo yes || echo no)"
check 'workflow: it runs main'"'"'s copy of the script' yes \
  "$(has "$step" 'git show "origin/$DEFAULT_BRANCH:scripts/review-mode.sh"')"
check 'workflow: and never the checkout'"'"'s' no "$(has "$step" 'bash scripts/')"
check 'workflow: it reads the PR'"'"'s issue comments' yes "$(has "$step" 'repos/$REPO/issues/$PR_NUMBER/comments')"
check 'workflow: anything but the two values is full' yes \
  "$(has "$step" 'case "$mode" in push-recheck | full) ;; *) mode=full ;; esac')"
check 'workflow: the prompt carries the decided mode' yes \
  "$(has "$(cat "$WF")" 'REVIEW MODE: ${{ steps.review-mode.outputs.mode || '"'"'full'"'"' }}')"
check 'workflow: the reviewer no longer decides push mode from comments' no \
  "$(has "$(cat "$WF")" 'first look
            for your own prior summary comment')"

echo "review-mode fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
