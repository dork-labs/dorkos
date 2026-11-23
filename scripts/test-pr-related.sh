#!/usr/bin/env bash
# Fixture suite for the pull request lane that picks unit tests by import
# (DOR-5110): scripts/pr-related-scope.sh, which decides whether a change may
# take the lane, and scripts/pr-related-tests.sh, which runs it in a shard.
#
# Both directions fail quietly:
#
#   too broad  — a change the import graph cannot follow (a config, a setup
#                file, a fixture, a deleted file) runs a narrow set, goes
#                green, and is ejected from the merge queue instead.
#   too narrow — every pull request keeps running whole suites, which is the
#                cost the lane exists to cut.
#
# So every fallback has a fixture that must answer "whole suite", and the
# shapes the lane exists for (a source change with its test, a changelog
# fragment beside it) have one that must take it.
#
# Hermetic: each case builds a throwaway git repository. No network, no pnpm:
# the build, the graph reader, vitest and turbo are stubs that log their
# arguments.
#
#   bash scripts/test-pr-related.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scope=$repo_root/scripts/pr-related-scope.sh
runner=$repo_root/scripts/pr-related-tests.sh

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  echo "FAIL: $*" >&2
}

# A small monorepo: a built library (shared) and an app (server) that
# depends on it, each with a vitest config and a test. Prints its path.
fresh_repo() {
  local repo
  repo=$(mktemp -d "$work/repo.XXXXXX")
  mkdir -p "$repo/packages/shared/src/__tests__" "$repo/packages/shared/dist" \
    "$repo/apps/server/src/__tests__" "$repo/changelog/unreleased" "$repo/docs" \
    "$repo/scripts" "$repo/.github/workflows"
  echo '{ "name": "fixture", "private": true }' >"$repo/package.json"
  echo '{ "name": "@fx/shared", "scripts": { "build": "tsc", "test": "vitest run" } }' >"$repo/packages/shared/package.json"
  echo '{ "name": "@fx/server", "scripts": { "test": "vitest run" }, "dependencies": { "@fx/shared": "workspace:*" } }' >"$repo/apps/server/package.json"
  echo 'export default {};' >"$repo/packages/shared/vitest.config.ts"
  echo 'export default {};' >"$repo/apps/server/vitest.config.ts"
  echo 'export const company = "A";' >"$repo/packages/shared/src/company.ts"
  echo 'export const company = "A";' >"$repo/packages/shared/dist/company.js"
  echo "import { company } from '../company';" >"$repo/packages/shared/src/__tests__/company.test.ts"
  echo 'export const y = 1;' >"$repo/apps/server/src/app.ts"
  echo 'export const y = 1;' >"$repo/apps/server/src/__tests__/app.test.ts"
  echo "const p = join(root, 'docs');" >"$repo/apps/server/src/__tests__/docs-prose.test.ts"
  echo "const p = 'unrelated';" >"$repo/apps/server/src/__tests__/other.test.ts"
  echo '{}' >"$repo/apps/server/src/data.json"
  echo '# Docs' >"$repo/docs/index.mdx"
  echo 'echo hi' >"$repo/scripts/x.sh"
  {
    git -C "$repo" init -q -b main
    git -C "$repo" add -A
    git -C "$repo" commit -q -m base
  } >/dev/null 2>&1
  echo "$repo"
}

commit() { git -C "$1" add -A && git -C "$1" commit -q --allow-empty -m change >/dev/null; }

# decide <want related> <label> <repo> [base] [head]
decide() {
  local want=$1 label=$2 repo=$3 base=${4:-} head=${5:-} got out
  [ -n "$base" ] || base=$(git -C "$repo" rev-parse HEAD^)
  [ -n "$head" ] || head=$(git -C "$repo" rev-parse HEAD)
  out=$(cd "$repo" && bash "$scope" "$base" "$head" 2>/dev/null)
  got=$(sed -n 's/^related=//p' <<<"$out")
  if [ "$got" != "$want" ]; then
    bad "$label: expected related=$want, got '$got' ($(sed -n 's/^reason=//p' <<<"$out"))"
    return
  fi
  if [ "$want" = false ] && ! grep -qx 'vitest_files=\[\]' <<<"$out"; then
    bad "$label: a 'false' answer must hand on an empty file list"
    return
  fi
  ok
}

