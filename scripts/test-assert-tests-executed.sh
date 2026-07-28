#!/usr/bin/env bash
# Fixture suite for scripts/assert-tests-executed.sh, the check that decides
# whether the `test` workflow's green means anything.
#
# It exists because that script IS the gate. If it stops discriminating, the CI
# job goes back to reporting green off a 280ms turbo cache replay and nobody
# finds out — which is the exact failure DOR-544 was filed for. So the two
# verdicts are pinned here against synthetic run summaries: a real run must
# pass, and a replayed or truncated run must fail.
#
# The negative half matters as much as the positive half. A check that fails on
# a genuine run gets deleted within a week, so the "clean run passes" and "a
# package with no test script is not counted" cases are pinned too.
#
# HERMETIC, on purpose (same reason changelog-fragment-check.yml says so about
# its analyzer suite): every case builds a throwaway workspace in a temp dir and
# points the script at it with WORKSPACE_ROOT. Nothing here reads this repo's
# real packages or its real .turbo/runs, so the suite cannot start red-lighting
# unrelated PRs the day someone adds a package.
#
#   bash scripts/test-assert-tests-executed.sh
#   ASSERT=/path/to/other.sh bash scripts/test-assert-tests-executed.sh
#
# ASSERT exists so a neutered implementation can be run against the same
# fixtures to show what it stops catching.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
assert=${ASSERT:-$repo_root/scripts/assert-tests-executed.sh}

work_dir=$(mktemp -d -t assert-tests-executed.XXXXXX)
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

# Build a workspace root containing one package.json per named package, and a
# turbo run summary containing one `test` task per "pkg:STATUS" pair.
#
#   make_root <name> --packages a,b,c --tasks "a:MISS b:HIT"
#
# `--packages` names every package that declares a `test` script; `--no-test`
# names packages that exist but declare none (they must not be counted).
make_root() {
  # Split, not one `local`: bash expands every word on a `local` line before it
  # performs any of the assignments, so `root=$work_dir/$name` on the same line
  # would read an unset `name`.
  local name=$1
  local root=$work_dir/$name
  shift
  local with_test='' without_test='' tasks=''
  while [ $# -gt 0 ]; do
    case $1 in
      --packages) with_test=$2 ;;
      --no-test) without_test=$2 ;;
      --tasks) tasks=$2 ;;
    esac
    shift 2
  done

  mkdir -p "$root/apps" "$root/packages" "$root/.turbo/runs"

  local pkg
  for pkg in ${with_test//,/ }; do
    mkdir -p "$root/packages/$pkg"
    printf '{"name":"%s","scripts":{"test":"vitest run"}}\n' "$pkg" \
      >"$root/packages/$pkg/package.json"
  done
  for pkg in ${without_test//,/ }; do
    mkdir -p "$root/packages/$pkg"
    printf '{"name":"%s","scripts":{"build":"tsc"}}\n' "$pkg" \
      >"$root/packages/$pkg/package.json"
  done

  # A real summary also carries `build` tasks, which legitimately cache. Include
  # one HIT build task everywhere so a check that looked at `execution.cached`
  # or at every task instead of only the `test` ones would fail these fixtures.
  {
    printf '{"id":"fixture","execution":{"success":1,"failed":0,"cached":1,"attempted":2,"exitCode":0},"tasks":['
    printf '{"taskId":"builder#build","task":"build","cache":{"status":"HIT"}}'
    local entry
    for entry in $tasks; do
      printf ',{"taskId":"%s#test","task":"test","cache":{"status":"%s"}}' \
        "${entry%%:*}" "${entry##*:}"
    done
    printf ']}\n'
  } >"$root/.turbo/runs/run.json"

  printf '%s' "$root"
}

# Run the script against a workspace root and report `ok` or `refused`.
verdict() {
  local root=$1 output status
  output=$(WORKSPACE_ROOT="$root" bash "$assert" 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    printf 'ok'
  else
    printf 'refused'
  fi
  # Surface the message when a case is being debugged.
  [ -n "${VERBOSE:-}" ] && printf '\n--- %s ---\n%s\n' "$root" "$output" >&2
  return 0
}

# --- The run really happened -------------------------------------------------

check 'every test task a cache MISS is accepted' ok \
  "$(verdict "$(make_root all-miss --packages alpha,beta --tasks 'alpha:MISS beta:MISS')")"

check 'a package with no test script is not expected to produce a task' ok \
  "$(verdict "$(make_root no-test-script --packages alpha --no-test icons,tsconfig --tasks 'alpha:MISS')")"

# --- The run was replayed rather than executed -------------------------------

check 'a fully replayed run is refused' refused \
  "$(verdict "$(make_root all-hit --packages alpha,beta --tasks 'alpha:HIT beta:HIT')")"

check 'a single replayed task is refused' refused \
  "$(verdict "$(make_root one-hit --packages alpha,beta --tasks 'alpha:MISS beta:HIT')")"

# --- The run covered less than it claimed ------------------------------------

check 'a run missing a package test suite is refused' refused \
  "$(verdict "$(make_root short --packages alpha,beta,gamma --tasks 'alpha:MISS beta:MISS')")"

check 'a run with no test tasks at all is refused' refused \
  "$(verdict "$(make_root empty --packages alpha --tasks '')")"

# --- There is nothing to check ------------------------------------------------

missing=$(make_root missing-summary --packages alpha --tasks 'alpha:MISS')
rm -f "$missing/.turbo/runs/run.json"
check 'a missing run summary is refused, never assumed green' refused "$(verdict "$missing")"

malformed=$(make_root malformed --packages alpha --tasks 'alpha:MISS')
printf 'not json at all\n' >"$malformed/.turbo/runs/run.json"
check 'an unreadable run summary is refused' refused "$(verdict "$malformed")"

# A root with no packages at all means the script is pointed somewhere wrong;
# reporting success there would certify an empty world.
bare=$(make_root bare --packages '' --tasks '')
check 'a workspace with no test-bearing packages is refused' refused "$(verdict "$bare")"

# -----------------------------------------------------------------------------

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
