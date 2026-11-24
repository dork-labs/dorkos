#!/usr/bin/env bash
# Fixture suite for scripts/review-mode.sh, which decides whether a run of
# .github/workflows/claude-code-review.yml is a full review or a push re-check
# (the Security lens only), and for the workflow step that runs it.
#
# The expensive mistake is a push re-check on a PR that never had a full
# review: its code would then never get the general review. So every way a
# comment can fail to count is pinned (wrong author, wrong type, no marker or a
# marker that is not mode=full, an unmarked comment after the transition
# cutoff, a push re-check's own summary, the Security verdict), as is every
# trigger that is not a push.
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
cm() { # login type body [created_at]
  jq -cn --arg l "$1" --arg t "$2" --arg b "$3" --arg c "${4:-$NEW}" \
    '{user: {login: $l, type: $t}, body: $b, created_at: $c}'
}
CB='claude[bot]'
OLD='2026-11-24T12:00:00Z' # before the transition cutoff
NEW='2026-11-26T12:00:00Z' # after it
H=0123456789abcdef0123456789abcdef01234567
mark() { printf '<!-- dorkos-review-summary v1 head=%s mode=%s -->' "$H" "$1"; }
FULL='No blocking issues found. 0 important, 0 nits (review:light: Important findings only).'
RECHECK='Push re-check: the Security lens only. The code review is not repeated on a push (add the re-review label for one), so 0 important, 0 nits here.'
MFULL="$FULL

$(mark full)"
MRECHECK="$RECHECK

$(mark push-recheck)"
VERDICT='<!-- dorkos-security-verdict v1 head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa verdict=pass musts=0 cats=- -->
Security lens: **pass** at `aaaaaaa`, no Musts.'

# ── a push after a marked full review is a push re-check ─────────────────────
check 'push + a marked full summary' 'push-recheck:0' "$(decide synchronize "[$(cm "$CB" Bot "$MFULL")]")"
check 'push + a marked full summary with no tally in its text' 'push-recheck:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "Reviewed.

$(mark full)")]")"
check 'push + a marked full summary followed by blank lines' 'push-recheck:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$MFULL"$'\n\n')]")"
check 'push + a marked full review and later marked push re-checks' 'push-recheck:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$MFULL"),$(cm "$CB" Bot "$MRECHECK"),$(cm "$CB" Bot "$VERDICT")]")"
check 'gh --paginate output: several arrays, the summary on page 2' 'push-recheck:0' \
  "$(decide synchronize "[$(cm someone User hi)]
[$(cm "$CB" Bot "$MFULL")]")"
check 'CRLF in the body' 'push-recheck:0' \
  "$(decide synchronize "[$(cm "$CB" Bot $'0 important\r\n\r\n'"$(mark full)"$'\r\n')]")"

# ── a push with no marked full review of the reviewer's own is a full review ─
check 'push + no comments' 'full:0' "$(decide synchronize '[]')"
check 'push + only marked push re-check summaries' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$MRECHECK"),$(cm "$CB" Bot "$VERDICT"),$(cm "$CB" Bot "$MRECHECK")]")"
check 'push + a summary marked mode=unknown' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$FULL

$(mark unknown)")]")"
check 'push + an unmarked tally by claude[bot] after the cutoff (an @claude reply)' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$FULL")]")"
check 'push + an unmarked tally with no created_at' 'full:0' \
  "$(decide synchronize "[$(jq -cn --arg b "$FULL" '{user: {login: "claude[bot]", type: "Bot"}, body: $b}')]")"
check 'push + the marker not on the last line' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$(mark full)
Reviewed, 0 important.")]")"
check 'push + the marker inside a longer last line' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "Reviewed, 0 important. $(mark full)")]")"
check 'push + a marker with a short head' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot '0 important
<!-- dorkos-review-summary v1 head=0123456 mode=full -->')]")"
check 'push + a marker of another version' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "0 important
<!-- dorkos-review-summary v2 head=$H mode=full -->")]")"
check 'push + a marked full summary by a person' 'full:0' "$(decide synchronize "[$(cm someone User "$MFULL")]")"
check 'push + a marked full summary from github-actions[bot]' 'full:0' \
  "$(decide synchronize "[$(cm 'github-actions[bot]' Bot "$MFULL")]")"
check 'push + a marked full summary from another bot' 'full:0' \
  "$(decide synchronize "[$(cm 'dorkos-merge-tail[bot]' Bot "$MFULL")]")"
check 'push + the reviewer login but not a Bot' 'full:0' "$(decide synchronize "[$(cm "$CB" User "$MFULL")]")"
check 'push + a login that only contains claude[bot]' 'full:0' "$(decide synchronize "[$(cm 'xclaude[bot]' Bot "$MFULL")]")"
check 'push + a comment with no user' 'full:0' "$(decide synchronize "[$(jq -cn --arg b "$MFULL" '{body: $b}')]")"
check 'push + a comment with a null body' 'full:0' "$(decide synchronize '[{"user": {"login": "claude[bot]", "type": "Bot"}, "body": null}]')"

# ── TRANSITION: unmarked summaries before the cutoff (delete after 2026-12-08) ─
check 'legacy: push + an unmarked full summary before the cutoff' 'push-recheck:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$FULL" "$OLD")]")"
for body in '1 important, 3 nits' '0 important, 1 nit. Scope: review:deep.' 'No blocking issues. 0 important, 0 nits.' \
  'Re-review at f895598: No blocking issues. 0 important, 0 new nits.' 'No factual issues found.' \
  'Correction to my summary above: 0 important, 1 nit.'; do
  check "legacy: push + a full summary worded '$body'" 'push-recheck:0' \
    "$(decide synchronize "[$(cm "$CB" Bot "$body" "$OLD")]")"
