#!/usr/bin/env bash
# Fixture suite for scripts/release-window-check.sh: freezes and releases as a
# required check. A stubbed `gh` and `curl` (GH=..., CURL=...) answer every read
# and log it, so nothing reaches GitHub or npm. Needs bash and jq.
#
#   bash scripts/test-release-window-check.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/release-window-check.sh
tmp=$(mktemp -d -t release-window-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

# gh stub:
#   FAKE_FILES      the PR's files, one per line
#   FAKE_VERSION    VERSION at any ref; FAKE_VERSION_<ref> overrides per ref
#                   (refs here are `main` or the fake SHAs below)
#   FAKE_COMMITS    the merge group's total_commits
#   FAKE_FAIL       files|version|compare fails that read
# curl stub: FAKE_NPM is a space-separated list of published versions;
#   FAKE_NPM_CODE forces an HTTP code (e.g. 503).
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"$GH_LOG"
[ "$1" = api ] || { echo "stub gh: unexpected $*" >&2; exit 1; }
case "$*" in
  *"/files"*)
    [ "${FAKE_FAIL:-}" = files ] && exit 1
    printf '%s\n' "${FAKE_FILES:-src/a.ts}"
    ;;
  *"contents/VERSION?ref="*)
    [ "${FAKE_FAIL:-}" = version ] && exit 1
    ref=${2#*ref=}
    var="FAKE_VERSION_$ref"
    printf '%s\n' "${!var:-${FAKE_VERSION:-1.2.3}}"
    ;;
  *"/compare/"*)
    [ "${FAKE_FAIL:-}" = compare ] && exit 1
    echo "${FAKE_COMMITS:-1}"
    ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
cat >"$tmp/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$GH_LOG"
url=${*: -1}
ver=${url##*/}
if [ -n "${FAKE_NPM_CODE:-}" ]; then printf '%s' "$FAKE_NPM_CODE"; exit 0; fi
case " ${FAKE_NPM-1.2.3} " in *" $ver "*) printf 200 ;; *) printf 404 ;; esac
EOF
chmod +x "$tmp/gh" "$tmp/curl"
export GH="$tmp/gh" CURL="$tmp/curl" GH_LOG="$tmp/gh.log" REPO=made-up/repo MERGE_FREEZE=

B=1111111111111111111111111111111111111111
H=2222222222222222222222222222222222222222

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

# --- pr mode ---
run pr 12
check 'an ordinary PR with main published passes' 0 "$rc"
check 'it reads main'\''s VERSION' yes "$(has "$(cat "$GH_LOG")" 'contents/VERSION?ref=main')"
check 'it asks npm for that version' yes "$(has "$(cat "$GH_LOG")" 'registry.npmjs.org/dorkos/1.2.3')"

FAKE_VERSION=1.3.0 FAKE_NPM=1.2.3 run pr 12
check 'main ahead of npm (a release being cut) fails' 1 "$rc"
check 'it says a release is being cut' yes "$(has "$out" 'a release is being cut')"

FAKE_FILES=$'VERSION\nCHANGELOG.md' FAKE_VERSION=1.3.0 FAKE_NPM=1.2.3 run pr 12
check 'a release PR passes on the PR (the queue checks it is alone)' 0 "$rc"

MERGE_FREEZE='4200 cutting 1.3.0' run pr 12
check 'a freeze stops other PRs' 1 "$rc"
check 'the freeze names the PR it lets through and why' yes "$(has "$out" 'only #4200 may merge')"
check 'the freeze reason is printed' yes "$(has "$out" 'cutting 1.3.0')"

MERGE_FREEZE='#12 cutting 1.3.0' FAKE_FILES=VERSION run pr 12
check 'the frozen-for PR passes (with a leading #)' 0 "$rc"

MERGE_FREEZE='- incident on main' run pr 12
check 'a "-" freeze stops everything' 1 "$rc"
check 'it says nothing may merge' yes "$(has "$out" 'only nothing may merge')"

MERGE_FREEZE='   ' run pr 12
check 'a blank freeze is no freeze' 0 "$rc"

MERGE_FREEZE='12' run pr 12
check 'a freeze with no reason still lets its PR through' 0 "$rc"

