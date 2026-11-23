#!/usr/bin/env bash
# Fixture suite for scripts/not-held-check.sh: the `not-held` check fails while
# a PR carries `hold`. A stubbed `gh` (GH=...) answers the two reads the script
# makes and logs them, so it never reaches GitHub. Needs bash and jq.
#
#   bash scripts/test-not-held-check.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/not-held-check.sh
tmp=$(mktemp -d -t not-held-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

# The stub prints $FAKE_LABELS (one name per line) for the labels read, and
# $FAKE_COMMENTS (a JSON array of bodies) for the comments read, each through
# the --jq filter the script passes. FAKE_FAIL=labels|comments fails that read.
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
    jq -c '.[]' <<<"${FAKE_COMMENTS:-[]}"
    ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/gh"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo

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

FAKE_LABELS='' run 12
check 'no labels at all passes' 0 "$rc"

FAKE_LABELS=$'on-hold\nhold-review\nHold' run 12
check 'only the exact hold label counts' 0 "$rc"

FAKE_LABELS=$'review:deep\nhold' FAKE_COMMENTS='["looks good", "hold: waiting on Security for the token change\nmore"]' run 12
check 'a held PR fails' 1 "$rc"
check 'the failure prints the reason' yes "$(has "$out" 'Reason given: hold: waiting on Security for the token change')"
check 'the failure says how it lifts' yes "$(has "$out" 'taking the label off')"

FAKE_LABELS=hold FAKE_COMMENTS='[]' run 12
check 'a held PR with no reason fails' 1 "$rc"
check 'it says no reason was given' yes "$(has "$out" 'No comment starting')"

FAKE_LABELS=hold FAKE_FAIL=comments run 12
check 'unreadable comments still fail as held, not as an error' 1 "$rc"

FAKE_FAIL=labels run 12
check 'an unreadable label list fails closed with exit 2' 2 "$rc"
run
check 'no PR number is a usage error' 2 "$rc"
run 12abc
check 'a bad PR number is a usage error' 2 "$rc"
run 0
check 'PR 0 is a usage error' 2 "$rc"
run 1 2
check 'two arguments is a usage error' 2 "$rc"

FAKE_LABELS=hold FAKE_COMMENTS='["hold: x"]' run 12
check 'it reads labels through the issues API' yes "$(has "$(cat "$GH_LOG")" 'api repos/made-up/repo/issues/12/labels')"
check 'it paginates the comments' yes "$(has "$(cat "$GH_LOG")" 'api --paginate repos/made-up/repo/issues/12/comments')"
check 'it makes no write call' no "$(grep -qE -- '-X|--method|-f |--field|--input' "$GH_LOG" && echo yes || echo no)"

echo "not-held-check fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
