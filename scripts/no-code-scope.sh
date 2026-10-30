#!/usr/bin/env bash
# Decide whether a pull request's diff can affect any test, for the six
# `test-shard (n/6)` jobs of test.yml.
#
# WHY THIS EXISTS. On a pull request each shard runs
# `turbo test --affected`. A change to the root package.json is global to
# turbo, so a PR that only bumps "version" lines (every release PR) marks EVERY
# package affected and runs nothing less than the full suite: PR #3237, a
# version bump with its changelog, ran shard 3/6 for 13m18s of turbo time, and
# each of the six shards paid 13 to 15 minutes for tests nothing in the diff
# could change. A PR that only touches the changelog or the docs is in the same
# position. `test-shard` feeds the REQUIRED `test` context, so it cannot be
# scoped by a workflow-level `paths:` filter or a job-level `if:` (either can
# leave the context skipped, and a skipped required check counts as passing):
# the jobs run on every event and this script only gates the PR leg's test
# step. The merge queue and the main canary ignore it: they always run the full
# suite, so nothing reaches `main` untested.
#
# WHAT COUNTS AS NO CODE. Every changed path must be one of:
#
#   CHANGELOG.md, VERSION       the release's compiled notes and version file
#   changelog/, docs/, blog/    fragments, user docs and posts (prose)
#   any package.json            whose ONLY change is its top-level "version" key
#                               (compared as parsed JSON with jq)
#
# Anything else, including a package.json that changes a dependency, a script,
# `packageManager`, `engines`, `overrides`, `pnpm` or any other key beside its
# version, a lockfile or an `.npmrc`, means run the shards.
#
# THE PR CANNOT GRADE ITSELF. test.yml runs this script as it stands on the
# pull request's BASE commit, never the copy in the PR's checkout, so a PR that
# edits this file is scored by the old rules (and, touching scripts/, runs the
# shards anyway).
#
# A KNOWN GAP, NOT A NEW ONE. Some server tests read docs/ (for example
# apps/server/src/services/core/__tests__/destructive-actions-prose.test.ts),
# so a docs-only change can in principle break one. `turbo --affected` already
# cannot see docs/ (it belongs to no workspace package), so such a PR ran none
# of those tests before this script either; this does not widen that gap. The
# merge queue's full suite catches it.
#
# Usage:
#   scripts/no-code-scope.sh <base-sha> <head-sha>
#
# Prints exactly one line and exits 0:
#   true    something testable may have changed; run the shards
#   false   only changelog, docs or version lines changed; skip them
# Every way of failing to decide FAILS OPEN to `true`: wrong arguments, a
# revision git cannot resolve, a diff that errors, or an empty diff. The reason
# goes to stderr.
#
# Reads only the git repository it runs in, and is pinned by
# scripts/test-no-code-scope.sh.

set -uo pipefail

run_shards() {
  echo "$1; running the shards" >&2
  echo true
  exit 0
}

[ $# -eq 2 ] && [ -n "$1" ] && [ -n "$2" ] || run_shards 'usage: no-code-scope.sh <base-sha> <head-sha>'
base=$1
head=$2

git rev-parse --verify --quiet "$base^{commit}" >/dev/null || run_shards "cannot resolve base '$base'"
git rev-parse --verify --quiet "$head^{commit}" >/dev/null || run_shards "cannot resolve head '$head'"

# Captured before it is read, so a git failure is a failure and never an empty
# diff. `core.quotePath=false` so a non-ASCII path comes out as itself rather
# than as a quoted octal escape; `--no-renames` so a file moved out of a code
# folder reports its source as well as its destination.
changed=$(git -c core.quotePath=false diff --no-renames --name-only "$base" "$head") ||
  run_shards 'git diff failed'
[ -n "$changed" ] || run_shards 'the diff is empty'

# True when <file> exists on both sides, both parse as JSON objects, only the
# TOP-LEVEL "version" key differs, and it does differ (Security, #3238 review):
# parsing rather than matching lines, so a `"version"` inside `overrides`,
# `pnpm` or a dependency's own object, or a `packageManager`, `engines` or
# dependency change beside a bump, is never read as version-only. Any read or
# parse failure is false, so the caller runs the shards.
version_only() {
  local before after
  before=$(git cat-file blob "$base:$1" 2>/dev/null) || return 1
  after=$(git cat-file blob "$head:$1" 2>/dev/null) || return 1
  local rest_before rest_after v_before v_after
  rest_before=$(jq -cS 'if type == "object" then del(.version) else error("not an object") end' <<<"$before" 2>/dev/null) || return 1
  rest_after=$(jq -cS 'if type == "object" then del(.version) else error("not an object") end' <<<"$after" 2>/dev/null) || return 1
  [ "$rest_before" = "$rest_after" ] || return 1
  v_before=$(jq -c '.version' <<<"$before" 2>/dev/null) || return 1
  v_after=$(jq -c '.version' <<<"$after" 2>/dev/null) || return 1
  [ "$v_before" != "$v_after" ]
}

while IFS= read -r path; do
  case $path in
    CHANGELOG.md | VERSION | changelog/* | docs/* | blog/*) ;;
    package.json | */package.json)
      version_only "$path" || run_shards "$path changes more than its version"
      ;;
    *) run_shards "can affect a test: $path" ;;
  esac
done <<<"$changed"

echo 'only changelog, docs or version lines changed' >&2
echo false
