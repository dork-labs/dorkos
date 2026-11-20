#!/usr/bin/env bash
# Builds every package `turbo test` would build first, as its own turbo run
# with no `--` arguments, so the build hashes are the same in every test job
# (DOR-4625, ledger 261118-140000).
#
# WHY. Turbo hashes `turbo test`'s `--` arguments into every task of the run,
# the `^build` dependencies included (turbo 2.10.13, `--dry=json`:
# `@dorkos/shared#build` is 021e0f55… from `turbo run build`, f45d40ab… under
# `turbo test -- --run --shard=1/6` and 1493bf38… under `--shard=2/6`). So a
# build made inside a test run is cached for that exact argument list only:
# each queue shard could replay only the same shard's canary builds, the pull
# request leg and the binary lane none. Built here first, the same 24 packages
# hash the same everywhere, and the test run that follows takes `--only`, so it
# runs the `test` tasks and nothing else.
#
# WHAT IT BUILDS. Exactly the `build` tasks `turbo test <filters> --dry=json`
# lists, read from turbo itself rather than a hand-kept list, so a package that
# gains or loses a suite or a dependency changes the set with no edit here.
# `generate:api-docs` comes along through `build`'s own dependsOn.
#
# Usage:
#   scripts/build-test-deps.sh [<turbo filter flag>...]
#
# Pass the same `--filter=` flags the test run uses (none for every package).
# Prints the run summary's path on its last line as `summary=<path>` and, when
# GITHUB_OUTPUT is set, writes the same line there, for
# scripts/keep-build-cache-only.sh. Exits non-zero if the dry run cannot be
# read or the build fails; a failed build would have failed the test run too.
#
# TURBO stays overridable so scripts/test-build-test-deps.sh can stub turbo.

set -euo pipefail

turbo=${TURBO:-pnpm exec turbo}
runs_dir=${WORKSPACE_ROOT:-.}/.turbo/runs

# turbo's stderr stays in the log, so a bad filter or turbo.json says why.
if ! dry=$($turbo test "$@" --dry=json | sed -n '/^{/,$p'); then
  echo 'build-test-deps: the turbo test dry run failed (its error is above), so nothing was built.' >&2
  exit 1
fi
# An empty or non-JSON dry run must fail here, not read as "no builds".
jq -e '.tasks | type == "array"' >/dev/null 2>&1 <<<"$dry" || {
  echo 'build-test-deps: could not read the turbo test dry run as JSON with a task list.' >&2
  exit 1
}
packages=$(jq -r '[.tasks[] | select(.task == "build") | .package] | unique | .[]' <<<"$dry")

if [ -z "$packages" ]; then
  echo 'build-test-deps: the test run needs no builds.'
  exit 0
fi

filters=()
while IFS= read -r package; do filters+=("--filter=$package"); done <<<"$packages"
echo "build-test-deps: building ${#filters[@]} package(s) the suites import: $(tr '\n' ' ' <<<"$packages")"

# --concurrency=1: the same budget these builds had inside the sweep, which
# runs at --concurrency=1 for the DOR-121 reason test.yml gives.
$turbo run build --summarize --concurrency=1 "${filters[@]}"

# shellcheck disable=SC2012 # base58 run ids, nothing for `ls` to mangle.
summary=$(ls -t "$runs_dir"/*.json 2>/dev/null | head -1)
[ -n "$summary" ] || { echo "build-test-deps: no run summary under $runs_dir." >&2; exit 1; }
echo "summary=$summary"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "summary=$summary" >> "$GITHUB_OUTPUT"; fi
