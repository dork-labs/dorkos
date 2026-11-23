#!/usr/bin/env bash
# Decide whether a pull request's unit tests can be chosen by import
# (DOR-5110, ledger 261123-195117). test.yml's test-shard-count runs
# this; the test shards then run scripts/pr-related-tests.sh, which runs, in
# each suite scripts/pr-test-plan.sh selected, only the test files that import
# a changed file (Vitest's own import graph, `vitest related`).
#
# WHY. The plan picks whole suites. One changed line in @dorkos/shared moves
# the hash of nearly every suite, so a one-line change (DOR-4833) ran nearly
# every test file in the monorepo on the pull request.
#
# THE MERGE QUEUE AND THE CANARY NEVER ASK. They run every suite on six shards,
# so nothing reaches `main` on this lane's choice alone. A release pull request
# never asks either (the workflow maps it to another event).
#
# WHAT THIS DECIDES. Whether the whole change is safe to grade by import. It
# answers `related=false` (every planned suite runs whole, as before) when any
# changed path is one an import graph cannot follow or that decides how tests
# run:
#
#   - a deleted file, or any change that is not an add or a modify (a rename
#     is a delete plus an add here: `--no-renames`);
#   - config: any package.json, lockfile, workspace file, .npmrc, .nvmrc,
#     .node-version, .env*, turbo.json, tsconfig*.json, vite/vitest config,
#     eslint config, and babel/postcss/tailwind/next/playwright/electron-vite
#     config, anywhere in the tree;
#   - anything under .github/, scripts/ or ci/, and the shared test and
#     tooling packages (test-utils, eslint-config, typescript-config);
#   - setup files, test utilities, mocks, fixtures and snapshots: a path with
#     a __mocks__, __fixtures__, __snapshots__, __helpers__, fixtures, fixture,
#     mocks, test-utils, test-helpers, testing, test or tests directory, a
#     setup file (setup.*, setupTests.*, test-setup.*, global-setup.*,
#     vitest.setup.*, *.setup.*), a file named like a mock, a fixture or a test
#     utility (*.mock.*, fixtures.*, test-utils.*), and any file under
#     __tests__/ that is not itself a test file;
#   - a file outside apps/ and packages/ that is not prose: only changelog/,
#     docs/, blog/, research/, meta/, plans/, specs/, decisions/, contributing/
#     and Markdown at the root may sit beside a related run. Those are read by
#     a few tests through the file system, not by import; the shard script runs
#     every test that quotes their folder (see scripts/pr-related-tests.sh).
#
# Files inside a package that are not code (JSON, CSS, Markdown, assets) do not
# stop the lane here: the shard script runs that one package's suite whole.
#
# EVERY DOUBT ANSWERS FALSE: wrong arguments, a revision git cannot resolve, a
# diff that errors, or an empty diff. The workflow runs this script as it
# stands on the BASE commit, so a pull request cannot edit the rule that grades
# it (and one touching scripts/ answers false anyway).
#
# Usage: scripts/pr-related-scope.sh <base-sha> <head-sha>
# Prints `related=true|false`, `reason=<one line>` and
# `vitest_files=<JSON array of the changed paths>` (empty when false), in
# GITHUB_OUTPUT form. Exits 0. Pinned by scripts/test-pr-related-scope.sh.

set -uo pipefail

no() {
  printf 'related=false\nreason=%s\nvitest_files=[]\n' "$1"
  exit 0
}

[ $# -eq 2 ] && [ -n "$1" ] && [ -n "$2" ] || no 'usage: pr-related-scope.sh <base-sha> <head-sha>'
command -v jq >/dev/null 2>&1 || no 'jq is not on PATH'
base=$(git rev-parse --verify --quiet "$1^{commit}") || no "cannot resolve the base $1"
head=$(git rev-parse --verify --quiet "$2^{commit}") || no "cannot resolve the head $2"

# Captured before it is read, so a git failure is a failure and never an empty
# diff. core.quotePath=false so a non-ASCII path comes out as itself.
status=$(git -c core.quotePath=false diff --no-renames --name-status "$base" "$head") ||
  no 'git could not diff the base against the head'
[ -n "$status" ] || no 'the diff is empty'

changed=()
while IFS=$'\t' read -r kind path; do
  [ -n "$kind" ] || continue
  case $kind in
    A | M) ;;
    *) no "a file was deleted or changed type ($kind $path); the import graph cannot follow it" ;;
  esac
  changed+=("$path")
done <<<"$status"

code_ext='\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$'
for path in "${changed[@]}"; do
  base_name=${path##*/}
  dir=${path%/*}
  [ "$dir" = "$path" ] && dir=''

  # Config, anywhere in the tree.
  if grep -qE '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.nvmrc|\.node-version|turbo\.json)$|^\.env|^tsconfig([.-][^/]*)?\.json$|^(vite|vitest)([.-][^/]*)?\.(ts|mts|cts|js|mjs|cjs|json)$|^eslint\.config\.|^\.eslintrc|^(babel|postcss|tailwind|next|playwright|electron\.vite)\.config\.' <<<"$base_name"; then
    no "config changed: $path"
  fi
  # How tests are chosen and run, and the shared test tooling.
  if grep -qE '^(\.github|scripts|ci)/|^packages/(test-utils|eslint-config|typescript-config)/' <<<"$path"; then
    no "test tooling changed: $path"
  fi
  # Setup files, test utilities, mocks, fixtures and snapshots.
  if grep -qE '(^|/)(__mocks__|__fixtures__|__snapshots__|__helpers__|fixtures?|mocks|test-utils|test-helpers|testing|tests?)(/|$)' <<<"$dir"; then
    no "a test utility, fixture, mock or snapshot changed: $path"
  fi
  if grep -qE '^(setup|setupTests|setup-tests|test-setup|global-setup|vitest\.setup)\.|\.setup\.[a-z]+$|(^|[._-])(mocks?|fixtures?|test-?utils?|test-?helpers?)\.' <<<"$base_name"; then
    no "a setup file, mock or fixture changed: $path"
  fi
  if grep -qE '(^|/)__tests__/' <<<"$path" && ! grep -qE "\\.(test|spec)$code_ext" <<<"$base_name"; then
    no "a helper beside the tests changed: $path"
  fi
  # Outside the workspace packages, only prose.
  if ! grep -qE '^(apps|packages)/[^/]+/' <<<"$path" &&
    ! grep -qE '^(changelog|docs|blog|research|meta|plans|specs|decisions|contributing)/|^[^/]+\.mdx?$' <<<"$path"; then
    no "a file outside the packages that no import reaches changed: $path"
  fi
done

files=$(printf '%s\n' "${changed[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))') ||
  no 'jq could not write the file list'
printf 'related=true\nreason=%s\nvitest_files=%s\n' \
  "${#changed[@]} changed file(s), none of them config, test tooling or a deleted file" "$files"
