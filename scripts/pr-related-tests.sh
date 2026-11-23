#!/usr/bin/env bash
# Run a pull request's unit tests chosen by import (DOR-5110): in each suite
# scripts/pr-test-plan.sh selected, the test files Vitest's import graph ties
# to a changed file, split across the pull request's shards. test.yml's
# test-shard runs this only when test-shard-count answered `related=true`
# (scripts/pr-related-scope.sh) and the plan is `selected`; the merge queue and
# the main canary never run it, they run every suite on six shards.
#
# PER PACKAGE, WITH ITS OWN CONFIG. Each suite's selection and run happen in
# its own directory through scripts/sharding/config.ts, which loads the
# package's own vitest (or vite) config, so its aliases and setup files apply.
# scripts/related-tests.mjs reads the graph and prints the set; this script
# then runs exactly that set with `vitest run --shard=<k>/<n>`. Every shard
# reads the same graph, so the shards split one set between them.
#
# WHAT A PACKAGE'S SET HOLDS, for every changed file:
#   - the file itself (a changed test file runs as itself);
#   - for a source file in another package this one depends on and that has a
#     build, its built copy (`src/a/b.ts` -> `dist/a/b.js`): suites import a
#     workspace package's `dist/`, so that is the path in their graph. Aliases
#     to `src/` are covered by the source path above;
#   - every test file in this package that quotes the changed file's name, and,
#     for a file outside this package, every test file that quotes its top
#     folder as a path segment ('docs', "packages", /changelog/). Those are the
#     tests that read files through the file system, which no import graph sees.
#
# WHEN A PACKAGE RUNS ITS WHOLE SUITE INSTEAD (with its shard, as before):
#   - its directory is not apps/<name> or packages/<name>, or it has no vitest
#     or vite config to read the graph with;
#   - a changed file inside it is not a code module (JSON, CSS, Markdown, an
#     asset, a .d.ts): tests read those in ways no graph shows;
#   - it depends on a package whose changed source has no built copy where the
#     mapping says it should be (a bundled build, or code outside src/);
#   - the graph could not be read (scripts/related-tests.mjs failed);
#   - it owns a changed source file and the graph found no test for it.
# A package that only depends on a change and has no test importing it runs
# nothing: that is the point.
#
# A FAILED RUN IS RED. Nothing here retries or falls back after a run fails.
#
# Usage: scripts/pr-related-tests.sh <shard k/n> '<JSON array of changed paths>'
#   PACKAGES and DIRS: the plan's package names and directories, space
#   separated, in the same order (test-shard-count's outputs).
#   BUILD_TEST_DEPS, RELATED_TESTS, VITEST and TURBO replace the build, the
#   graph reader, the runner and turbo, for scripts/test-pr-related-tests.sh.

set -euo pipefail

[ $# -eq 2 ] || { echo 'usage: pr-related-tests.sh <shard k/n> <json-array>' >&2; exit 2; }
shard=$1
[[ $shard =~ ^[1-9][0-9]*/[1-9][0-9]*$ ]] || { echo "pr-related-tests: '$shard' is not a shard like 1/6" >&2; exit 2; }
list=$(jq -er 'if type == "array" and all(type == "string") and length > 0 then .[] else error("not a list of paths") end' <<<"$2") ||
  { echo 'pr-related-tests: the changed-file list is empty or not a JSON array of paths' >&2; exit 1; }
root=$(pwd)
config=$root/scripts/sharding/config.ts

files=()
while IFS= read -r file; do if [ -n "$file" ]; then files+=("$file"); fi; done <<<"$list"
read -r -a packages <<<"${PACKAGES:-}"
read -r -a dirs <<<"${DIRS:-}"
if [ ${#packages[@]} -eq 0 ] || [ ${#packages[@]} -ne ${#dirs[@]} ]; then
  echo "pr-related-tests: the plan's packages (${#packages[@]}) and directories (${#dirs[@]}) do not pair up" >&2
  exit 1
fi

filters=()
for package in "${packages[@]}"; do filters+=("--filter=$package"); done
${BUILD_TEST_DEPS:-bash scripts/build-test-deps.sh} "${filters[@]}"

code_re='\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$'
test_re="\\.(test|spec)$code_re"

# The built path a source path maps to, or nothing.
built_copy() {
  local file=$1 out
  [[ $file =~ ^((apps|packages)/[^/]+)/src/(.+)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$ ]] || return 0
  case ${BASH_REMATCH[4]} in
    mts | mjs) out=mjs ;;
    cts | cjs) out=cjs ;;
    *) out=js ;;
  esac
  echo "${BASH_REMATCH[1]}/dist/${BASH_REMATCH[3]}.$out"
}

depends_on() {
  local dir=$1 other=$2 name
  name=$(jq -r '.name // empty' "$other/package.json" 2>/dev/null) || return 1
  [ -n "$name" ] || return 1
  jq -e --arg n "$name" '[.dependencies, .devDependencies, .peerDependencies, .optionalDependencies] | map(select(. != null) | has($n)) | any' "$dir/package.json" >/dev/null 2>&1
}

