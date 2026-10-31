#!/usr/bin/env bash
# Decide which package test suites a pull request's `test` leg runs (DOR-3518,
# ledger 261031-164008). The merge queue and the main canary never use this:
# they always run every suite.
#
# WHY NOT `turbo test --affected`, which the leg ran until now. It picks
# packages by which FILES changed and ignores every task's `inputs`.
# turbo.json declares the cross-package reads the suites really make
# (`@dorkos/server#test` reads contributing/, the Dockerfile, apps/space and
# more), and `--affected` ran zero test tasks for a change to one of them.
#
# WHAT THIS DOES INSTEAD. It asks turbo for the task graph twice, once on the
# base commit and once on the head, and keeps the `test` tasks whose HASH
# changed. A task hash covers the package's own files, every declared input,
# the hashes of the tasks it depends on (so a change to @dorkos/shared reaches
# every suite that builds on it), the lockfile entries it uses and its
# definition in turbo.json.
#
# WHAT IT CANNOT SEE: a test that reads a file nobody declared. Declaring it in
# turbo.json is the fix. The merge queue runs every suite, so nothing reaches
# `main` on this leg's choice alone.
#
# A CHANGE CANNOT SELECT ITS OWN TESTS AWAY. A change to anything that decides
# how tests are chosen, installed or run (turbo.json, any package.json, the
# lockfile, the workspace, .npmrc, the root vitest config, .github/,
# scripts/ or ci/) runs every suite. The workflow runs a copy of this script
# read from the base commit, so a change to it does not grade itself either.
#
# EVERY DOUBT RUNS EVERYTHING. A base or head git cannot resolve, a checkout
# that is not at the head, a turbo run that fails or prints something that is
# not its JSON, or a plan that selects nothing: each prints `full`. A non-zero
# exit means the same to the caller.
#
# Usage: scripts/pr-test-plan.sh <base-sha> <head-sha>
#   Works on the checkout it lives in, or on REPO_ROOT when set, which must be
#   at <head-sha>. TURBO names the turbo command (default `pnpm exec turbo`);
#   scripts/__tests__/pr-test-plan.test.ts points it at a stub for the failure
#   cases and at the real binary for the rest.
#
# Prints `full`, or `selected` followed by one `<package> <directory>` line per
# suite to run. Reasons go to stderr.

set -uo pipefail

full() {
  printf 'pr-test-plan: running every suite: %s\n' "$1" >&2
  echo full
  exit 0
}

cd "${REPO_ROOT:-$(dirname "${BASH_SOURCE[0]}")/..}" || full 'cannot enter the checkout'

base=${1:-}
head=${2:-}
[ -n "$base" ] && [ -n "$head" ] || full 'usage: pr-test-plan.sh <base-sha> <head-sha>'
command -v jq >/dev/null 2>&1 || full 'jq is not on PATH'

base=$(git rev-parse --verify --quiet "$base^{commit}") || full "the base $1 is not a commit here"
head=$(git rev-parse --verify --quiet "$head^{commit}") || full "the head $2 is not a commit here"
[ "$(git rev-parse HEAD 2>/dev/null)" = "$head" ] || full 'this checkout is not at the head commit'

changed=$(git -c core.quotePath=false diff --no-renames --name-only "$base" "$head") ||
  full 'git could not diff the base against the head'
control=$(printf '%s\n' "$changed" |
  grep -E '^(turbo\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|vitest\.config\.ts|\.github/.*|scripts/.*|ci/.*)$|(^|/)package\.json$')
[ -z "$control" ] || full "this change touches how tests are chosen or run: $(printf '%s' "$control" | head -n 5 | tr '\n' ' ')"

turbo=${TURBO:-pnpm exec turbo}
work=$(mktemp -d "${TMPDIR:-/tmp}/pr-test-plan.XXXXXX")
cleanup() {
  git worktree remove --force "$work/base" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

git worktree add --quiet --detach "$work/base" "$base" >/dev/null 2>&1 ||
  full 'git could not check out the base commit'

# One `<taskId> <hash> <package> <directory>` line per test task, or failure.
tasks() {
  local out
  # The banner and any warning go to stderr; stdout is the JSON alone.
  out=$(cd "$1" && $turbo test --dry=json 2>/dev/null) || return 1
  printf '%s' "$out" | jq -er '[.tasks[] | select(.task == "test")] | if length == 0 then error("no test tasks") else .[] | "\(.taskId) \(.hash) \(.package) \(.directory)" end'
}

base_tasks=$(tasks "$work/base") || full 'turbo could not plan the base commit'
head_tasks=$(tasks "$PWD") || full 'turbo could not plan the head commit'

# A head task is kept when no base task has the same id AND the same hash.
selected=$(awk 'NR == FNR { seen[$1 " " $2] = 1; next } !(($1 " " $2) in seen) { print $3, $4 }' \
  <(printf '%s\n' "$base_tasks") <(printf '%s\n' "$head_tasks") | sort)
[ -n "$selected" ] || full 'no suite hash changed, and this leg never runs nothing'

count=$(printf '%s\n' "$selected" | wc -l | tr -d ' ')
total=$(printf '%s\n' "$head_tasks" | wc -l | tr -d ' ')
printf 'pr-test-plan: %s of %s suites changed hash and will run.\n' "$count" "$total" >&2
echo selected
printf '%s\n' "$selected"
