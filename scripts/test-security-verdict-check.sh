#!/usr/bin/env bash
# Fixture suite for scripts/security-verdict-check.sh: the `security-verdict`
# job passes only on a `pass` marker by claude[bot] (user type Bot) for the
# exact head. A stubbed `gh`
# (GH=...) answers the comments read and logs it. Needs bash and jq.
#
#   bash scripts/test-security-verdict-check.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/security-verdict-check.sh
tmp=$(mktemp -d -t security-verdict-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

# FAKE_COMMENTS is a JSON array of {user: {login, type}, created_at, body}; the stub
# applies the script's own --jq filter to it. FAKE_FAIL=1 fails the read.
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ "$1" = api ] || { echo "stub gh: unexpected $*" >&2; exit 1; }
[ -n "${FAKE_FAIL:-}" ] && exit 1
filter=
while [ $# -gt 0 ]; do
  [ "$1" = --jq ] && { filter=$2; break; }
  shift
done
jq -r "$filter" <<<"${FAKE_COMMENTS:-[]}"
EOF
chmod +x "$tmp/gh"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo

H=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OLD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
mark() { # head verdict musts cats
  printf '<!-- dorkos-security-verdict v1 head=%s verdict=%s musts=%s cats=%s -->\\nSecurity lens: whatever' "$1" "$2" "$3" "$4"
}
c() { # type time body: a comment by claude[bot] when type is Bot, else by a person
  local login='claude[bot]'
  [ "$1" = Bot ] || login=someone
  printf '{"user":{"login":"%s","type":"%s"},"created_at":"%s","body":"%s"}' "$login" "$1" "$2" "$3"
}
by() { # login type time body
  printf '{"user":{"login":"%s","type":"%s"},"created_at":"%s","body":"%s"}' "$1" "$2" "$3" "$4"
}

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

FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'a claude[bot] pass for this head passes' 0 "$rc"

FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "$(mark $H fail 2 auth,ci)")]" run 12 $H
check 'a claude[bot] fail for this head fails' 1 "$rc"
check 'it reports the count and categories' yes "$(has "$out" '2 Must(s)')"
check 'and the categories' yes "$(has "$out" 'auth,ci')"

FAKE_COMMENTS='[]' run 12 $H
check 'no verdict at all fails' 1 "$rc"
check 'it says this head was not judged' yes "$(has "$out" 'has not judged this head')"

FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "$(mark $OLD pass 0 -)")]" run 12 $H
check 'a pass for an older head does not count' 1 "$rc"

FAKE_COMMENTS="[$(c User 2026-11-23T10:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'a person pasting a pass marker does not count' 1 "$rc"

# Only claude[bot] with user type Bot counts.
FAKE_COMMENTS="[$(by 'github-actions[bot]' Bot 2026-11-23T10:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'a pass marker from github-actions[bot] does not count' 1 "$rc"
FAKE_COMMENTS="[$(by 'dorkos-merge-tail[bot]' Bot 2026-11-23T10:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'a pass marker from another bot does not count' 1 "$rc"
FAKE_COMMENTS="[$(by 'claude[bot]' User 2026-11-23T10:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'a pass marker from login claude[bot] with user type User does not count' 1 "$rc"
FAKE_COMMENTS="[$(by 'claude' Bot 2026-11-23T10:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'a pass marker from login claude (no [bot]) does not count' 1 "$rc"
FAKE_COMMENTS="[$(by 'claude[bot]' Bot 2026-11-23T10:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'a pass marker from claude[bot] counts' 0 "$rc"
FAKE_COMMENTS="[$(by 'claude[bot]' Bot 2026-11-23T10:00:00Z "$(mark $H fail 1 auth)"),$(by 'github-actions[bot]' Bot 2026-11-23T11:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'a newer pass from another bot leaves a claude[bot] fail a fail' 1 "$rc"
FAKE_COMMENTS="[$(by 'claude[bot]' Bot 2026-11-23T10:00:00Z "$(mark $H pass 0 -)"),$(by 'github-actions[bot]' Bot 2026-11-23T11:00:00Z "$(mark $H fail 1 auth)")]" run 12 $H
check 'a newer fail from another bot leaves a claude[bot] pass a pass' 0 "$rc"

FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "$(mark $H fail 1 auth)"),$(c Bot 2026-11-23T11:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'the newest verdict for the head wins (pass after fail)' 0 "$rc"

FAKE_COMMENTS="[$(c Bot 2026-11-23T11:00:00Z "$(mark $H fail 1 auth)"),$(c Bot 2026-11-23T10:00:00Z "$(mark $H pass 0 -)")]" run 12 $H
check 'the newest verdict for the head wins (fail after pass)' 1 "$rc"

FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "Security lens: **pass**, trust me. verdict=pass head=$H")]" run 12 $H
check 'prose that is not the marker does not count' 1 "$rc"

FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "$(mark $H maybe 0 -)")]" run 12 $H
check 'a marker with an unknown verdict does not count' 1 "$rc"

# The encrypted details block (scripts/security-findings.sh) sits in comments
# this script reads. It must change nothing: only the verdict marker counts.
findings() { # head
  printf '<!-- dorkos-security-findings v1 pr=12 head=%s\\n-----BEGIN AGE ENCRYPTED FILE-----\\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCg==\\n-----END AGE ENCRYPTED FILE-----\\n-->' "$1"
}
FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "$(mark $H pass 0 -)\\n$(findings $H)")]" run 12 $H
check 'a findings block in the same comment leaves a pass a pass' 0 "$rc"
FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "$(findings $H)\\n$(mark $H fail 2 auth,ci)")]" run 12 $H
check 'a findings block in the same comment leaves a fail a fail' 1 "$rc"
check 'with the same count and categories' yes "$(has "$out" '2 Must(s) on #12 at aaaaaaa (categories: auth,ci)')"
FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "$(mark $H pass 0 -)"),$(c Bot 2026-11-23T11:00:00Z "$(findings $H)")]" run 12 $H
check 'a newer findings block alone does not displace the verdict' 0 "$rc"
FAKE_COMMENTS="[$(c Bot 2026-11-23T10:00:00Z "$(findings $H)")]" run 12 $H
check 'a findings block with no verdict marker is no verdict' 1 "$rc"
check 'and says this head was not judged' yes "$(has "$out" 'has not judged this head')"

FAKE_FAIL=1 run 12 $H
check 'an unreadable comment list is exit 2' 2 "$rc"
run 12
check 'a missing head is a usage error' 2 "$rc"
run 12 abc
check 'a short head is a usage error' 2 "$rc"
run 0 $H
check 'PR 0 is a usage error' 2 "$rc"

FAKE_COMMENTS='[]' run 12 $H
check 'it paginates the issue comments' yes "$(has "$(cat "$GH_LOG")" 'api --paginate repos/made-up/repo/issues/12/comments')"
check 'it makes no write call' no "$(grep -qE -- '-X|--method|-f |--field|--input' "$GH_LOG" && echo yes || echo no)"

echo "security-verdict-check fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
