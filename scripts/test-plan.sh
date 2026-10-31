#!/usr/bin/env bash
# Decide which package test suites a pull request's `test-shard` jobs run
# (DOR-3518, ledger 261031-165048). The merge queue and the main canary never
# read this: they always run every suite.
#
# WHY NOT `turbo test --affected`. It picks packages by which FILES changed and
# ignores every task's `inputs`. turbo.json declares the reads the suites make
# outside their own package (`@dorkos/server#test` reads contributing/, the
# Dockerfile, apps/space and more), and `--affected` ran zero test tasks for a
# change to one of them. A file outside every package fans out to nothing.
#
# WHAT THIS DOES INSTEAD. It asks turbo for the task graph twice, once on the
# base commit and once on the head, and keeps the `test` tasks whose HASH
# changed. A task hash covers the package's own files, every declared input,
# the hashes of the tasks it depends on (so a change to @dorkos/shared reaches
# every suite that builds on it), the lockfile entries it uses and its
# definition in turbo.json. It is the rule a turbo cache uses to decide a result
# can be replayed, read here to decide a suite can be skipped.
#
# WHAT IT CANNOT SEE: a test that reads a file nobody declared. Declaring it in
# turbo.json is the fix. The merge queue runs every suite, so a read nobody
# declared is caught there, never on `main`.
#
# A PULL REQUEST CANNOT SELECT ITS OWN TESTS AWAY (Security, #dorkos
# 2026-10-31). test.yml runs this script as it stands on the BASE commit, and a
# change to anything that decides what a hash covers or how the suites run
# prints `full` before turbo is asked: turbo.json, any package.json,
# pnpm-lock.yaml, pnpm-workspace.yaml, .npmrc, the root vitest.config.ts,
# .github/, scripts/ and ci/.
#
# EVERY DOUBT RUNS EVERYTHING. A base or head git cannot resolve, a checkout
# that is not at the head, a turbo run that fails or prints something that is
# not its JSON, a package name that is not a plain npm name, or a plan that
# selects nothing while a file other than Markdown changed: each prints `full`.
# A non-zero exit means the same to the caller.
#
# Usage: scripts/test-plan.sh <base-sha> <head-sha>
#   Works on the checkout it lives in, or on REPO_ROOT when set (the workflow
#   runs a copy read from the base commit), which must be at <head-sha>.
#   TURBO names the turbo command (default `pnpm exec turbo`).
#
# Prints exactly one of:
#   full                  run every suite
#   none                  only Markdown changed and no suite's hash moved
#   selected              then one `<package> <directory>` line per suite to run
# Reasons go to stderr. Pinned by scripts/__tests__/test-plan.test.ts.

set -uo pipefail

full() {
  printf 'test-plan: running every suite: %s\n' "$1" >&2
  echo full
  exit 0
}

cd "${REPO_ROOT:-$(dirname "${BASH_SOURCE[0]}")/..}" || full 'cannot enter the checkout'

base=${1:-}
head=${2:-}
[ -n "$base" ] && [ -n "$head" ] || full 'usage: test-plan.sh <base-sha> <head-sha>'
command -v jq >/dev/null 2>&1 || full 'jq is not on PATH'

base=$(git rev-parse --verify --quiet "$base^{commit}") || full "the base $1 is not a commit here"
head=$(git rev-parse --verify --quiet "$head^{commit}") || full "the head $2 is not a commit here"
[ "$(git rev-parse HEAD 2>/dev/null)" = "$head" ] || full 'this checkout is not at the head commit'

# Captured before it is read, so a git failure is a failure and never an empty
# diff. `--no-renames` so a file moved out of a folder reports its source too.
changed=$(git -c core.quotePath=false diff --no-renames --name-only "$base" "$head") ||
  full 'git could not diff the base against the head'
[ -n "$changed" ] || full 'the diff is empty'

# Security's list: a change here can alter what a hash covers or how a suite
# runs, so the pull request is not allowed to be graded by it.
escape=$(printf '%s\n' "$changed" | grep -E '^(turbo\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|vitest\.config\.ts|(.*/)?package\.json|\.github/.*|scripts/.*|ci/.*)$')
[ -z "$escape" ] || full "a file that decides what runs changed: $(printf '%s' "$escape" | head -n 5 | tr '\n' ' ')"

turbo=${TURBO:-pnpm exec turbo}
work=$(mktemp -d "${TMPDIR:-/tmp}/test-plan.XXXXXX") || full 'no scratch directory'
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
  # shellcheck disable=SC2086 # TURBO is a command line; split on purpose.
  out=$(cd "$1" && $turbo test --dry=json 2>/dev/null) || return 1
  printf '%s' "$out" | jq -er '[.tasks[] | select(.task == "test")] | if length == 0 then error("no test tasks") else .[] | "\(.taskId) \(.hash) \(.package) \(.directory)" end'
}

base_tasks=$(tasks "$work/base") || full 'turbo could not plan the base commit'
head_tasks=$(tasks "$PWD") || full 'turbo could not plan the head commit'

# A head task is kept when no base task has the same id AND the same hash.
selected=$(awk 'NR == FNR { seen[$1 " " $2] = 1; next } !(($1 " " $2) in seen) { print $3, $4 }' \
  <(printf '%s\n' "$base_tasks") <(printf '%s\n' "$head_tasks") | sort)

if [ -z "$selected" ]; then
  # Nothing any suite hashes moved. Markdown alone may then run nothing; any
  # other file is a read nobody declared until proven otherwise.
  code=$(printf '%s\n' "$changed" | grep -vE '\.(md|mdx)$')
  [ -z "$code" ] || full "no suite hash changed, but a non-Markdown file did: $(printf '%s' "$code" | head -n 5 | tr '\n' ' ')"
  echo 'test-plan: only Markdown changed and no suite reads it' >&2
  echo none
  exit 0
fi

# Plain npm names and repo-relative directories only: these become turbo
# filters and step outputs, so anything else is refused rather than passed on.
printf '%s\n' "$selected" | grep -qvE '^[@a-z0-9][a-z0-9._/@-]* (apps|packages)/[A-Za-z0-9._-]+$' &&
  full 'turbo named a package or directory this script will not pass on'

count=$(printf '%s\n' "$selected" | wc -l | tr -d ' ')
total=$(printf '%s\n' "$head_tasks" | wc -l | tr -d ' ')
printf 'test-plan: %s of %s suites changed hash and will run.\n' "$count" "$total" >&2
echo selected
printf '%s\n' "$selected"
