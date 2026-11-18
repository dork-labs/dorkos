#!/usr/bin/env bash
# Fixture suite for scripts/arm-door.sh, the merge queue's door for the arm rule
# (.github/workflows/arm-door.yml).
#
# Both ways it can be wrong are pinned. A KEEP that matches too much lets a pull
# request queued past every gate merge. A DEQUEUE that matches too much takes a
# properly armed pull request out of the queue, or one whose statuses nobody
# could read.
#
#   bash scripts/test-arm-door.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
door=$repo_root/scripts/arm-door.sh

if ! command -v jq >/dev/null 2>&1; then
  echo "arm-door fixtures: needs jq on PATH" >&2
  exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

# check <name> <expected-first-line> <statuses-json>
check() {
  local name=$1 expected=$2 got
  printf '%s' "$3" > "$tmp/s.json"
  got=$(bash "$door" verdict "$tmp/s.json" 2>/dev/null | head -n 1)
  if [[ "$got" == "$expected" ]]; then
    pass=$(( pass + 1 ))
  else
    fail=$(( fail + 1 ))
    printf 'FAIL  %-44s expected %-36s got %s\n' "$name" "$expected" "${got:-<empty>}"
  fi
}

stamp='{"id":2,"context":"arm-record","state":"success","created_at":"2026-11-18T10:00:00Z","description":"armed by dorkos-2 session 0d4a1afe proof=ci-green"}'
other='{"id":1,"context":"security-review","state":"success","created_at":"2026-11-18T09:00:00Z","description":"ok"}'

check "stamped head is kept"                   "KEEP armed armed by dorkos-2 session 0d4a1afe proof=ci-green" "[$other,$stamp]"
check "no statuses at all: dequeue"            "DEQUEUE no-arm-record" '[]'
check "other contexts only: dequeue"           "DEQUEUE no-arm-record" "[$other]"
check "a pending stamp: dequeue"               "DEQUEUE arm-record-pending" '[{"id":3,"context":"arm-record","state":"pending","created_at":"2026-11-18T10:00:00Z"}]'
check "a later failure undoes a success"       "DEQUEUE arm-record-failure" "[$stamp,{\"id\":5,\"context\":\"arm-record\",\"state\":\"failure\",\"created_at\":\"2026-11-18T11:00:00Z\"}]"
check "a later success after a failure: keep"  "KEEP armed again" "[{\"id\":1,\"context\":\"arm-record\",\"state\":\"failure\",\"created_at\":\"2026-11-18T09:00:00Z\"},{\"id\":9,\"context\":\"arm-record\",\"state\":\"success\",\"created_at\":\"2026-11-18T12:00:00Z\",\"description\":\"again\"}]"
check "same time, higher id wins"              "DEQUEUE arm-record-error" "[$stamp,{\"id\":3,\"context\":\"arm-record\",\"state\":\"error\",\"created_at\":\"2026-11-18T10:00:00Z\"}]"
check "a look-alike context doesn't count"     "DEQUEUE no-arm-record" '[{"id":4,"context":"arm-record-x","state":"success","created_at":"2026-11-18T10:00:00Z"}]'
check "not JSON: keep (unreadable)"            "KEEP unreadable-statuses" 'not json'
check "an object, not a list: keep"            "KEEP unreadable-statuses" '{"state":"success"}'

# The note names the head and carries a once-per-head marker.
note=$(bash "$door" comment 3913 53d8440472aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa no-arm-record)
if grep -qF '<!-- arm-door head=53d8440472aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->' <<<"$note" && grep -qF '53d8440' <<<"$note"; then
  pass=$(( pass + 1 ))
else
  fail=$(( fail + 1 )); echo "FAIL  comment carries the head marker"
fi
# Usage errors exit 2.
bash "$door" verdict >/dev/null 2>&1; rc=$?
if [[ "$rc" == 2 ]]; then pass=$(( pass + 1 )); else fail=$(( fail + 1 )); echo "FAIL  verdict with no file exits 2 (got $rc)"; fi

echo "arm-door fixtures: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
