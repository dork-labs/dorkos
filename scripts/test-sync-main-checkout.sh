#!/usr/bin/env bash
# Fixture suite for .claude/hooks/sync-main-checkout.sh, the SessionStart step
# that keeps the main checkout's local `main` level with origin/main.
#
# The hook moves a working tree without being asked, so every refusal matters
# as much as the fast-forward: a dirty tree, a diverged `main`, another branch
# checked out, a git operation in flight and the warn/off switch must each leave
# `main` exactly where it was. Each case builds a real origin, clone and linked
# worktree in a temp dir, runs the real hook, and asserts on where `main` ended
# up and on the one line it printed.
#
#   bash scripts/test-sync-main-checkout.sh
#   HOOK=/path/to/other.sh bash scripts/test-sync-main-checkout.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
hook=${HOOK:-$repo_root/.claude/hooks/sync-main-checkout.sh}

# pwd -P: macOS hands out /var/..., which git reports as /private/var/...
tmp=$(cd "$(mktemp -d -t sync-main-checkout.XXXXXX)" && pwd -P)
trap 'rm -rf "$tmp"' EXIT

export DORKOS_MAIN_SYNC_FETCH=0 GIT_CONFIG_NOSYSTEM=1 HOME=$tmp
git config --global user.name t
git config --global user.email t@t
git config --global init.defaultBranch main

pass=0
fail=0
check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$name" "$expected" "$actual"
  fi
}
# contains <name> <needle> <haystack>
contains() {
  case "$3" in
    *"$2"*) pass=$((pass + 1)) ;;
    *)
      fail=$((fail + 1))
      printf 'FAIL  %s\n        expected to contain: %s\n        actual: %s\n' "$1" "$2" "$3"
      ;;
  esac
}

# fixture <name>: a bare origin two commits ahead of a clone's main, plus a
# linked worktree. Leaves $origin, $clone, $wt, $old (clone main) and $new
# (origin main) set.
fixture() {
  local d=$tmp/$1
  origin=$d/origin.git clone=$d/clone wt=$d/wt
  git init -q --bare "$origin"
  git clone -q "$origin" "$clone" 2>/dev/null
  git -C "$clone" commit -q --allow-empty -m one
  git -C "$clone" push -q origin main
  old=$(git -C "$clone" rev-parse HEAD)
  local up=$d/upstream
  git clone -q "$origin" "$up"
  git -C "$up" commit -q --allow-empty -m two
  echo x >"$up/file" && git -C "$up" add file && git -C "$up" commit -q -m three
  git -C "$up" push -q origin main
  new=$(git -C "$up" rev-parse HEAD)
  git -C "$clone" fetch -q origin
  git -C "$clone" worktree add -q "$wt" -b feature
}

# run <cwd> [payload]: the hook's stdout, with its exit code appended as
# " exit=<n>". Also fails the suite if the hook ever prints more than one line.
run() {
  local out code
  out=$(cd "$1" && printf '%s' "${2:-}" | "$hook" 2>&1)
  code=$?
  if [ "$(printf '%s' "$out" | grep -c .)" -gt 1 ]; then
    fail=$((fail + 1))
    printf 'FAIL  printed more than one line in %s:\n%s\n' "$1" "$out"
  fi
  printf '%s exit=%s' "$out" "$code"
}

# --- behind and clean: fast-forwards, from the main checkout ---------------
fixture ff-main
out=$(run "$clone")
check "ff: main moved to origin/main" "$new" "$(git -C "$clone" rev-parse main)"
contains "ff: says so" "main fast-forwarded 2 commit(s)" "$out"
contains "ff: exits 0" "exit=0" "$out"

# --- behind and clean: fast-forwards the main checkout from a worktree ------
fixture ff-wt
out=$(run "$wt")
check "ff from worktree: main checkout moved" "$new" "$(git -C "$clone" rev-parse main)"
check "ff from worktree: worktree untouched" "$old" "$(git -C "$wt" rev-parse HEAD)"

# --- level: silent ------------------------------------------------------------
fixture level
git -C "$clone" merge -q --ff-only origin/main
check "level: silent" " exit=0" "$(run "$clone")"

# --- tracked changes: warns, does not move, leaves the index alone -----------
fixture dirty
echo wip >"$clone/wip.txt"
git -C "$clone" add wip.txt
echo more >>"$clone/wip.txt"
# A staged file whose mtime moves after staging: a plain `git status` would
# refresh its stat data and rewrite the index under index.lock.
echo same >"$clone/same.txt" && git -C "$clone" add same.txt
touch -t 203001010000 "$clone/same.txt"
index_before=$(shasum <"$clone/.git/index")
out=$(run "$clone")
check "dirty: main not moved" "$old" "$(git -C "$clone" rev-parse main)"
contains "dirty: warns with the count" "has 2 uncommitted change(s), so it was not synced" "$out"
check "dirty: wip kept" "$(printf 'wip\nmore')" "$(cat "$clone/wip.txt")"
check "dirty: index untouched" "$index_before" "$(shasum <"$clone/.git/index")"

# --- untracked files only: not dirty, fast-forwards and keeps them ------------
fixture untracked
mkdir -p "$clone/dist-out" && echo build >"$clone/dist-out/a.js"
out=$(run "$clone")
check "untracked: main moved" "$new" "$(git -C "$clone" rev-parse main)"
check "untracked: file kept" "build" "$(cat "$clone/dist-out/a.js")"

