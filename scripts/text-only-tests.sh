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
# NOTHING TO RUN IS NOT A PASS. A file list that names no package with a suite
# fails: the classifier always names at least one changed file, so an empty run
# means the list was lost on the way here. A package given a test file runs
# without --passWithNoTests, so a test file vitest does not collect fails too.
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
[ ${#dirs[@]} -gt 0 ] || { echo 'text-only-tests: no file belongs to a package with a test suite, so nothing would run' >&2; exit 1; }
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