FAKE_NPM_CODE=503 run pr 12
check 'an npm outage fails closed with exit 2' 2 "$rc"
FAKE_FAIL=version run pr 12
check 'an unreadable VERSION is exit 2' 2 "$rc"
FAKE_VERSION=1.3.0-rc.1 run pr 12
check 'a non-x.y.z VERSION is exit 2' 2 "$rc"
FAKE_FAIL=files run pr 12
check 'an unreadable file list is exit 2' 2 "$rc"

# --- group mode ---
run group 12 "$B" "$H"
check 'an ordinary queue entry passes' 0 "$rc"
check 'it reads VERSION at the group head' yes "$(has "$(cat "$GH_LOG")" "contents/VERSION?ref=$H")"

declare -x "FAKE_VERSION_$H=1.3.0"
FAKE_NPM=1.2.3 run group 12 "$B" "$H"
check 'an entry queued behind an unpublished release fails' 1 "$rc"
check 'it names the version it would land on' yes "$(has "$out" 'would land on 1.3.0')"
unset "FAKE_VERSION_$H"

FAKE_FILES=VERSION FAKE_COMMITS=1 run group 12 "$B" "$H"
check 'a release alone in its group passes' 0 "$rc"
check 'it compares base...head' yes "$(has "$(cat "$GH_LOG")" "compare/$B...$H")"

FAKE_FILES=VERSION FAKE_COMMITS=3 run group 12 "$B" "$H"
check 'a release with PRs ahead of it fails' 1 "$rc"
check 'it says how many commits the group holds' yes "$(has "$out" 'holds 3 commits')"

FAKE_FILES=VERSION FAKE_VERSION=1.2.3 FAKE_NPM=1.2.2 run group 12 "$B" "$H"
check 'a release whose previous release is not on npm fails' 1 "$rc"

MERGE_FREEZE='4200 cutting' run group 12 "$B" "$H"
check 'a freeze stops queue entries too' 1 "$rc"

FAKE_FILES=VERSION FAKE_FAIL=compare run group 12 "$B" "$H"
check 'an unreadable compare is exit 2' 2 "$rc"
run group 12 "$B" abc
check 'a short SHA is a usage error' 2 "$rc"

# --- open ---
run open
check 'open with no freeze and main published' 0 "$rc"
MERGE_FREEZE='1 x' run open
check 'closed while frozen' 1 "$rc"
FAKE_VERSION=1.3.0 FAKE_NPM=1.2.3 run open
check 'closed while a release is being cut' 1 "$rc"

# --- rerun-list ---
cat >"$tmp/runs.json" <<'EOF'
[
  {"databaseId": 1, "headSha": "aaa", "conclusion": "failure", "createdAt": "2026-11-23T10:00:00Z"},
  {"databaseId": 2, "headSha": "aaa", "conclusion": "success", "createdAt": "2026-11-23T11:00:00Z"},
  {"databaseId": 3, "headSha": "bbb", "conclusion": "success", "createdAt": "2026-11-23T10:00:00Z"},
  {"databaseId": 4, "headSha": "bbb", "conclusion": "failure", "createdAt": "2026-11-23T11:00:00Z"},
  {"databaseId": 5, "headSha": "ccc", "conclusion": "failure", "createdAt": "2026-11-23T11:00:00Z"},
  {"databaseId": 6, "headSha": "ddd", "conclusion": "cancelled", "createdAt": "2026-11-23T11:00:00Z"}
]
EOF
printf 'aaa\nbbb\nddd\n' >"$tmp/heads.txt"
run rerun-list "$tmp/runs.json" "$tmp/heads.txt"
check 'rerun-list picks the latest failed run of an open head only' 4 "$out"

# --- usage ---
run
check 'no arguments is a usage error' 2 "$rc"
run pr
check 'pr with no number is a usage error' 2 "$rc"
run pr 0
check 'PR 0 is a usage error' 2 "$rc"
run bogus 1
check 'an unknown mode is a usage error' 2 "$rc"

run pr 12
check 'it makes no write call' no "$(grep -qE -- '-X|--method|-f |--field|--input' "$GH_LOG" && echo yes || echo no)"

echo "release-window-check fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
