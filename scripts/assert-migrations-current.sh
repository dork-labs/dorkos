#!/usr/bin/env bash
# Prove the committed Drizzle migrations still describe the schema in
# packages/db/src/schema/.
#
# WHY THIS EXISTS AS A SCRIPT. The obvious one-liner is what packages/db shipped
# for years:
#
#   drizzle-kit generate --config drizzle.config.ts && git diff --exit-code drizzle/
#
# Both halves fail open, and the combination is green on the single most likely
# way a schema actually drifts.
#
# 1. THE GENERATOR EXITS 0 WHEN IT REFUSES TO RUN. drizzle-kit 0.31.10 asks an
#    interactive question whenever a diff is ambiguous — above all a column
#    RENAME ("is this a rename, or a drop plus an add?"). With no TTY it cannot
#    ask, so it prints a stack trace headed
#
#      Error: Interactive prompts require a TTY terminal
#
#    writes NOTHING, and EXITS 0. Verified on 0.31.10. So `&&` does not
#    short-circuit, the diff then runs against a tree the generator never
#    touched, finds it clean, and the gate passes. The realistic trigger is a
#    pure column rename that keeps the TypeScript property name —
#    `integer('max_runtime')` to `integer('max_runtime_ms')` — because no call
#    site changes, so typecheck cannot see it either. Measured on that exact
#    edit: generator exit 0, diff clean, `tsc --noEmit` exit 0. Fully green,
#    schema drifted, no migration.
#
#    So this asserts on what the generator SAID, not on what it returned. A run
#    only counts when it printed one of its two success markers; anything else,
#    including silence, is a refusal. Affirmative, in the register of
#    scripts/should-arm-automerge.sh: unknown is never a pass.
#
# 2. `pnpm --filter <name>` MATCHING NOTHING EXITS 0. This is the
#    `--filter=<typo>` shape scripts/assert-tests-executed.sh was written about,
#    and the previous CI step reproduced it exactly by hardcoding the package
#    name in YAML. `pnpm --filter @dorkos/db-renamed run db:check` prints "No
#    projects matched the filters" and exits 0 (pnpm 10.28.2). A renamed or moved
#    package therefore turns the whole gate into a no-op, and nothing else
#    notices: pnpm-lock.yaml keys workspace packages by PATH, not by name, so
#    `--frozen-lockfile` stays happy too.
#
#    So this resolves the package by PATH and fails if it is not there. There is
#    no name filter anywhere in the chain.
#
# What it deliberately does NOT do: decide whether a rename is a rename. That is
# drizzle-kit's interactive question and it needs a human. The point here is that
# the answer must be given, not guessed — a rename now FAILS the gate with an
# instruction to run `pnpm --filter @dorkos/db run db:generate` on a terminal and
# commit the result.
#
# Usage:
#   scripts/assert-migrations-current.sh
#
# WORKSPACE_ROOT overrides where packages/db is looked up, and
# MIGRATION_GENERATOR overrides the command run inside it. Both exist so
# scripts/test-assert-migrations-current.sh can drive this against synthetic
# trees and a stub generator in a temp dir; keeping the fixtures off this repo's
# real state is what stops them red-lighting unrelated PRs. Neither is set by CI
# or by the package script.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workspace_root=${WORKSPACE_ROOT:-$repo_root}
db_dir="$workspace_root/packages/db"
drizzle_dir="$db_dir/drizzle"

# The generator, as a command run with $db_dir as the working directory.
# `pnpm exec` resolves the locally installed binary without consulting a package
# NAME, which is the whole point — see 2 above.
generator=${MIGRATION_GENERATOR:-'pnpm exec drizzle-kit generate --config drizzle.config.ts'}

fail() {
  printf 'assert-migrations-current: %s\n' "$1" >&2
  exit 1
}