whole=()
failed=()
for i in "${!packages[@]}"; do
  package=${packages[$i]}
  dir=${dirs[$i]%/}
  why=''
  paths=()
  owns_source=false

  if ! [[ $dir =~ ^(apps|packages)/[^/]+$ ]]; then
    why="its directory '$dir' is not a workspace package"
  elif ! compgen -G "$dir/vitest.config.*" >/dev/null && ! compgen -G "$dir/vite.config.*" >/dev/null; then
    why='it has no vitest or vite config to read the import graph with'
  fi

  needles=()
  tops=()
  for file in "${files[@]}"; do
    [ -z "$why" ] || break
    needles+=("${file##*/}")
    if [ -e "$file" ]; then paths+=("$root/$file"); fi
    case $file in
      "$dir"/*)
        if ! [[ $file =~ $code_re ]] || [[ $file =~ \.d\.[cm]?ts$ ]]; then
          why="$file is not a code module, and tests read such files in ways no import graph shows"
        elif ! [[ $file =~ $test_re ]]; then
          owns_source=true
        fi
        ;;
      *)
        tops+=("${file%%/*}")
        other=''
        if [[ $file =~ ^((apps|packages)/[^/]+)/ ]]; then other=${BASH_REMATCH[1]}; fi
        if [ -n "$other" ] && [[ $file =~ $code_re ]] && ! [[ $file =~ $test_re ]]; then
          if depends_on "$dir" "$other" && jq -e '.scripts.build' "$other/package.json" >/dev/null 2>&1; then
            copy=$(built_copy "$file")
            if [ -n "$copy" ] && [ -f "$copy" ]; then
              paths+=("$root/$copy")
            else
              why="it imports the build of $other, and $file has no built copy${copy:+ at $copy}"
            fi
          fi
        fi
        ;;
    esac
  done

  if [ -z "$why" ]; then
    # The tests that name a changed file or its top folder: file-system readers.
    tests=()
    while IFS= read -r -d '' test; do
      if [[ $test =~ $test_re ]] && ! [[ $test =~ \.binary\.test\.ts$ ]]; then tests+=("$test"); fi
    done < <(git ls-files -z -- "$dir")
    if [ ${#tests[@]} -gt 0 ]; then
      pattern=$(printf '%s\n' "${tops[@]+"${tops[@]}"}" | sort -u | sed 's/[.[\*^$]/\\&/g' | paste -sd'|' -)
      quoting=$(
        {
          printf '%s\n' "${tests[@]}" | tr '\n' '\0' | xargs -0 grep -l -F "${needles[@]/#/-e}" -- 2>/dev/null || true
          if [ -n "$pattern" ]; then
            printf '%s\n' "${tests[@]}" | tr '\n' '\0' | xargs -0 grep -l -E "[\"'\`/]($pattern)[\"'\`/]" -- 2>/dev/null || true
          fi
        } | sort -u
      )
      while IFS= read -r test; do if [ -n "$test" ]; then paths+=("$root/$test"); fi; done <<<"$quoting"
    fi
  fi

  selected=()
  if [ -z "$why" ]; then
    if [ ${#paths[@]} -eq 0 ]; then
      out=''
    elif ! out=$(cd "$dir" && ${RELATED_TESTS:-node "$root/scripts/related-tests.mjs"} "$config" "${paths[@]}"); then
      why='the import graph could not be read'
    fi
    while IFS= read -r test; do if [ -n "$test" ]; then selected+=("$test"); fi; done <<<"${out:-}"
  fi
  if [ -z "$why" ] && [ ${#selected[@]} -eq 0 ] && [ "$owns_source" = true ]; then
    why='it owns a changed source file and no test imports it'
  fi

  if [ -n "$why" ]; then
    echo "pr-related-tests: $package runs its whole suite: $why"
    whole+=("--filter=$package")
  elif [ ${#selected[@]} -eq 0 ]; then
    echo "pr-related-tests: $package: no test imports, or names, a changed file; nothing to run here"
  else
    echo "pr-related-tests: $package: ${#selected[@]} test file(s) tied to the change, shard $shard"
    (cd "$dir" && ${VITEST:-pnpm exec vitest} run --config="$config" --shard="$shard" --passWithNoTests --exclude='**/*.binary.test.ts' "${selected[@]}") ||
      failed+=("$package")
  fi
done

if [ ${#whole[@]} -gt 0 ]; then
  ${TURBO:-pnpm exec turbo} test --continue --concurrency=1 --only "${whole[@]}" -- --run --shard="$shard" --config=../../scripts/sharding/config.ts --passWithNoTests --exclude='**/*.binary.test.ts' ||
    failed+=("${whole[@]#--filter=}")
fi

if [ ${#failed[@]} -gt 0 ]; then
  echo "pr-related-tests: failed in ${failed[*]}" >&2
  exit 1
fi
echo 'pr-related-tests: every chosen test passed'
