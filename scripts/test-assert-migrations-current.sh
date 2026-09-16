#!/usr/bin/env bash
# Fixtures for scripts/assert-migrations-current.sh.
#
# That script exists because the gate it replaces was green on a drifted schema,
# and the way it was green was silence: drizzle-kit exits 0 when it refuses to
# run, and `pnpm --filter <name>` exits 0 when it matches nothing. A gate whose
# failure mode is silence has to have its refusals pinned, or the next person to
# "simplify" a grep turns it back into a decoration without anything going red.
#
# Every case below bends ONE thing about a known-good run and asserts the script
# names that thing — the same shape scripts/test-should-arm-automerge.sh and
# scripts/test-assert-tests-executed.sh use, for the same reason.
#
# The generator is stubbed via MIGRATION_GENERATOR so these cases can reproduce
# drizzle-kit's exact misbehaviour (marker text, exit status, what it wrote)
# without needing drizzle-kit, a schema, or a TTY. The real generator is
# exercised separately — see the header of the subject script for the measured
# behaviour these stubs reproduce.
#
# Run directly, or via `pnpm test:scripts` from the repo root.

set -uo pipefail

# The fixtures build throwaway git repositories in a temp dir, so an inherited
# GIT_DIR or GIT_INDEX_FILE would aim their `git init`/`git add` at whatever
# repository set it — and could then make a case pass for the wrong reason.
# The subject script clears these for itself; clear them here too, so the
# fixtures test the subject rather than the ambient environment.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
subject="$script_dir/assert-migrations-current.sh"

pass=0
fail=0

# A synthetic workspace: a git repo with a packages/db that has one committed
# migration and a clean tree. This is the known-good run every case bends.
make_workspace() {
  local root=$1
  mkdir -p "$root/packages/db/drizzle/meta" "$root/packages/db/src/schema"
  : >"$root/packages/db/package.json"
  : >"$root/packages/db/drizzle.config.ts"
  printf '{"entries":[]}' >"$root/packages/db/drizzle/meta/_journal.json"
  printf 'CREATE TABLE a (id text);' >"$root/packages/db/drizzle/0000_init.sql"
  git -C "$root" init -q
  git -C "$root" add -A
  git -C "$root" -c user.email=t@t -c user.name=t commit -qm init
}

