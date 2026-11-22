#!/usr/bin/env bash
# Fixture suite for scripts/hold-reason-check.sh: a `hold` label must come
# with a `hold: <category>: <detail>` comment whose detail names more than a
# gate. A stubbed `gh` (GH=...) answers the two reads the
# script makes and logs them, so it never reaches GitHub. Needs bash and jq.
#
#   bash scripts/test-hold-reason-check.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/hold-reason-check.sh
tmp=$(mktemp -d -t hold-reason-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

# The stub prints $FAKE_LABELS (one name per line) for the labels read, and
# $FAKE_COMMENTS (a JSON array of bodies) for the comments read, each through
# the --jq filter the script passes, and $FAKE_BODY for the PR body read.
# FAKE_FAIL=labels|comments|body fails that read.
# FAKE_COMMENTS_LATER, when set, replaces the comments from the second read on.
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ "$1" = api ] || { echo "stub gh: unexpected $*" >&2; exit 1; }
case "$*" in
  *"/labels"*)
    [ "${FAKE_FAIL:-}" = labels ] && exit 1
    printf '%s' "${FAKE_LABELS:-}"
    ;;
  *"/comments"*)
    [ "${FAKE_FAIL:-}" = comments ] && exit 1
    comments=${FAKE_COMMENTS:-[]}
    if [ -n "${FAKE_COMMENTS_LATER:-}" ] && [ "$(grep -c comments "$GH_LOG")" -gt 1 ]; then
      comments=$FAKE_COMMENTS_LATER
    fi
    jq -c '.[]' <<<"$comments"
    ;;
  *"/issues/"*)
    [ "${FAKE_FAIL:-}" = body ] && exit 1
    printf '%s\n' "${FAKE_BODY:-}"
    ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/gh"
# The grace date is in the past for every case except the grace cases below.
# CI sets GITHUB_ACTIONS; only the annotation case below sets it on purpose.
unset GITHUB_ACTIONS
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo HOLD_REASON_WAIT=0 HOLD_REASON_GRACE_UNTIL=2000-01-01

out=""
rc=0
run() {
  : >"$GH_LOG"
  out=$("$SCRIPT" "$@" 2>&1)
  rc=$?
}
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n        output:   %s\n' \
      "$1" "$2" "$3" "$out" >&2
  fi
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }

FAKE_LABELS=$'review:light\nskip-changelog' run 12
check 'no hold passes' 0 "$rc"
check 'no hold does not read comments' no "$(has "$(cat "$GH_LOG")" comments)"

FAKE_LABELS=$'hold\nreview:deep' FAKE_COMMENTS='["looks good", "hold: external-dependency: waits on #4105"]' run 12
check 'hold with a categorized reason passes' 0 "$rc"
check 'the reason is printed' yes "$(has "$out" 'held: hold: external-dependency: waits on #4105')"

FAKE_LABELS=hold FAKE_COMMENTS='["  hold: stacked: on #4100, lands after it\nmore detail below"]' run 12
check 'a reason after leading space, multi-line body, passes' 0 "$rc"
check 'only the first line is printed' yes "$(has "$out" 'held: hold: stacked: on #4100, lands after it')"

FAKE_LABELS=hold FAKE_COMMENTS='["hold: waiting on Security for the token change"]' run 12
check 'an uncategorized reason fails' 1 "$rc"
check 'an uncategorized reason says so' yes "$(has "$out" 'it names no category')"
check 'a refused reason is re-read like a missing one' 3 "$(grep -c comments "$GH_LOG")"
check 'a refused reason says how to refresh the check' yes "$(has "$out" 'editing the PR body does')"

FAKE_LABELS=hold FAKE_COMMENTS='["hold: other: Security review"]' FAKE_COMMENTS_LATER='["hold: other: Security review", "hold: stacked: on #4100"]' run 12
check 'a good reason posted after an old refused one is waited for' 0 "$rc"

FAKE_LABELS=hold FAKE_COMMENTS='["hold: external-dependency: waits on #4105", "hold: other: @security-auditor deep review by 15:00Z"]' run 12
check 'the newest hold: comment decides' 1 "$rc"
check 'a gate-only reason says so' yes "$(has "$out" 'names nothing but a gate')"