done
check 'legacy: CRLF in the body' 'push-recheck:0' \
  "$(decide synchronize "[$(cm "$CB" Bot $'No blocking issues found.\r\n0 important' "$OLD")]")"
check 'legacy: one second before the cutoff counts' 'push-recheck:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$FULL" 2026-11-24T23:59:59Z)]")"
check 'legacy: at the cutoff does not' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$FULL" 2026-11-25T00:00:00Z)]")"
check 'legacy: only unmarked push re-check summaries' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$RECHECK" "$OLD"),$(cm "$CB" Bot "$VERDICT" "$OLD")]")"
check 'legacy: a push re-check summary with leading space' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "  $RECHECK" "$OLD")]")"
check 'legacy: only the Security verdict' 'full:0' "$(decide synchronize "[$(cm "$CB" Bot "$VERDICT" "$OLD")]")"
check 'legacy: a tally written by a person' 'full:0' "$(decide synchronize "[$(cm someone User "$FULL" "$OLD")]")"
check 'legacy: a tally from another bot' 'full:0' \
  "$(decide synchronize "[$(cm 'dorkos-merge-tail[bot]' Bot "$FULL" "$OLD")]")"
check 'legacy: the reviewer login but not a Bot' 'full:0' "$(decide synchronize "[$(cm "$CB" User "$FULL" "$OLD")]")"
check 'legacy: a reviewer comment with no tally' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot 'This check is red because the review never started.' "$OLD")]")"
check 'legacy: a summary marked push-recheck is never read as legacy' 'full:0' \
  "$(decide synchronize "[$(cm "$CB" Bot "$MRECHECK" "$OLD")]")"

# ── only a push can be a push re-check ───────────────────────────────────────
for a in opened reopened ready_for_review labeled ''; do
  check "trigger '${a:-dispatch}' with a marked full summary on the PR" 'full:0' "$(decide "$a" "[$(cm "$CB" Bot "$MFULL")]")"
done
check 'a non-push trigger does not read the comments' 'full:0' "$(decide labeled 'not json')"

# ── input that cannot be read is never a decision ────────────────────────────
check 'unparseable comments' ':2' "$(decide synchronize 'not json')"
check 'a payload that is not a list of comments' ':2' "$(decide synchronize '"a string"')"
out=$(bash "$SCRIPT" synchronize 2>/dev/null)
check 'one argument is a usage error' 2 "$?"
out=$(bash "$SCRIPT" synchronize /no/such/file 2>/dev/null)
check 'an unreadable file is a usage error' 2 "$?"
printf '[%s]\n' "$(cm "$CB" Bot "$MFULL")" >"${TMPDIR:-/tmp}/review-mode-fixture.$$.json"
check 'comments from a file' push-recheck "$(bash "$SCRIPT" synchronize "${TMPDIR:-/tmp}/review-mode-fixture.$$.json")"
rm -f "${TMPDIR:-/tmp}/review-mode-fixture.$$.json"
: "$out"

# ── the helper's summaries are what this reads ───────────────────────────────
# End to end: post a summary through scripts/review-gh.sh with `gh` stubbed,
# then decide from the body it would have posted. Pins that the marker the
# helper writes is the one this script accepts, for both modes.
HELPER=${HELPER:-$repo_root/scripts/review-gh.sh}
stub=$(mktemp -d)
cat >"$stub/gh" <<'STUB'
#!/usr/bin/env bash
prev=
for arg in "$@"; do
  [ "$prev" = --body ] && printf '%s' "$arg" >"$GH_BODY_OUT"
  prev=$arg
done
exit 0
STUB
chmod +x "$stub/gh"
posted() { # mode -> the body the helper posts as claude[bot]'s comment, as JSON
  : >"$stub/body"
  REVIEW_REPO=dork-labs/dorkos REVIEW_PR=1 REVIEW_HEAD_SHA=$H REVIEW_MODE=$1 \
    GH_BODY_OUT="$stub/body" PATH="$stub:$PATH" bash "$HELPER" summary "$FULL" >/dev/null 2>&1
  cm "$CB" Bot "$(cat "$stub/body")"
}
check 'end to end: a summary posted in full mode counts' 'push-recheck:0' "$(decide synchronize "[$(posted full)]")"
check 'end to end: one posted in push-recheck mode does not' 'full:0' "$(decide synchronize "[$(posted push-recheck)]")"
check 'end to end: one posted with no mode does not' 'full:0' "$(decide synchronize "[$(posted '')]")"
check 'end to end: one posted with a made-up mode does not' 'full:0' "$(decide synchronize "[$(posted 'full -->')]")"
rm -rf "$stub"

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
check 'workflow: the helper is handed the decided mode for its marker' yes \
  "$(has "$(cat "$WF")" 'REVIEW_MODE: ${{ steps.review-mode.outputs.mode || '"'"'full'"'"' }}')"
check 'workflow: the prompt carries the decided mode' yes \
  "$(has "$(cat "$WF")" 'REVIEW MODE: ${{ steps.review-mode.outputs.mode || '"'"'full'"'"' }}')"
check 'workflow: the reviewer no longer decides push mode from comments' no \
  "$(has "$(cat "$WF")" 'first look
            for your own prior summary comment')"

echo "review-mode fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
