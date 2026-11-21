#!/usr/bin/env bash
# Fixture suite for scripts/hold-reason-check.sh: a `hold` label must come with
# a `hold: <reason>` comment. A stubbed `gh` (GH=...) answers the two reads the
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
# the --jq filter the script passes. FAKE_FAIL=labels|comments fails that read.
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
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/gh"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo HOLD_REASON_WAIT=0

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

FAKE_LABELS=$'hold\nreview:deep' FAKE_COMMENTS='["looks good", "hold: waiting on Security for the token change"]' run 12
check 'hold with a reason passes' 0 "$rc"
check 'the reason is printed' yes "$(has "$out" 'held: hold: waiting on Security for the token change')"

FAKE_LABELS=hold FAKE_COMMENTS='["  hold: indented reason\nmore detail below"]' run 12
check 'a reason after leading space, multi-line body, passes' 0 "$rc"
check 'only the first line is printed' yes "$(has "$out" 'held: hold: indented reason')"

FAKE_LABELS=hold FAKE_COMMENTS='[]' run 12
check 'hold with no comments fails' 1 "$rc"
check 'the failure names the fix' yes "$(has "$out" 'hold: <reason, and who lifts it>')"
check 'it reads the comments three times by default' 3 "$(grep -c comments "$GH_LOG")"

FAKE_LABELS=hold FAKE_COMMENTS='["hold:", "hold:   ", "please hold: this", "Hold on", "on hold: x"]' run 12
check 'an empty or mid-text hold: is not a reason' 1 "$rc"

FAKE_LABELS=$'on-hold\nhold-review' FAKE_COMMENTS='[]' run 12
check 'only the exact hold label counts' 0 "$rc"

FAKE_LABELS=hold FAKE_COMMENTS='[]' FAKE_COMMENTS_LATER='["hold: posted a moment later"]' run 12
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

FAKE_LABELS=hold FAKE_COMMENTS='["hold: x"]' run 12
check 'it reads labels through the issues API' yes "$(has "$(cat "$GH_LOG")" 'api repos/made-up/repo/issues/12/labels')"
check 'it paginates the comments' yes "$(has "$(cat "$GH_LOG")" 'api --paginate repos/made-up/repo/issues/12/comments')"
check 'it makes no write call' no "$(grep -qE -- '-X|--method|-f |--field|--input' "$GH_LOG" && echo yes || echo no)"

echo "hold-reason-check fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