#   $1 — case name
#   $2 — workspace root
#   $3 — generator command (stub)
#   $4 — expected exit
#   $5 — substring the output must contain (may be empty)
check() {
  local name=$1 root=$2 gen=$3 want=$4 needle=${5:-}
  local out status
  out=$(WORKSPACE_ROOT="$root" MIGRATION_GENERATOR="$gen" "$subject" 2>&1)
  status=$?

  if [ "$status" -ne "$want" ]; then
    printf 'FAIL  %s\n      expected exit %s, got %s\n      output: %s\n' \
      "$name" "$want" "$status" "$out"
    fail=$((fail + 1))
    return
  fi
  if [ -n "$needle" ] && [[ "$out" != *"$needle"* ]]; then
    printf 'FAIL  %s\n      exit %s was right, but the message never mentioned %s\n      output: %s\n' \
      "$name" "$status" "'$needle'" "$out"
    fail=$((fail + 1))
    return
  fi
  printf 'ok    %s\n' "$name"
  pass=$((pass + 1))
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

CLEAN='printf "No schema changes, nothing to migrate\n"'

# If this fails, every refusal below is meaningless because the script is
# rejecting healthy input.
make_workspace "$tmp/healthy"
check 'a clean schema passes' "$tmp/healthy" "$CLEAN" 0 'is clean'

# THE BLOCKER: drizzle-kit's TTY refusal, which exits 0 and writes nothing.
make_workspace "$tmp/tty"
check 'a generator that refused for want of a TTY is caught' "$tmp/tty" \
  'printf "Error: Interactive prompts require a TTY terminal\n"' 1 'RENAME'

# The same shape without the recognizable message: silence must not pass.
make_workspace "$tmp/silent"
check 'a generator that said nothing at all is caught' "$tmp/silent" \
  'true' 1 'did not report either of its known outcomes'

# A marker AND a non-zero status: the status still counts.
make_workspace "$tmp/nonzero"
check 'a nonzero generator status fails even with a success marker' "$tmp/nonzero" \
  "$CLEAN"' ; exit 3' 1 'exited 3'

# Real drift: the generator writes a migration, leaving the tree dirty.
make_workspace "$tmp/drift"
check 'a generated migration is reported as drift' "$tmp/drift" \
  'printf "Your SQL migration file\n"; printf "x" > drizzle/0001_new.sql' 1 '0001_new.sql'

# The generator claims it wrote one but the tree is clean — impossible, so refuse
# rather than pass.
make_workspace "$tmp/liar"
check 'a claimed migration with a clean tree is refused' "$tmp/liar" \
  'printf "Your SQL migration file\n"' 1 'should be impossible'

# BLOCKER 2's shape: the package is not where it is expected to be. A name
# filter would exit 0 here; a path lookup must not.
check 'a missing package directory is refused' "$tmp/absent" "$CLEAN" 1 'no package directory'

make_workspace "$tmp/nomanifest"
rm "$tmp/nomanifest/packages/db/package.json"
check 'a directory with no package.json is refused' "$tmp/nomanifest" "$CLEAN" 1 'no package.json'

make_workspace "$tmp/noconfig"
rm "$tmp/noconfig/packages/db/drizzle.config.ts"
check 'a missing drizzle.config.ts is refused' "$tmp/noconfig" "$CLEAN" 1 'no drizzle.config.ts'

make_workspace "$tmp/nodrizzle"
rm -rf "$tmp/nodrizzle/packages/db/drizzle"
check 'a missing migrations directory is refused' "$tmp/nodrizzle" "$CLEAN" 1 'no migrations directory'

# A LEAKED GIT ENVIRONMENT must not change this gate's answer. The drift check is
# `git -C <root> status --porcelain -- <dir>`, and `-C` sets the working
# directory, NOT the repository: git still prefers $GIT_DIR. Three leaks, three
# different wrong answers, one of them a SILENT PASS — see the subject's header
# for the measurements. Each case below is a workspace whose honest verdict is
# known, run under one leak; the subject clears the variables, so each must give
# the honest verdict anyway. Remove the `unset` from the subject and these go red.

#   $1 — case name
#   $2 — workspace root
#   $3 — expected exit
#   $4 — substring the output must contain (may be empty)
#   rest — VAR=value assignments to leak into the run
check_leak() {
  local name=$1 root=$2 want=$3 needle=$4
  shift 4
  local out status
  out=$(env "$@" WORKSPACE_ROOT="$root" MIGRATION_GENERATOR="$CLEAN" "$subject" 2>&1)
  status=$?
  if [ "$status" -ne "$want" ] || { [ -n "$needle" ] && [[ "$out" != *"$needle"* ]]; }; then
    printf 'FAIL  %s\n      expected exit %s%s, got %s\n      output: %s\n' \
      "$name" "$want" "${needle:+ mentioning '$needle'}" "$status" "$out"
    fail=$((fail + 1))
    return
  fi
  printf 'ok    %s\n' "$name"
  pass=$((pass + 1))
}

# Clean tree, leak aimed at an unrelated repository. Honest verdict: pass.
make_workspace "$tmp/leaked"
make_workspace "$tmp/elsewhere"
check_leak 'a leaked GIT_DIR pair cannot turn a clean tree red' "$tmp/leaked" 0 'is clean' \
  GIT_DIR="$tmp/elsewhere/.git" GIT_WORK_TREE="$tmp/elsewhere"

# Deliberately NOT a case: GIT_DIR leaked without GIT_WORK_TREE. Measured on git
# 2.x here, it happens to give the honest answer anyway, so a fixture for it
# passes with the subject's `unset` removed — a case that cannot fail is a
# decoration, and this file exists because of one of those. The three below all
# go red without the `unset`; checked by removing it.

# Clean tree, stale GIT_INDEX_FILE: `status` would diff the committed migrations
# against an empty index and call them deleted. The comment in the subject calls
# this the nastier one, so it is pinned rather than asserted.
: >"$tmp/empty-index"
check_leak 'a stale GIT_INDEX_FILE cannot turn a clean tree red' "$tmp/leaked" 0 'is clean' \
  GIT_INDEX_FILE="$tmp/empty-index"

# The silent-pass shape, and the reason this fixture exists at all: an ANCESTOR
# repository that gitignores the workspace. Real drift, and git run against that
# ancestor prints nothing for a path it is told to ignore, so the gate would exit
# 0 on a drifted tree. Honest verdict: fail, naming the drifted file.
mkdir -p "$tmp/ancestor"
git -C "$tmp/ancestor" init -q
printf 'nested/\n' >"$tmp/ancestor/.gitignore"
git -C "$tmp/ancestor" add -A
git -C "$tmp/ancestor" -c user.email=t@t -c user.name=t commit -qm init
make_workspace "$tmp/ancestor/nested"
printf 'CREATE TABLE b (id text);' >"$tmp/ancestor/nested/packages/db/drizzle/0001_drift.sql"
check_leak 'a leaked ancestor GIT_DIR cannot hide real drift' "$tmp/ancestor/nested" 1 '0001_drift.sql' \
  GIT_DIR="$tmp/ancestor/.git" GIT_WORK_TREE="$tmp/ancestor"

printf '\nassert-migrations-current fixtures: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