FAKE_LABELS=hold FAKE_COMMENTS='["hold: other: Security review", "hold-cleared: Security labelled the head"]' run 12
check 'a hold-cleared: note is not read as the reason' 1 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='["hold: migration-collision: same idx as #4090, renumber after it lands", "hold-cleared: x"]' run 12
check 'a hold-cleared: note after a good reason passes' 0 "$rc"

FAKE_LABELS=hold FAKE_COMMENTS='[]' run 12
check 'hold with no comments fails' 1 "$rc"
check 'the failure names the fix' yes "$(has "$out" 'hold: <category>: <detail, and who lifts it>')"
check 'the failure lists the categories' yes "$(has "$out" 'migration-collision, stacked, external-dependency, other')"
check 'it reads the comments three times by default' 3 "$(grep -c comments "$GH_LOG")"

FAKE_LABELS=hold FAKE_COMMENTS='["hold:", "hold:   ", "please hold: this", "Hold on", "on hold: x"]' run 12
check 'an empty or mid-text hold: is not a reason' 1 "$rc"

FAKE_LABELS=$'on-hold\nhold-review' FAKE_COMMENTS='[]' run 12
check 'only the exact hold label counts' 0 "$rc"

FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_COMMENTS_LATER='["hold: other: posted a moment later"]' run 12
check 'a reason that lags the label is waited for' 0 "$rc"

FAKE_LABELS=hold FAKE_COMMENTS='[]' HOLD_REASON_TRIES=1 run 12
check 'HOLD_REASON_TRIES=1 reads once' 1 "$(grep -c comments "$GH_LOG")"

FAKE_FAIL=labels run 12
check 'an unreadable label list is exit 2' 2 "$rc"
FAKE_LABELS=hold FAKE_FAIL=comments run 12
check 'unreadable comments are exit 2' 2 "$rc"
run
check 'no PR number is a usage error' 2 "$rc"
run 12abc
check 'a bad PR number is a usage error' 2 "$rc"
run 1 2
check 'two arguments is a usage error' 2 "$rc"
HOLD_REASON_TRIES=0 run 12
check 'HOLD_REASON_TRIES=0 is a usage error' 2 "$rc"

FAKE_LABELS=hold FAKE_COMMENTS='["hold: other: x"]' run 12
check 'it reads labels through the issues API' yes "$(has "$(cat "$GH_LOG")" 'api repos/made-up/repo/issues/12/labels')"
check 'it paginates the comments' yes "$(has "$(cat "$GH_LOG")" 'api --paginate repos/made-up/repo/issues/12/comments')"
check 'it makes no write call' no "$(grep -qE -- '-X|--method|-f |--field|--input' "$GH_LOG" && echo yes || echo no)"

# --- a hold: line in the PR body ------------------------------------------------
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'What changed.\n\nhold: stacked: on #4100\n' run 12
check 'a reason in the PR body passes' 0 "$rc"
check 'the body reason is printed' yes "$(has "$out" 'held: hold: stacked: on #4100')"
FAKE_LABELS=hold FAKE_COMMENTS='["hold: other: Security review"]' FAKE_BODY=$'Body.\r\n  hold: external-dependency: waits on #4105\r\n' run 12
check 'a fixed reason in the body beats an old refused comment' 0 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'Body.\nhold: other: Security' run 12
check 'a refused body reason fails' 1 "$rc"
check 'a refusal says editing the body re-runs the check' yes "$(has "$out" 'editing the PR body does')"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY='We will hold: off on this until later' run 12
check 'a mid-line hold: in the body is not a reason' 1 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='["hold: other: Security review"]' FAKE_BODY='hold: stacked: on #4100' run 12
check 'either is enough: a refused comment and an accepted body line pass' 0 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'hold: other: Security\nhold: stacked: on #4100' run 12
check 'the last hold: line in the body is the one read' 0 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'hold: stacked: on #4100\nhold: other: Security' run 12
check 'a later refused body line replaces an earlier good one' 1 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'hold:   \nmore' run 12
check 'an empty hold: line in the body is not a reason' 1 "$rc"
check 'an empty body line is reported as missing' yes "$(has "$out" 'no comment or body line')"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'Format:\n```\nhold: external-dependency: waits on #4105\n```\n' run 12
check 'a hold: line in a fenced code block is not a reason' 1 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'Format:\n~~~\nhold: stacked: on #4100\n~~~' run 12
check 'a hold: line in a tilde fence is not a reason' 1 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'<!--\nhold: stacked: on #4100\n-->\nBody.' run 12
check 'a hold: line in an HTML comment is not a reason' 1 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'<!-- note -->hold: stacked: on #4100' run 12
check 'a hold: line after a closed HTML comment is read' 0 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY=$'> hold: stacked: on #4100' run 12
check 'a quoted hold: line is not a reason' 1 "$rc"
FAKE_LABELS=hold FAKE_FAIL=body run 12
check 'an unreadable body is exit 2' 2 "$rc"

