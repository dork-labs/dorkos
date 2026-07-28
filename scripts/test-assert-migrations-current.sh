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

printf '\nassert-migrations-current fixtures: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
