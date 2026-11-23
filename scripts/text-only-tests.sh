#!/usr/bin/env bash
# Run the tests a text-only change can reach (DOR-4834): `vitest related` in
# each workspace package that owns one of the files scripts/text-only-scope.mjs
# named. Those are the changed code and Markdown files and every test file that
# quotes a changed string's old text, so a consumer's test in another package
# (apps/site's terms page for a company.ts address) runs by name.
#
# PER PACKAGE, NOT FROM THE ROOT. A root `vitest related` loads every project's
# config and resolves every package's entry, so it needs the whole monorepo
# built; one package's own config needs only what that package imports, which
# scripts/build-test-deps.sh builds first.
#
# A LOST LIST IS NOT A PASS. An empty file list, or one that is not a JSON
# array of paths, fails: the classifier always names at least one changed file,
# so either means the list was lost on the way here. A package given a test
# file runs without --passWithNoTests, so a test file vitest does not collect
# fails too.
#
# A LIST OUTSIDE EVERY PACKAGE SUITE IS NOT LOST (DOR-5024). A change to
# Markdown in meta/, plans/ or research/ alone names real files, but none a
# package suite can see, and no package test quotes them. Nothing runs and the
# step passes, as the shards would for the same change: they run package suites
# only (root scripts/ tests run in scripts-test.yml), and the merge queue runs
# every suite on every entry.
#
# Never runs a PR's own edit of itself: anything under scripts/ is not text
# only, so a change to this file runs the full suite instead.
#
# Usage: scripts/text-only-tests.sh '<JSON array of repo paths>'
# BUILD_TEST_DEPS and VITEST replace the build and the runner, for the fixture
# suite (scripts/__tests__/text-only-scope.test.ts).

set -euo pipefail

[ $# -eq 1 ] || { echo 'usage: text-only-tests.sh <json-array>' >&2; exit 2; }
list=$(jq -er 'if type == "array" and all(type == "string") then .[] else error("not a list of paths") end' <<<"$1") ||
  { echo 'text-only-tests: the file list is not a JSON array of paths' >&2; exit 1; }
files=()
while IFS= read -r file; do if [ -n "$file" ]; then files+=("$file"); fi; done <<<"$list"
[ ${#files[@]} -gt 0 ] || { echo 'text-only-tests: the file list is empty' >&2; exit 1; }

dirs=()
for file in "${files[@]}"; do
  if [[ $file =~ ^((apps|packages)/[^/]+)/ ]] && jq -e '.scripts.test' "${BASH_REMATCH[1]}/package.json" >/dev/null 2>&1; then
    dirs+=("${BASH_REMATCH[1]}")
  else
    echo "text-only-tests: $file belongs to no package suite; the tests that quote it were found by name instead"
  fi
done
if [ ${#dirs[@]} -eq 0 ]; then
  echo 'text-only-tests: no named file belongs to a package with a test suite, so nothing runs here; the merge queue runs every suite'
  exit 0
fi
unique=$(printf '%s\n' "${dirs[@]}" | sort -u)
dirs=()
while IFS= read -r dir; do dirs+=("$dir"); done <<<"$unique"

filters=()
for dir in "${dirs[@]}"; do filters+=("--filter=./$dir"); done
${BUILD_TEST_DEPS:-bash scripts/build-test-deps.sh} "${filters[@]}"

failed=()
for dir in "${dirs[@]}"; do
  own=()
  pass=(--passWithNoTests)
  for file in "${files[@]}"; do
    case $file in
      "$dir"/*)
        own+=("${file#"$dir"/}")
        case $file in *.test.*) pass=() ;; esac
        ;;
    esac
  done
  echo "text-only-tests: $dir: vitest related ${own[*]}"
  (cd "$dir" && ${VITEST:-pnpm exec vitest} related --run ${pass[@]+"${pass[@]}"} --exclude='**/*.binary.test.ts' "${own[@]}") || failed+=("$dir")
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "text-only-tests: failed in ${failed[*]}" >&2
  exit 1
fi
echo "text-only-tests: every related suite passed in ${dirs[*]}"
