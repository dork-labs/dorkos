#!/usr/bin/env bash
# Fixture suite for scripts/attest-pr-check.sh (DOR-5130). A stubbed `gh`
# (GH=...) answers the PR and check-run reads from fixture files and logs every
# call. The script must print attested=true only on a clean success, and
# attested=false (exit 0) on every doubt. Needs bash and jq.
#
#   bash scripts/test-attest-pr-check.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/attest-pr-check.sh
tmp=$(mktemp -d -t attest-pr-check-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
out=""
rc=0
check() {
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n        output:   %s\n' "$1" "$2" "$3" "$out" >&2
  fi
}

cat >"$tmp/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ -n "${FAIL_ON:-}" ] && [[ "$*" == *"$FAIL_ON"* ]] && exit 1
# Print a --jq result the way gh does: a string raw, a null as an empty line
# (`jq -r` alone prints "null"), anything else as compact JSON.
gh_jq() {
  jq -rc "($1
) | if . == null then \"\" else . end" "${@:2}"
}
filter=.
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = --jq ] && filter=${args[$((i + 1))]}; done
case "$*" in
  *"/check-runs"*) f=runs ;;
  *"/pulls/"*) f=pull ;;
  *) exit 1 ;;
esac
gh_jq "$filter" "$FX/$f"
STUB
chmod +x "$tmp/gh"
mkdir -p "$tmp/fx"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo FX=$tmp/fx
H=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REF=refs/heads/gh-readonly-queue/main/pr-42-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

pull() { printf '{"state":"%s","head":{"sha":"%s"},"base":{"ref":"%s"}}' "${1:-open}" "${2:-$H}" "${3:-main}" >"$tmp/fx/pull"; }
runs() { printf '{"check_runs":[%s]}' "$1" >"$tmp/fx/runs"; }
cr() { # app status conclusion started
  printf '{"app":{"id":%s},"status":"%s","conclusion":%s,"started_at":"%s","details_url":"u"}' "$1" "$2" "$3" "$4"
}
run() {
  : >"$GH_LOG"
  out=$("$SCRIPT" "$@" 2>"$tmp/err")
  rc=$?
}

pull; runs "$(cr 15368 completed '"success"' 2026-11-24T01:00:00Z)"
run lint "$REF"
check 'a success by GitHub Actions on the PR head attests' attested=true "$out"
check 'it exits 0' 0 "$rc"
check 'it reads the PR from the queue ref' yes "$(grep -qF 'repos/made-up/repo/pulls/42' "$GH_LOG" && echo yes || echo no)"
check 'it reads that context on that head' yes "$(grep -qF "commits/$H/check-runs?check_name=lint" "$GH_LOG" && echo yes || echo no)"
check 'it makes no write call' no "$(grep -qE -- '--method|-X (POST|PATCH|PUT|DELETE)' "$GH_LOG" && echo yes || echo no)"

for c in failure cancelled skipped neutral timed_out; do
  runs "$(cr 15368 completed "\"$c\"" 2026-11-24T01:00:00Z)"
  run lint "$REF"
  check "a $c run does not attest" attested=false "$out"
done
runs "$(cr 15368 in_progress null 2026-11-24T01:00:00Z)"
run lint "$REF"
check 'an unfinished run does not attest' attested=false "$out"
runs ''
run lint "$REF"
check 'no run at all does not attest' attested=false "$out"
runs "$(cr 999 completed '"success"' 2026-11-24T01:00:00Z)"
run lint "$REF"
check 'a success from another app does not attest' attested=false "$out"
runs "$(cr 15368 completed '"success"' 2026-11-24T01:00:00Z),$(cr 15368 completed '"failure"' 2026-11-24T02:00:00Z)"
run lint "$REF"
check 'the newest run wins (failure after success)' attested=false "$out"
runs "$(cr 15368 completed '"failure"' 2026-11-24T01:00:00Z),$(cr 15368 completed '"success"' 2026-11-24T02:00:00Z)"
run lint "$REF"
check 'the newest run wins (success after failure)' attested=true "$out"

runs "$(cr 15368 completed '"success"' 2026-11-24T01:00:00Z)"
pull closed
run lint "$REF"
check 'a closed PR does not attest' attested=false "$out"
pull open "$H" release/v1.2.3
run lint "$REF"
check 'a PR into a release branch does not attest' attested=false "$out"
pull open nothex
run lint "$REF"
check 'an unreadable head does not attest' attested=false "$out"
pull
run lint refs/heads/some-branch
check 'a non-queue ref does not attest' attested=false "$out"
check 'and still exits 0' 0 "$rc"
FAIL_ON=/pulls/ run lint "$REF"
check 'an unreadable PR does not attest' attested=false "$out"
FAIL_ON=/check-runs run lint "$REF"
check 'unreadable check runs do not attest' attested=false "$out"
run 'Bad Name' "$REF"
check 'a bad context does not attest' attested=false "$out"
run
check 'no arguments does not attest' attested=false "$out"
check 'and exits 0, so the real check runs' 0 "$rc"

echo "attest-pr-check fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
