#!/usr/bin/env bash
# Fixture suite for scripts/check-dir-size.sh, the pre-commit guard that stops a
# source directory from growing past ERROR_THRESHOLD files.
#
# It exists because the guard used to have a blind spot that had already gone
# unnoticed in this very repo (DOR-930): it only ever looked at directories the
# commit ADDED a source file to (`git diff --cached --diff-filter=ACR`), so a
# directory sitting over the limit stayed silent indefinitely as long as nobody
# added a new file to it. apps/client/src/layers/entities/session/model reached
# 27 files — two over the 25 ERROR limit — with nothing flagging it, because
# every commit that touched it was a MODIFY. The fix adds a non-blocking,
# repo-wide census tier alongside the original blocking growth tier. Case (b)
# below is that exact regression: a dir already at the limit, touched only by a
# MODIFY, must now surface a census WARN even though it still must not block.
#
#   bash scripts/test-check-dir-size.sh
#   CHECK=/path/to/other.sh bash scripts/test-check-dir-size.sh
#
# CHECK exists so a candidate rewrite, or the pre-fix script, can be run against
# the same fixtures to show what it gets wrong — see the DOR-930 PR body for the
# red run this produces against the pre-fix script on case (b).
#
# Hermetic: every case builds a throwaway git repository under a temp dir, so
# the suite never reads this repo's real directories or thresholds. Git identity
# and config are neutered so a developer's own git config cannot change what a
# case measures.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
check_script=${CHECK:-$repo_root/scripts/check-dir-size.sh}

work_dir=$(mktemp -d -t check-dir-size.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

pass=0
fail=0

# check <name> <mode> <expected> <actual>
#   mode eq    — exact string match (exit codes, or an expected-empty output)
#   mode has   — actual must contain expected as a substring
#   mode lacks — actual must NOT contain expected as a substring
check() {
  local name=$1 mode=$2 expected=$3 actual=$4
  case "$mode" in
    eq)
      if [ "$expected" = "$actual" ]; then
        pass=$((pass + 1))
      else
        fail=$((fail + 1))
        printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$name" "$expected" "$actual" >&2
      fi
      ;;
    has)
      if printf '%s' "$actual" | grep -qF "$expected"; then
        pass=$((pass + 1))
      else
        fail=$((fail + 1))
        printf 'FAIL  %s\n        expected to contain: %s\n        actual:\n%s\n' "$name" "$expected" "$actual" >&2
      fi
      ;;
    lacks)
      if printf '%s' "$actual" | grep -qF "$expected"; then
        fail=$((fail + 1))
        printf 'FAIL  %s\n        expected to NOT contain: %s\n        actual:\n%s\n' "$name" "$expected" "$actual" >&2
      else
        pass=$((pass + 1))
      fi
      ;;
  esac
}

# Create $2 minimal, distinct .ts files in directory $1 (mkdir -p first).
# Filenames are zero-padded and content is index-derived, so calling this
# twice with a larger count on the same dir only adds new files — the
# already-written ones re-render byte-identical and `git add -A` sees no
# change to them, which is what makes "seed N files, commit, then grow to
# N+1" produce a single, unambiguous ADD.
make_files() {
  local dir=$1 count=$2 i
  mkdir -p "$dir"
  for ((i = 1; i <= count; i++)); do
    printf 'export const v%d = %d;\n' "$i" "$i" >"$dir/$(printf 'f%02d.ts' "$i")"
  done
}

init_repo() {
  local repo=$1
  mkdir -p "$repo"
  (
    cd "$repo" || exit 1
    git init -q -b main .
    printf '# fixture\n' >README.md
    git add -A
    git commit -qm base
  ) >/dev/null 2>&1
}

# Run the real hook entry point against $1's current index and record its
# stdout+stderr and exit status in the globals sut_out/sut_status.
run_sut() {
  local repo=$1
  sut_out=$(cd "$repo" && bash "$check_script" 2>&1)
  sut_status=$?
}