# --- untracked file in the way of an incoming one: refuses, keeps it ----------
fixture collide
echo mine >"$clone/file"
out=$(run "$clone")
check "collision: main not moved" "$old" "$(git -C "$clone" rev-parse main)"
check "collision: file kept" "mine" "$(cat "$clone/file")"
contains "collision: says the fast-forward failed" "the fast-forward failed" "$out"

# --- SessionStart source: only startup moves the tree --------------------------
fixture resume
check "resume: silent" " exit=0" "$(run "$clone" '{"hook_event_name":"SessionStart","source":"resume"}')"
check "resume: main not moved" "$old" "$(git -C "$clone" rev-parse main)"
check "compact: silent" " exit=0" "$(run "$clone" '{"source": "compact"}')"
out=$(run "$clone" '{"hook_event_name":"SessionStart","source":"startup"}')
check "startup: main moved" "$new" "$(git -C "$clone" rev-parse main)"

# --- lockfile changed: says to install -----------------------------------------
fixture lockfile
up=$tmp/lockfile/upstream
echo lock >"$up/pnpm-lock.yaml" && git -C "$up" add pnpm-lock.yaml && git -C "$up" commit -q -m deps
git -C "$up" push -q origin main && git -C "$clone" fetch -q origin
out=$(run "$clone")
contains "lockfile: says to install" "pnpm-lock.yaml changed, run pnpm install" "$out"
contains "lockfile: counts what moved" "fast-forwarded 3 commit(s)" "$out"

# --- diverged: warns, does not move -------------------------------------------
fixture diverged
git -C "$clone" commit -q --allow-empty -m local
local_sha=$(git -C "$clone" rev-parse main)
out=$(run "$clone")
check "diverged: main not moved" "$local_sha" "$(git -C "$clone" rev-parse main)"
contains "diverged: warns" "local main has 1 commit(s) origin/main lacks" "$out"

# --- another branch checked out in the main checkout: silent ------------------
fixture other-branch
git -C "$clone" switch -q -c topic
check "other branch: silent" " exit=0" "$(run "$clone")"
check "other branch: main not moved" "$old" "$(git -C "$clone" rev-parse main)"

# --- git operation in flight: silent ------------------------------------------
fixture locked
touch "$clone/.git/index.lock"
check "index.lock: silent" " exit=0" "$(run "$clone")"
check "index.lock: main not moved" "$old" "$(git -C "$clone" rev-parse main)"
rm -f "$clone/.git/index.lock"
fixture merging
echo "$new" >"$clone/.git/MERGE_HEAD"
check "MERGE_HEAD: silent" " exit=0" "$(run "$clone")"

# --- warn mode: reports, does not move ----------------------------------------
fixture warn
git -C "$clone" config dorkos.mainSync warn
out=$(run "$wt")
check "warn: main not moved" "$old" "$(git -C "$clone" rev-parse main)"
contains "warn: reports the pull" "main is 2 commit(s) behind origin/main — git -C $clone pull --ff-only" "$out"

# --- off: silent, does not move -----------------------------------------------
fixture off
git -C "$clone" config dorkos.mainSync off
check "off: silent" " exit=0" "$(run "$clone")"
check "off: main not moved" "$old" "$(git -C "$clone" rev-parse main)"

# --- unknown mode: falls back to warn, says so --------------------------------
fixture typo
git -C "$clone" config dorkos.mainSync ofF
out=$(run "$clone")
check "unknown mode: main not moved" "$old" "$(git -C "$clone" rev-parse main)"
contains "unknown mode: names the value" "dorkos.mainSync is 'ofF'" "$out"
contains "unknown mode: still reports the finding" "main is 2 commit(s) behind" "$out"

# --- a bare repository with a linked worktree on main: silent ---------------
fixture bare-src
git clone -q --bare "$origin" "$tmp/bare.git" 2>/dev/null
git -C "$tmp/bare.git" update-ref refs/remotes/origin/main "$new"
git -C "$tmp/bare.git" update-ref refs/heads/main "$old"
git -C "$tmp/bare.git" worktree add -q "$tmp/bare-wt" main 2>/dev/null
echo wip >"$tmp/bare-wt/wip.txt" && git -C "$tmp/bare-wt" add wip.txt
check "bare: silent" " exit=0" "$(run "$tmp/bare-wt")"
check "bare: main not moved" "$old" "$(git -C "$tmp/bare.git" rev-parse refs/heads/main)"

# --- a tag named main does not stand in for the branch -------------------------
# A bare `main` resolves to refs/tags/main first, which here is already level.
fixture ambiguous
git -C "$clone" tag main "$new"
out=$(run "$clone")
check "tag named main: branch moved" "$new" "$(git -C "$clone" rev-parse refs/heads/main)"

# --- no origin/main: silent ---------------------------------------------------
git init -q "$tmp/lonely"
git -C "$tmp/lonely" commit -q --allow-empty -m init
check "no origin: silent" " exit=0" "$(run "$tmp/lonely")"

# --- outside a git checkout: silent -------------------------------------------
mkdir -p "$tmp/plain"
check "not a repo: silent" " exit=0" "$(run "$tmp/plain")"

# --- session-maintenance.sh calls it --------------------------------------------
if grep -q 'sync-main-checkout.sh' "$repo_root/.claude/hooks/session-maintenance.sh"; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL  session-maintenance.sh no longer calls sync-main-checkout.sh"
fi

echo "sync-main-checkout: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
