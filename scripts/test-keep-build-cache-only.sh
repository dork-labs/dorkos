#!/usr/bin/env bash
# Fixture suite for scripts/keep-build-cache-only.sh, the trim test.yml runs
# before it saves turbo's local cache for the next run's shards.
#
# The case that matters most: a `test` entry must never survive. If one did,
# the next queue run would replay that suite from cache, and the best outcome
# is assert-tests-executed.sh failing the shard. So the suite pins that every
# test entry goes, every build entry stays, and that anything unreadable
# deletes the whole cache and exits non-zero rather than saving a guess.
#
# HERMETIC: every case builds its own .turbo/ in a temp dir and points the
# script at it with WORKSPACE_ROOT.
#
#   bash scripts/test-keep-build-cache-only.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script=${KEEP:-$repo_root/scripts/keep-build-cache-only.sh}

work_dir=$(mktemp -d -t keep-build-cache-only.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT

pass=0
fail=0

check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' \
      "$name" "$expected" "$actual" >&2
  fi
}

# make_root <name> <summary-tasks> <cache-hashes>
#   summary-tasks: space-separated task:hash pairs written to the run summary
#   cache-hashes:  space-separated hashes given a full three-file cache entry
make_root() {
  local root=$work_dir/$1 tasks=$2 hashes=$3 entry first=1 hash
  mkdir -p "$root/.turbo/runs" "$root/.turbo/cache"
  {
    printf '{"id":"fixture","tasks":['
    for entry in $tasks; do
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '{"taskId":"pkg#%s","task":"%s","hash":"%s","cache":{"status":"MISS"}}' \
        "${entry%:*}" "${entry%:*}" "${entry##*:}"
    done
    printf ']}\n'
  } >"$root/.turbo/runs/run.json"
  for hash in $hashes; do
    : >"$root/.turbo/cache/$hash.tar.zst"
    : >"$root/.turbo/cache/$hash-meta.json"
    : >"$root/.turbo/cache/$hash-manifest.json"
  done
  printf '%s' "$root"
}

run() {
  WORKSPACE_ROOT=$1 bash "$script" >/dev/null 2>&1
  printf '%s' $?
}

# What is left in the cache, as a sorted space-separated list of hashes.
left() {
  [ -d "$1/.turbo/cache" ] || { printf 'no-cache-dir'; return; }
  find "$1/.turbo/cache" -mindepth 1 -maxdepth 1 -exec basename {} \; |
    cut -c1-16 | sort -u | tr '\n' ' ' | sed 's/ $//'
}

B1=aaaaaaaaaaaaaaa1
B2=aaaaaaaaaaaaaaa2
G1=bbbbbbbbbbbbbbb1
T1=ccccccccccccccc1
T2=ccccccccccccccc2
STALE=ddddddddddddddd1

# --- A normal sweep ----------------------------------------------------------

root=$(make_root normal "build:$B1 build:$B2 generate:api-docs:$G1 test:$T1 test:$T2" \
  "$B1 $B2 $G1 $T1 $T2 $STALE")
check 'a normal sweep exits 0' 0 "$(run "$root")"
check 'only build and generate:api-docs entries survive' "$B1 $B2 $G1" "$(left "$root")"
check 'each kept entry keeps all three files' 9 \
  "$(find "$root/.turbo/cache" -type f | wc -l | tr -d ' ')"

# --- Test entries never survive ----------------------------------------------

root=$(make_root test-only-cache "build:$B1 test:$T1" "$T1")
check 'a cache holding only test entries is refused' 1 "$(run "$root")"
check 'and is deleted rather than saved' no-cache-dir "$(left "$root")"

root=$(make_root unknown-task "build:$B1 lint:$T2" "$B1 $T2")
check 'a task type the keep-list does not name is removed' "$B1" \
  "$(run "$root" >/dev/null; left "$root")"

# --- A file whose name only starts with a kept hash --------------------------

root=$(make_root lookalike "build:$B1" "$B1")
: >"$root/.turbo/cache/${B1}0-meta.json"
: >"$root/.turbo/cache/notes.txt"
mkdir -p "$root/.turbo/cache/$B1-dir"
check 'a longer hash, a stray file and a directory are removed' "$B1" \
  "$(run "$root" >/dev/null; left "$root")"
check 'and exactly the three real files remain' 3 \
  "$(find "$root/.turbo/cache" -mindepth 1 | wc -l | tr -d ' ')"

# --- Anything unreadable saves nothing ---------------------------------------

root=$work_dir/no-summary
mkdir -p "$root/.turbo/cache"
: >"$root/.turbo/cache/$B1.tar.zst"
check 'no run summary is refused' 1 "$(run "$root")"
check 'and the cache is deleted' no-cache-dir "$(left "$root")"

root=$(make_root bad-json "build:$B1" "$B1")
printf 'not json' >"$root/.turbo/runs/run.json"
check 'a summary that is not JSON is refused' 1 "$(run "$root")"
check 'and the cache is deleted' no-cache-dir "$(left "$root")"

root=$(make_root no-build "test:$T1" "$T1")
check 'a summary with no build task is refused' 1 "$(run "$root")"
check 'and the cache is deleted' no-cache-dir "$(left "$root")"

root=$(make_root bad-hash 'build:../../etc' "$B1")
check 'a hash that is not 16 hex characters is never matched' 1 "$(run "$root")"

root=$(make_root build-failed "build:$B1" '')
check 'a run whose build left no entry is refused' 1 "$(run "$root")"

printf 'keep-build-cache-only: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