# --- (a) Growth: adding files that push a dir to >= ERROR_THRESHOLD blocks. -
# This is the pre-existing behavior the fix must not regress.
case_a() {
  local repo=$work_dir/case-a
  init_repo "$repo"
  (
    cd "$repo" || exit 1
    make_files src/big 24
    git add -A
    git commit -qm 'seed: dir at 24 files'
    # The 25th file is a genuine ADD.
    make_files src/big 25
    git add -A
  ) >/dev/null 2>&1

  run_sut "$repo"
  check "a: exit 1 on growth over the limit" eq 1 "$sut_status"
  check "a: ERROR line for src/big" has "ERROR: src/big has 25 source files (max 25)" "$sut_out"
}

# --- (b) THE regression: modify-only into a dir already over the limit. -----
# Before the fix, this dir never appeared anywhere in the output — nothing
# selects it, because diff-filter=ACR excludes a plain modify. It must now
# get a census WARN while still exiting 0.
case_b() {
  local repo=$work_dir/case-b
  init_repo "$repo"
  (
    cd "$repo" || exit 1
    make_files src/big 25
    git add -A
    git commit -qm 'seed: dir already at 25 files'
    # Touch ONLY an existing file's contents — no add, copy, or rename.
    printf 'export const v1 = 999;\n' >src/big/f01.ts
    git add -A
  ) >/dev/null 2>&1

  run_sut "$repo"
  check "b: modify-only never blocks" eq 0 "$sut_status"
  check "b: no ERROR for src/big" lacks "ERROR: src/big" "$sut_out"
  check "b: census WARN surfaces the already-over dir" has \
    "WARN:  src/big has 25 source files (over 25; not touched by this commit)" "$sut_out"
}

# --- (c) A dir over the limit that this commit does not touch at all. -------
case_c() {
  local repo=$work_dir/case-c
  init_repo "$repo"
  (
    cd "$repo" || exit 1
    make_files src/big 26
    make_files src/small 3
    git add -A
    git commit -qm 'seed: src/big over limit, src/small tiny'
    # This commit's only staged change lives in a wholly different directory.
    make_files src/small 4
    git add -A
  ) >/dev/null 2>&1

  run_sut "$repo"
  check "c: exit 0 (nothing blocks)" eq 0 "$sut_status"
  check "c: census WARN for the untouched over-limit dir" has \
    "WARN:  src/big has 26 source files (over 25; not touched by this commit)" "$sut_out"
  check "c: no ERROR anywhere" lacks "ERROR:" "$sut_out"
}

# --- (d) Allowlisted flat dir over threshold never errors or warns. ---------
case_d() {
  local repo=$work_dir/case-d
  init_repo "$repo"
  (
    cd "$repo" || exit 1
    make_files src/components/ui 30
    git add -A
    git commit -qm 'seed: allowlisted flat dir over limit'
    # Grow it too, so both the growth tier and the census tier see it and
    # both must stay silent.
    make_files src/components/ui 31
    git add -A
  ) >/dev/null 2>&1

  run_sut "$repo"
  check "d: exit 0 (allowlist respected)" eq 0 "$sut_status"
  check "d: allowlisted dir never named" lacks "src/components/ui" "$sut_out"
}

# --- (e) Everything under threshold: no noise at all. ------------------------
case_e() {
  local repo=$work_dir/case-e
  init_repo "$repo"
  (
    cd "$repo" || exit 1
    make_files src/tiny 5
    git add -A
    git commit -qm 'seed: tiny dir'
    make_files src/tiny 6
    git add -A
  ) >/dev/null 2>&1

  run_sut "$repo"
  check "e: exit 0" eq 0 "$sut_status"
  check "e: no WARN or ERROR noise" eq "" "$sut_out"
}

case_a
case_b
case_c
case_d
case_e

printf '\ncheck-dir-size fixtures: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