# --- the grace period for old-form holds ---------------------------------------
FAKE_LABELS=hold FAKE_COMMENTS='["hold: waiting on Security for the token change"]' HOLD_REASON_GRACE_UNTIL=2999-01-01 run 12
check 'an old-form reason passes during the grace period' 0 "$rc"
check 'it warns that the grace period ends' yes "$(has "$out" 'will fail from 2999-01-01')"
check 'outside Actions there is no workflow annotation' no "$(has "$out" '::warning')"
FAKE_LABELS=hold FAKE_COMMENTS='["hold: other: Security"]' HOLD_REASON_GRACE_UNTIL=2999-01-01 GITHUB_ACTIONS=true run 12
check 'in Actions the grace warning is an annotation' yes "$(has "$out" '::warning title=hold-reason::#12')"
FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_BODY='hold: other: QA sign-off' HOLD_REASON_GRACE_UNTIL=2999-01-01 run 12
check 'a refused body reason gets the grace too' 0 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='[]' HOLD_REASON_GRACE_UNTIL=2999-01-01 run 12
check 'the grace period never excuses a missing reason' 1 "$rc"
FAKE_LABELS=hold FAKE_COMMENTS='["hold: x"]' HOLD_REASON_GRACE_UNTIL=soon run 12
check 'a grace date that is not a date is a usage error' 2 "$rc"
out=$(HOLD_REASON_GRACE_UNTIL=2999-01-01 "$SCRIPT" --reason 'Security review' 2>&1)
check '--reason has no grace period' 1 "$?"

# --- --reason: one reason, judged without GitHub ------------------------------
reason() { # expected rc, reason
  : >"$GH_LOG"
  out=$("$SCRIPT" --reason "$2" 2>&1)
  rc=$?
  check "--reason '$2'" "$1" "$rc"
}
reason 0 'external-dependency: waits on #4105'
reason 0 'migration-collision: same idx as #4090'
reason 0 'stacked: on #4100'
reason 0 'other: npm is down, retry after the outage'
reason 0 'Stacked : on #4100'
reason 0 'other: waiting on Dorian to choose the plan wording'
reason 1 'Security review'
reason 1 'waiting on Security for the token change'
reason 1 'security: token change'
reason 1 'stacked'
reason 1 'stacked:'
reason 1 'other:   '
reason 1 'other: Security'
reason 1 "other: @security-auditor's deep review"
reason 1 'external-dependency: design-ok from the designer'
reason 1 'other: QA sign-off'
reason 1 'other: verify proof at the head'
reason 1 'other: waiting on the release lead'
reason 1 'other: release pin, lifts after v0.140.0'
reason 1 'external-dependency: Security range-reads the new head by 15:00Z Nov 22'
reason 1 'other: CI green, then arm'
reason 1 'other: needs security-reviewed at the head'
reason 1 'other: Security re-review'
reason 1 'other: waiting on @dorkos-qa'
reason 1 'other: qa-real-data at this head'
reason 1 'other: Security #'
reason 1 'other: Security ---'
reason 1 'stacked other: x'
reason 1 'other: until Nov 25'
reason 0 'other: Security review of the token change'
check '--reason reads nothing from GitHub' '' "$(cat "$GH_LOG")"
"$SCRIPT" --reason 'other: Security' >/dev/null 2>"$tmp/err"
out=$(cat "$tmp/err")
check '--reason says why on stderr' yes "$(has "$out" 'names nothing but a gate')"
out=$("$SCRIPT" --reason 2>&1)
check '--reason with no text is a usage error' 2 "$?"
out=$("$SCRIPT" --reason a b 2>&1)
check '--reason with two texts is a usage error' 2 "$?"

echo "hold-reason-check fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
