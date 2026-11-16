#!/usr/bin/env bash
# Trims turbo's local cache (.turbo/cache) down to the BUILD entries of one
# run, so test.yml can hand those to the next run without ever handing it a
# `test` result (DOR-4190, ledger 261115-201939-test-shard-build-cache).
#
# WHY THIS EXISTS. Every test shard rebuilt the same ~19 packages from an empty
# turbo cache: 141-223 s per shard, `Cached: 0 cached` on every one. test.yml
# now restores .turbo/cache from GitHub's cache service before the sweep and
# saves it after the main canary's sweep. But that directory also holds the
# sweep's own `test` entries, and a restored `test` entry is exactly the replay
# scripts/assert-tests-executed.sh exists to refuse: turbo would print the
# suite green in 280 ms without running it. So before the save, everything
# that is not a `build` (or `generate:api-docs`, which `build` depends on)
# entry of THIS run is deleted.
#
# KEEP-LIST, NOT DENY-LIST. The kept hashes are read from the run summary
# `--summarize` wrote: every task whose `task` is `build` or
# `generate:api-docs`. Everything else goes, including a `test` entry, any
# task type added later, and stale entries the restore brought in that this
# run did not use (which also stops the saved entry growing run over run). A
# task type this list does not name only costs a cache miss, never a replay.
#
# If anything is unreadable — no summary, a summary that is not run-summary
# JSON, a summary with no build task — this deletes the WHOLE cache directory
# and exits 1, so nothing is saved. A missed save costs one cold run; a wrong
# save could cost a false green.
#
# Usage:
#   scripts/keep-build-cache-only.sh [<summary.json>]
#
# With no argument it reads the newest summary under .turbo/runs/, the same
# file scripts/assert-tests-executed.sh reads. WORKSPACE_ROOT overrides where
# .turbo/ is looked up, so scripts/test-keep-build-cache-only.sh can drive
# this against a temp dir.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workspace_root=${WORKSPACE_ROOT:-$repo_root}
cache_dir=$workspace_root/.turbo/cache

refuse() {
  rm -rf "$cache_dir"
  printf 'keep-build-cache-only: %s\nDeleted %s, so no turbo cache is saved from this run.\n' \
    "$1" "$cache_dir" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || refuse 'jq is required but was not found on PATH.'

summary=${1:-}
if [ -z "$summary" ]; then
  # Same lookup as assert-tests-executed.sh: base58 run ids, nothing for `ls`
  # to mangle.
  # shellcheck disable=SC2012
  summary=$(ls -t "$workspace_root"/.turbo/runs/*.json 2>/dev/null | head -1)
fi
[ -n "$summary" ] && [ -f "$summary" ] ||
  refuse "no turbo run summary under $workspace_root/.turbo/runs/."

# A turbo task hash is 16 lowercase hex characters; anything else in the
# summary's `hash` field is not something this script should match files on.
keep=$(jq -r '
  .tasks[]
  | select(.task == "build" or .task == "generate:api-docs")
  | .hash // empty
  | select(test("^[0-9a-f]{16}$"))
' "$summary" 2>/dev/null) || refuse "could not read $summary as turbo run-summary JSON."
[ -n "$keep" ] || refuse "$summary names no build task, so there is nothing to keep."

[ -d "$cache_dir" ] || refuse "no turbo cache at $cache_dir."

# Turbo 2 stores one entry as <hash>.tar.zst, <hash>-meta.json and
# <hash>-manifest.json. A file is kept only if its name is a kept hash
# followed by `.` or `-`.
kept=0
removed=0
for path in "$cache_dir"/* "$cache_dir"/.[!.]*; do
  [ -e "$path" ] || continue
  name=${path##*/}
  hash=${name:0:16}
  rest=${name:16:1}
  if [ -f "$path" ] && { [ "$rest" = '.' ] || [ "$rest" = '-' ]; } &&
    grep -qxF -- "$hash" <<<"$keep"; then
    # tar keeps the mtime an entry was first written with, and turbo prunes
    # entries older than turbo.json's `cacheMaxAge`. A build this run used is
    # current, so it should not age out just because its package is quiet.
    touch "$path"
    kept=$((kept + 1))
  else
    rm -rf "$path"
    removed=$((removed + 1))
  fi
done

[ "$kept" -gt 0 ] || refuse "none of this run's build tasks left an entry in $cache_dir."

printf 'keep-build-cache-only: kept %s file(s) for %s build task hash(es), removed %s file(s).\n' \
  "$kept" "$(grep -c . <<<"$keep")" "$removed"