# ============================== the decision ==================================
r=$(fresh_repo)
echo 'export const company = "B";' >"$r/packages/shared/src/company.ts"
echo "import { company } from '../company'; // 2" >"$r/packages/shared/src/__tests__/company.test.ts"
echo '- fix' >"$r/changelog/unreleased/261123-x.md"
commit "$r"
decide true 'a source change, its test and a changelog fragment' "$r"
files=$(cd "$r" && bash "$scope" HEAD^ HEAD | sed -n 's/^vitest_files=//p')
if [ "$files" = '["changelog/unreleased/261123-x.md","packages/shared/src/__tests__/company.test.ts","packages/shared/src/company.ts"]' ]; then ok; else bad "the file list is the changed paths as JSON, got $files"; fi

r=$(fresh_repo)
echo 'more' >>"$r/docs/index.mdx"
echo 'export const y = 2;' >"$r/apps/server/src/app.ts"
commit "$r"
decide true 'docs beside a source change' "$r"

r=$(fresh_repo)
echo '{"a":1}' >"$r/apps/server/src/data.json"
commit "$r"
decide true 'a non-code file inside a package (the shard runs that suite whole)' "$r"

r=$(fresh_repo)
mkdir -p "$r/apps/server/src/setup"
echo 'export const s = 1;' >"$r/apps/server/src/setup-wizard.ts"
commit "$r"
decide true 'a source file whose name only contains "setup"' "$r"

# --- every fallback answers false ---------------------------------------------
for path in \
  package.json apps/server/package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc .env.example \
  turbo.json apps/server/turbo.json tsconfig.json apps/server/tsconfig.build.json \
  apps/server/vitest.config.ts apps/client/vite.config.ts apps/client/vite.space.config.ts \
  vitest.workspace.ts apps/server/eslint.config.mjs apps/site/next.config.mjs \
  apps/client/postcss.config.js .github/workflows/test.yml scripts/x.sh ci/metrics.yaml \
  packages/test-utils/src/index.ts packages/eslint-config/index.js \
  apps/client/src/test-setup.ts apps/server/src/setup.ts apps/desktop/src/__tests__/log-file-guard.setup.ts \
  apps/server/src/http/__tests__/contract/global-setup.ts apps/server/src/vitest.setup.ts \
  apps/server/src/__tests__/helpers.ts apps/server/src/__mocks__/fs.ts \
  apps/server/src/__tests__/__snapshots__/app.test.ts.snap apps/server/src/fixtures/room.json \
  apps/server/src/services/x/__fixtures__/a.ts apps/server/src/testing/fake-clock.ts \
  apps/server/src/lib/test-utils.ts apps/server/src/lib/room.fixture.ts apps/server/src/lib/db.mock.ts \
  apps/e2e/tests/a.spec.ts Dockerfile .agents/harness.manifest.json .claude/settings.json; do
  r=$(fresh_repo)
  mkdir -p "$r/$(dirname "$path")"
  echo 'changed' >>"$r/$path"
  commit "$r"
  decide false "a change to $path" "$r"
done

r=$(fresh_repo)
git -C "$r" rm -q apps/server/src/app.ts
commit "$r"
decide false 'a deleted source file' "$r"

r=$(fresh_repo)
git -C "$r" mv apps/server/src/app.ts apps/server/src/main.ts
commit "$r"
decide false 'a renamed source file (a delete plus an add)' "$r"

r=$(fresh_repo)
chmod +x "$r/apps/server/src/app.ts"
commit "$r"
decide true 'a mode change alone is a modify' "$r"

r=$(fresh_repo)
commit "$r"
decide false 'an empty diff' "$r"

r=$(fresh_repo)
out=$(cd "$r" && bash "$scope" deadbeef HEAD 2>/dev/null)
if grep -qx 'related=false' <<<"$out"; then ok; else bad "an unresolvable base must answer false, got: $out"; fi
out=$(cd "$r" && bash "$scope" 2>/dev/null)
if grep -qx 'related=false' <<<"$out"; then ok; else bad "no arguments must answer false, got: $out"; fi

