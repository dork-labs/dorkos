#!/usr/bin/env bash
# Fixture suite for scripts/timed-slot.sh (ledger 261124-161126), and for
# the wiring of the two daily workflows that call it: each cron matches the slot
# its `due` job asks about, the backstop names a workflow that runs on every
# push to main, and the marker is uploaded under the name `due` printed.
# `due` runs against a stubbed `gh` (GH=...) that answers from fixture files
# and logs every call. Needs bash and jq.
#
#   bash scripts/test-timed-slot.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/timed-slot.sh
tmp=$(mktemp -d -t timed-slot-test.XXXXXX)
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
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3" >&2
  fi
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }
calls() { cat "$tmp/gh/calls.log" 2>/dev/null; }

# The stub: answers from $tmp/gh/*, by endpoint; a missing answer file is a
# failed call. --jq is applied with the real jq, as gh does.
mkdir -p "$tmp/gh"
cat >"$tmp/gh-stub" <<'STUB'
#!/usr/bin/env bash
dir=${GH_FIXTURES:?}
echo "$*" >>"$dir/calls.log"
[ "$1" = api ] || exit 1
url=$2
filter=.
[ "${3:-}" = --jq ] && filter=$4
case "$url" in
  */actions/artifacts\?name=*) f=$dir/artifacts.json ;;
  */actions/runs/[0-9]*) f=$dir/run-${url##*/}.json ;;
  */actions/workflows/*/runs\?*status=failure*) f=$dir/failed.json ;;
  *) exit 1 ;;
esac
[ -f "$f" ] || exit 1
jq -r "$filter" "$f"
STUB
chmod +x "$tmp/gh-stub"
export GH=$tmp/gh-stub GH_FIXTURES=$tmp/gh REPO=o/r

reset() {
  rm -f "$tmp/gh/"*
  echo '{"total_count": 0, "artifacts": []}' >"$tmp/gh/artifacts.json"
  echo '{"total_count": 0}' >"$tmp/gh/failed.json"
}
# artifact <run-id> [<head_branch> [<same-repo: true|false>]]
artifact() {
  local same=${3:-true}
  jq --argjson id "$1" --arg b "${2:-main}" --argjson same "$same" \
    '.artifacts += [{name: "x", expired: false,
      workflow_run: {id: $id, head_branch: $b, repository_id: 1, head_repository_id: (if $same then 1 else 2 end)}}]
     | .total_count = (.artifacts | length)' "$tmp/gh/artifacts.json" >"$tmp/a" && mv "$tmp/a" "$tmp/gh/artifacts.json"
}
# run <id> <path> <event> [<head_branch>]
run() {
  jq -n --arg p "$2" --arg e "$3" --arg b "${4:-main}" '{path: $p, event: $e, head_branch: $b}' >"$tmp/gh/run-$1.json"
}
due() {
  out=$(NOW=$1 "$SCRIPT" due "${2:-daily-release.yml}" "${3:-15:07}" 2>&1)
  rc=$?
}

# --- the clock ---
reset
due 2026-11-24T15:06:59Z
check 'before the slot: not due' "NOT_DUE before today's 15:07 UTC slot" "$out"
check 'and exits 0' 0 "$rc"
check 'before the slot it asks GitHub nothing' no "$( [ -s "$tmp/gh/calls.log" ] && echo yes || echo no)"
reset
due 2026-11-24T15:07:00Z
check 'at the slot, nothing done: due, with the day marker' 'DUE timed-slot-daily-release-2026-11-24' "$out"
check 'it looks for that marker by name' yes "$(has "$(calls)" 'actions/artifacts?name=timed-slot-daily-release-2026-11-24')"
check 'and counts failed runs since the slot' yes "$(has "$(calls)" 'actions/workflows/daily-release.yml/runs?created=%3E%3D2026-11-24T15:07:00Z&status=failure')"
reset
due 2026-11-24T23:59:59Z daily-sweep.yml 17:13
check 'late the same day: still due, named for the workflow' 'DUE timed-slot-daily-sweep-2026-11-24' "$out"
reset
due 2026-11-25T00:30:00Z
check 'after midnight it is the next day, before its slot' "NOT_DUE before today's 15:07 UTC slot" "$out"

# --- done today ---
reset
artifact 101
run 101 .github/workflows/daily-release.yml schedule
due 2026-11-24T16:00:00Z
check 'the cron run uploaded the marker: done' "NOT_DUE run 101 already did today's 15:07 UTC slot" "$out"
reset
artifact 102
run 102 .github/workflows/daily-release.yml workflow_run
due 2026-11-24T16:00:00Z
check 'the backstop run uploaded it: done' "NOT_DUE run 102 already did today's 15:07 UTC slot" "$out"
reset
artifact 103
run 103 '.github/workflows/daily-release.yml@refs/heads/main' schedule
due 2026-11-24T16:00:00Z
check 'a path with an @ref suffix is the same file' "NOT_DUE run 103 already did today's 15:07 UTC slot" "$out"
reset
artifact 104 my-branch
run 104 .github/workflows/daily-release.yml workflow_run
due 2026-11-24T16:00:00Z
check 'a marker from a branch run does not count' 'DUE timed-slot-daily-release-2026-11-24' "$out"
check 'and its run is not even read' no "$(has "$(calls)" 'actions/runs/104')"
reset
artifact 105 main false
run 105 .github/workflows/daily-release.yml workflow_run
due 2026-11-24T16:00:00Z
check 'a marker from a fork branch named main does not count' 'DUE timed-slot-daily-release-2026-11-24' "$out"
reset
artifact 106
run 106 .github/workflows/other.yml push
due 2026-11-24T16:00:00Z
check 'a marker another workflow uploaded does not count' 'DUE timed-slot-daily-release-2026-11-24' "$out"
reset
artifact 107
run 107 .github/workflows/daily-release.yml pull_request my-branch
due 2026-11-24T16:00:00Z
check 'a pull request run of this file does not count' 'DUE timed-slot-daily-release-2026-11-24' "$out"
reset
artifact 108
run 108 .github/workflows/daily-release.yml workflow_dispatch
due 2026-11-24T16:00:00Z
check 'a dispatch does not do the slot' 'DUE timed-slot-daily-release-2026-11-24' "$out"
reset
artifact 109
artifact 110
run 109 .github/workflows/daily-release.yml pull_request
run 110 .github/workflows/daily-release.yml schedule
due 2026-11-24T16:00:00Z
check 'one real marker among others is enough' "NOT_DUE run 110 already did today's 15:07 UTC slot" "$out"
reset
artifact 111
due 2026-11-24T16:00:00Z
check 'an unreadable run fails closed (exit 2)' 2 "$rc"
check 'and says which' yes "$(has "$out" 'could not read run 111')"

# --- the failure cap ---
reset
echo '{"total_count": 2}' >"$tmp/gh/failed.json"
due 2026-11-24T16:00:00Z
check 'two failed runs since the slot: try again' 'DUE timed-slot-daily-release-2026-11-24' "$out"
echo '{"total_count": 3}' >"$tmp/gh/failed.json"
due 2026-11-24T16:00:00Z
check 'three failed runs: stop until tomorrow' "NOT_DUE 3 runs failed since today's 15:07 UTC slot; the next try is tomorrow's" "$out"
echo '{"total_count": 1}' >"$tmp/gh/failed.json"
out=$(NOW=2026-11-24T16:00:00Z MAX_FAILED=1 "$SCRIPT" due daily-release.yml 15:07 2>&1)
check 'MAX_FAILED overrides the cap' "NOT_DUE 1 runs failed since today's 15:07 UTC slot; the next try is tomorrow's" "$out"

# --- unreadable GitHub, bad input ---
reset
rm -f "$tmp/gh/artifacts.json"
due 2026-11-24T16:00:00Z
check 'artifacts unreadable: exit 2' 2 "$rc"
check 'not a quiet DUE' no "$(has "$out" DUE)"
reset
rm -f "$tmp/gh/failed.json"
due 2026-11-24T16:00:00Z
check 'failed runs unreadable: exit 2' 2 "$rc"
reset
due 2026-11-24T16:00:00Z daily-release.yml 3pm
check 'a slot that is not HH:MM is usage' 2 "$rc"
due 2026-11-24T16:00:00Z 'x;y.yml' 15:07
check 'a workflow name with odd characters is usage' 2 "$rc"
due 'Tuesday' daily-release.yml 15:07
check 'a NOW that is not ISO 8601 is exit 2' 2 "$rc"
out=$("$SCRIPT" 2>&1)
check 'no mode is usage' 2 "$?"

# --- the wiring: each workflow's cron, its due call and its backstop agree ---
# wired <workflow> <minute> <hour>
wired() {
  local wf=$1 min=$2 hour=$3 text slot
  text=$(cat "$repo_root/.github/workflows/$wf")
  slot=$(printf '%02d:%02d' "$hour" "$min")
  check "$wf: the cron is the slot" yes "$(has "$text" "- cron: '$min $hour * * *'")"
  check "$wf: the cron is off minute 0" yes "$([ "$min" != 0 ] && echo yes || echo no)"
  check "$wf: the due job asks about the same slot" yes "$(has "$text" "bash scripts/timed-slot.sh due $wf $slot")"
  check "$wf: the backstop is CLI Smoke Test on main" yes "$(grep -A3 '^  workflow_run:' <<<"$text" | tr -d ' \n' | grep -qF 'workflows:[CLISmokeTest]types:[completed]branches:[main]' && echo yes || echo no)"
  check "$wf: one concurrency group for the whole run" yes "$(grep -A1 '^concurrency:' <<<"$text" | grep -qE '^  group: [a-z-]+$' && echo yes || echo no)"
  # shellcheck disable=SC2016 # a literal workflow expression
  check "$wf: the marker is the name due printed" yes "$(has "$text" 'name: ${{ needs.due.outputs.marker }}')"
}
wired daily-release.yml 7 15
wired daily-sweep.yml 13 17
smoke=$(cat "$repo_root/.github/workflows/cli-smoke-test.yml")
check 'the backstop workflow is named CLI Smoke Test' yes "$(grep -qx 'name: CLI Smoke Test' <<<"$smoke" && echo yes || echo no)"
check 'and runs on every push to main' yes "$(grep -A2 '^  push:' <<<"$smoke" | grep -qF 'branches: [main]' && echo yes || echo no)"
check 'with no path filter' no "$(awk '/^on:/{p=1} /^[a-z]/ && !/^on:/{p=0} p' <<<"$smoke" | grep -qE 'paths(-ignore)?:' && echo yes || echo no)"

echo "timed-slot: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
