#!/usr/bin/env bash
# Fixture suite for scripts/assert-shard-union.sh, the check that restores the
# zero-collected-files safety net --passWithNoTests removes from the sharded
# merge-queue sweep.
#
# It exists because that script IS the net now. Vitest under `--shard=N/4
# --passWithNoTests` reports green for a package whose include glob collects
# nothing, on every shard; assert-tests-executed.sh counts turbo tasks, not
# files, so it cannot see it either. If this union check stops discriminating,
# a package's entire suite can vanish from the queue gate silently. So both
# verdicts are pinned: a full union must pass, and a package missing from the
# union must fail by name.
#
# HERMETIC, on purpose (same reason test-assert-tests-executed.sh says so):
# every case builds a throwaway workspace in a temp dir and points the script
# at it with WORKSPACE_ROOT. Nothing here reads this repo's real packages, so
# the suite cannot start red-lighting unrelated PRs the day someone adds one.
#
#   bash scripts/test-assert-shard-union.sh
#   ASSERT=/path/to/other.sh bash scripts/test-assert-shard-union.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
assert=${ASSERT:-$repo_root/scripts/assert-shard-union.sh}

work_dir=$(mktemp -d -t assert-shard-union.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT

pass=0
fail=0

check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' \
      "$name" "$expected" "$actual" >&2
  fi
}

# One synthetic workspace: two packages with test scripts, one without.
ws="$work_dir/ws"
mkdir -p "$ws/apps/alpha" "$ws/packages/beta" "$ws/packages/no-tests"
printf '{"name":"alpha","scripts":{"test":"vitest run"}}\n' > "$ws/apps/alpha/package.json"
printf '{"name":"beta","scripts":{"test":"vitest"}}\n' > "$ws/packages/beta/package.json"
printf '{"name":"no-tests","scripts":{"build":"tsc"}}\n' > "$ws/packages/no-tests/package.json"

run_case() {
  local lists=$1
  WORKSPACE_ROOT="$ws" bash "$assert" "$lists" >/dev/null 2>&1
  echo $?
}

# Case 1: every test-script package appears in the union across shards → pass.
# beta's only file sits on shard 2 while shard 1 has none of beta — exactly the
# legitimate empty-shard shape the union must tolerate.
lists1="$work_dir/case1"
mkdir -p "$lists1"
printf 'apps/alpha/src/__tests__/a.test.ts\n' > "$lists1/shard-1.txt"
printf 'apps/alpha/src/__tests__/b.test.ts\npackages/beta/src/__tests__/c.test.ts\n' > "$lists1/shard-2.txt"
check 'full union passes' 0 "$(run_case "$lists1")"

# Case 2: beta contributes zero files to EVERY shard → fail, and the failure
# names beta. This is the broken-include-glob shape --passWithNoTests hides.
lists2="$work_dir/case2"
mkdir -p "$lists2"
printf 'apps/alpha/src/__tests__/a.test.ts\n' > "$lists2/shard-1.txt"
printf 'apps/alpha/src/__tests__/b.test.ts\n' > "$lists2/shard-2.txt"
check 'a package missing from the union fails' 1 "$(run_case "$lists2")"
out=$(WORKSPACE_ROOT="$ws" bash "$assert" "$lists2" 2>&1)
case "$out" in
  *packages/beta*) pass=$((pass + 1)) ;;
  *) fail=$((fail + 1)); printf 'FAIL  the failure names the missing package\n        got: %s\n' "$out" >&2 ;;
esac

# Case 3: a package WITHOUT a test script is not required in the union — case 1
# already passed without no-tests appearing anywhere, so pin the inverse too:
# adding it to the union changes nothing.
lists3="$work_dir/case3"
mkdir -p "$lists3"
cp "$lists1"/*.txt "$lists3/"
printf 'packages/no-tests/src/__tests__/x.test.ts\n' > "$lists3/shard-3.txt"
check 'a no-test-script package is not counted' 0 "$(run_case "$lists3")"

# Case 4: an empty lists directory → fail. No shard reported anything; that is
# a broken collect step, not a passing sweep.
lists4="$work_dir/case4"
mkdir -p "$lists4"
check 'an empty union fails' 1 "$(run_case "$lists4")"

# Case 5: a prefix collision must not count — a file under
# packages/beta-extras must not satisfy packages/beta.
mkdir -p "$ws/packages/beta-extras"
printf '{"name":"beta-extras","scripts":{"test":"vitest run"}}\n' > "$ws/packages/beta-extras/package.json"
lists5="$work_dir/case5"
mkdir -p "$lists5"
printf 'apps/alpha/src/__tests__/a.test.ts\npackages/beta-extras/src/__tests__/d.test.ts\n' > "$lists5/shard-1.txt"
check 'a sibling-prefix package does not satisfy beta' 1 "$(run_case "$lists5")"
rm -rf "$ws/packages/beta-extras"

# Case 6: a workspace with no test-script packages at all → fail (wrong root).
ws_empty="$work_dir/ws-empty"
mkdir -p "$ws_empty/apps/only/pkg"
printf '{"name":"only","scripts":{"build":"tsc"}}\n' > "$ws_empty/apps/only/package.json"
lists6="$work_dir/case6"
mkdir -p "$lists6"
printf 'apps/only/src/x.test.ts\n' > "$lists6/shard-1.txt"
result=$(WORKSPACE_ROOT="$ws_empty" bash "$assert" "$lists6" >/dev/null 2>&1; echo $?)
check 'a workspace with no test-script packages fails' 1 "$result"

printf 'test-assert-shard-union: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