# ============================== the shard runner ===============================
# Stubs: each logs its arguments, one call per line, to $log.
stubs=$work/stubs
mkdir -p "$stubs"
cat >"$stubs/build" <<'EOF'
#!/usr/bin/env bash
echo "build $*" >>"$LOG"
EOF
cat >"$stubs/vitest" <<'EOF'
#!/usr/bin/env bash
echo "vitest $(basename "$PWD") $*" >>"$LOG"
[ -z "${VITEST_FAILS:-}" ] || exit 1
EOF
cat >"$stubs/turbo" <<'EOF'
#!/usr/bin/env bash
echo "turbo $*" >>"$LOG"
EOF
# The graph: a test is related when it is named, or when its text holds the
# stem of a named file (`company` for company.ts or dist/company.js), which
# stands in for an import. RELATED_FAILS breaks it.
cat >"$stubs/related" <<'EOF'
#!/usr/bin/env bash
[ -z "${RELATED_FAILS:-}" ] || exit 1
shift
echo "related $(basename "$PWD") $*" >>"$LOG"
for test in $(git ls-files | grep -E '\.test\.ts$'); do
  abs=$PWD/$test
  for arg in "$@"; do
    stem=${arg##*/}
    stem=${stem%%.*}
    if [ "$arg" = "$abs" ] || grep -q -- "$stem" "$test"; then echo "$abs"; fi
  done
done | sort -u
EOF
chmod +x "$stubs"/*

# run_shard <repo> <json> <packages> <dirs> [env...]: prints the exit code;
# the log is in $repo/log.
run_shard() {
  local repo=$1 json=$2 packages=$3 dirs=$4
  shift 4
  : >"$repo/log"
  (
    cd "$repo" &&
      env LOG="$repo/log" PACKAGES="$packages" DIRS="$dirs" \
        BUILD_TEST_DEPS="$stubs/build" RELATED_TESTS="$stubs/related" VITEST="$stubs/vitest" TURBO="$stubs/turbo" \
        "$@" bash "$runner" 2/6 "$json" >"$repo/out" 2>&1
  )
  echo $?
}

has() { grep -qE -- "$2" "$1/log" || bad "$3: expected a log line matching '$2' in: $(tr '\n' '|' <"$1/log")"; }
lacks() { ! grep -qE -- "$2" "$1/log" || bad "$3: expected no log line matching '$2' in: $(tr '\n' '|' <"$1/log")"; }
check() {
  local before=$fail
  "$@"
  [ "$fail" -ne "$before" ] || ok
}
# exits <want> <got> <label>
exits() { [ "$2" = "$1" ] || bad "$3: expected exit $1, got $2"; }
# says <repo> <text> <label>: the runner's output names the reason.
says() { grep -qF -- "$2" "$1/out" || bad "$3: expected '$2' in: $(cat "$1/out")"; }

both='@fx/shared @fx/server'
both_dirs='packages/shared apps/server'

# A shared source change: shared runs its own importing test, and the server
# runs the test that imports the built copy, and nothing else.
r=$(fresh_repo)
echo 'import { company } from "@fx/shared/company";' >"$r/apps/server/src/__tests__/app.test.ts"
commit "$r"
code=$(run_shard "$r" '["packages/shared/src/company.ts"]' "$both" "$both_dirs")
check exits 0 "$code" 'a related run passes'
check has "$r" '^build --filter=@fx/shared --filter=@fx/server$' 'builds every planned package first'
check has "$r" 'related server .*/packages/shared/dist/company\.js' 'the server reads the built copy of a dependency'
check has "$r" '^vitest shared run .*--shard=2/6 .*/packages/shared/src/__tests__/company\.test\.ts$' 'shared runs its importing test on the shard'
check has "$r" '^vitest server run .*--shard=2/6 .*--passWithNoTests .*/apps/server/src/__tests__/app\.test\.ts$' 'the server runs its importing test'
check lacks "$r" 'other\.test\.ts|docs-prose' 'tests that neither import nor name the change stay out'
check lacks "$r" '^turbo' 'no suite runs whole'

# Prose outside the packages: the tests that quote its top folder run.
r=$(fresh_repo)
echo 'more' >>"$r/docs/index.mdx"
echo 'export const y = 2;' >"$r/apps/server/src/app.ts"
echo "import './app';" >"$r/apps/server/src/__tests__/app.test.ts"
commit "$r"
code=$(run_shard "$r" '["apps/server/src/app.ts","docs/index.mdx"]' '@fx/server' 'apps/server')
check exits 0 "$code" 'docs beside code passes'
check has "$r" '^vitest server run .*docs-prose\.test\.ts' "a test that quotes 'docs' runs"
check lacks "$r" 'other\.test\.ts' 'an unrelated test stays out'

# A dependent with nothing importing the change runs nothing.
r=$(fresh_repo)
echo 'export const z = 1;' >"$r/packages/shared/src/other.ts"
echo 'export const z = 1;' >"$r/packages/shared/dist/other.js"
echo 'import "../other";' >"$r/packages/shared/src/__tests__/company.test.ts"
commit "$r"
code=$(run_shard "$r" '["packages/shared/src/other.ts"]' "$both" "$both_dirs")
check exits 0 "$code" 'a dependent with nothing to run passes'
check lacks "$r" '^vitest server' 'a dependent with no importing test runs nothing'
check lacks "$r" '^turbo' 'and nothing runs whole'

# --- each per-package fallback runs that suite whole ---------------------------
r=$(fresh_repo)
code=$(run_shard "$r" '["apps/server/src/data.json"]' '@fx/server' 'apps/server')
check has "$r" '^turbo test --continue --concurrency=1 --only --filter=@fx/server -- --run --shard=2/6 ' 'a non-code file in the package runs it whole'
check exits 0 "$code" "a whole-suite fallback passes when the suite does"
check says "$r" 'is not a code module' 'a non-code file says why'

r=$(fresh_repo)
echo 'export const y = 2;' >"$r/apps/server/src/app.ts"
commit "$r"
code=$(run_shard "$r" '["apps/server/src/app.ts"]' '@fx/server' 'apps/server')
check has "$r" '^turbo test .*--filter=@fx/server' 'owned source with no importing test runs the suite whole'
check exits 0 "$code" "a whole-suite fallback passes when the suite does"
check says "$r" 'no test imports it' 'owned source with no test says why'

r=$(fresh_repo)
rm "$r/packages/shared/dist/company.js"
code=$(run_shard "$r" '["packages/shared/src/company.ts"]' '@fx/server' 'apps/server')
check has "$r" '^turbo test .*--filter=@fx/server' 'a dependency source with no built copy runs the dependent whole'
check exits 0 "$code" "a whole-suite fallback passes when the suite does"
check lacks "$r" '^related server' 'without reading its graph'

r=$(fresh_repo)
code=$(run_shard "$r" '["apps/server/src/app.ts"]' '@fx/server' 'apps/server' RELATED_FAILS=1)
check has "$r" '^turbo test .*--filter=@fx/server' 'an unreadable graph runs the suite whole'
check exits 0 "$code" "a whole-suite fallback passes when the suite does"
check says "$r" 'could not be read' 'an unreadable graph says why'

r=$(fresh_repo)
rm "$r/apps/server/vitest.config.ts"
code=$(run_shard "$r" '["apps/server/src/app.ts"]' '@fx/server' 'apps/server')
check has "$r" '^turbo test .*--filter=@fx/server' 'a package with no vitest config runs whole'
check exits 0 "$code" "a whole-suite fallback passes when the suite does"

r=$(fresh_repo)
code=$(run_shard "$r" '["apps/server/src/app.ts"]' 'fixture' '.')
check has "$r" '^turbo test .*--filter=fixture' 'the root package runs whole'
check exits 0 "$code" "a whole-suite fallback passes when the suite does"

# --- a red run is red, and a lost list is not a pass ---------------------------
r=$(fresh_repo)
code=$(run_shard "$r" '["packages/shared/src/__tests__/company.test.ts"]' '@fx/shared' 'packages/shared' VITEST_FAILS=1)
check exits 1 "$code" 'a failed related run'
check exits 1 "$(grep -c '^vitest' "$r/log")" 'a failed related run is not retried (vitest calls)'
check lacks "$r" '^turbo' 'nor fall back to the whole suite'

r=$(fresh_repo)
for json in '[]' 'not json' '{"a":1}'; do
  code=$(run_shard "$r" "$json" '@fx/server' 'apps/server')
  check exits 1 "$code" "the list $json"
done
code=$(run_shard "$r" '["apps/server/src/app.ts"]' '@fx/server @fx/shared' 'apps/server')
check exits 1 "$code" 'packages and dirs that do not pair up'
code=$(run_shard "$r" '["apps/server/src/app.ts"]' '' '')
check exits 1 "$code" 'an empty plan'

echo "pr-related: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