# Resolve the package by path. A rename, a move, or a partial checkout lands here
# rather than sailing through as a silent no-op.
[ -d "$db_dir" ] || fail "no package directory at $db_dir.
Nothing was checked. If packages/db moved, this script and the workflow that
calls it have to move with it."
[ -f "$db_dir/package.json" ] || fail "$db_dir has no package.json, so it is not
a workspace package. Nothing was checked."
[ -f "$db_dir/drizzle.config.ts" ] || fail "no drizzle.config.ts in $db_dir.
Nothing was checked."
[ -d "$drizzle_dir" ] || fail "no migrations directory at $drizzle_dir.
Nothing was checked."

# Run the generator, keeping stdout and stderr together: drizzle-kit reports both
# its success markers and its TTY refusal on stdout, and a genuine crash on
# stderr. Stdin is closed so an interactive prompt fails fast and identically to
# CI rather than hanging on a developer's terminal.
output=$(cd "$db_dir" && eval "$generator" </dev/null 2>&1)
status=$?

# AFFIRMATIVE: the run counts only if it announced one of its two outcomes.
#   "No schema changes, nothing to migrate" — the schema and migrations agree.
#   "Your SQL migration file"               — it wrote one, which the tree check
#                                             below then reports as drift.
if printf '%s' "$output" | grep -qF 'No schema changes, nothing to migrate'; then
  verdict='no-changes'
elif printf '%s' "$output" | grep -qF 'Your SQL migration file'; then
  verdict='generated'
else
  # Name the known cause before falling back to the generic message, because
  # this is the one a person will actually hit.
  if printf '%s' "$output" | grep -qF 'Interactive prompts require a TTY'; then
    fail "drizzle-kit needs an interactive answer it cannot be asked here, and it
exits 0 without writing anything — so silence from it is NOT a clean schema.

This is almost always a column or table RENAME: drizzle-kit cannot tell a rename
from a drop-plus-add, and only a person can. Run

  pnpm --filter @dorkos/db run db:generate

on a real terminal, answer the prompt, and commit what it writes.

Generator exit status was $status. Its output:
$output"
  fi
  fail "the migration generator did not report either of its known outcomes, so
this proved nothing. Exit status was $status (which drizzle-kit sets to 0 even
when it refuses to run). Its output:
$output"
fi

# A non-zero status is still a failure even if a marker appeared.
[ "$status" -eq 0 ] || fail "the migration generator exited $status. Its output:
$output"

# `git status --porcelain` rather than `git diff --exit-code`: a newly generated
# migration is an UNTRACKED drizzle/00NN_*.sql plus an UNTRACKED
# drizzle/meta/00NN_snapshot.json, and `git diff` reports neither. The only
# reason the old one-liner caught drift at all is that meta/_journal.json is
# tracked and gains an entry per migration — the entire gate hung on that single
# file staying tracked and staying append-on-generate.
#
# The path is passed as an absolute one and git's own exit status is checked, so
# a moved directory cannot present as "no output, therefore clean".
dirty=$(git -C "$workspace_root" status --porcelain -- "$drizzle_dir")
git_status=$?
[ "$git_status" -eq 0 ] || fail "could not read git status for $drizzle_dir (git
exited $git_status). Nothing was proved."

if [ -n "$dirty" ]; then
  fail "regenerating the migrations changed $drizzle_dir, so the committed
migrations do not match packages/db/src/schema/:

$(printf '%s\n' "$dirty" | sed 's/^/  /')

Run 'pnpm --filter @dorkos/db run db:generate' and commit what it writes."
fi

if [ "$verdict" = 'generated' ]; then
  fail "the generator wrote a migration but $drizzle_dir looks unchanged, which
should be impossible. Something outside this script is reverting or ignoring
generated files — do not trust this result."
fi

# Report what was OBSERVED, not what it implies. A clean directory on its own is
# also what a generator that did nothing leaves behind; the verdict above is the
# part that separates the two.
printf 'assert-migrations-current: generator reported "no schema changes" and %s is clean.\n' \
  "packages/db/drizzle/"
