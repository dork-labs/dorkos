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
# MORE THAN ONE TARGET. Everything above was written when packages/db was the
# only Drizzle schema in the repo that a job looked at. apps/site has two of its
# own — a public half and a control-plane half, each with its own config, its own
# out folder and its own journal table — and neither was covered by anything,
# which is the same "no job looks" defect one directory over. So a target is now
# an argument, the checks below run once per target, and the defaults reproduce
# the single packages/db invocation exactly.
#
# Usage:
#   scripts/assert-migrations-current.sh                       # packages/db
#   scripts/assert-migrations-current.sh <pkg>:<config>:<out>[:<regen-script>] [...]
#
# Each target is three colon-separated fields — the package directory relative to
# the workspace root, the drizzle config inside it, and that config's `out`
# directory, also relative to the package — plus an optional fourth naming the
# package script an author should run to fix drift, so the failure message names
# a command that exists. Every target is checked; the script reports each one and
# fails on the first that drifts.
#
# WORKSPACE_ROOT overrides where the package directories are looked up, and
# MIGRATION_GENERATOR overrides the command run inside them. Both exist so
# scripts/test-assert-migrations-current.sh can drive this against synthetic
# trees and a stub generator in a temp dir; keeping the fixtures off this repo's
# real state is what stops them red-lighting unrelated PRs. Neither is set by CI
# or by the package script.

set -uo pipefail

# A LEAKED GIT_DIR POINTS THIS GATE AT THE WRONG REPOSITORY. The drift check is
# `git -C "$workspace_root" status --porcelain -- "$drizzle_dir"`, and `-C` sets
# the working directory, NOT the repository: git still prefers $GIT_DIR when it
# is set. Anything that exports one — a hook, a rebase or bisect script, an outer
# harness — aims the check at that other repository, which does not contain the
# absolute path being asked about.
#
# WHICH WAY IT BREAKS DEPENDS ON WHERE THE LEAK POINTS, and one of the shapes is
# a silent pass, so do not reason from the first one you try. All three measured:
#
#   * GIT_DIR + GIT_WORK_TREE at an UNRELATED repository — git exits 128, "is
#     outside repository", the status check below catches the non-zero exit and a
#     CLEAN tree fails saying "could not read git status". A false red: an author
#     sent hunting through migrations for a problem that is not there.
#   * GIT_DIR alone — the work tree stays put, and a clean tree reports as drift.
#     Another false red, by a different route.
#   * GIT_DIR + GIT_WORK_TREE at an ANCESTOR repository that gitignores this one —
#     real, uncommitted drift prints NOTHING and the gate exits 0. A false GREEN,
#     which is the silence-is-success shape this whole file exists to prevent.
#
# A stale GIT_INDEX_FILE is its own case again: `status` diffs against someone
# else's index and reports the committed migrations as deleted. So take none of
# them from the environment; the answer must not depend on who called us. Pinned
# by the leaked-GIT_DIR cases in scripts/test-assert-migrations-current.sh, which
# go red if this `unset` is removed.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workspace_root=${WORKSPACE_ROOT:-$repo_root}

# The generator, as a command run with the target package as the working
# directory. `pnpm exec` resolves the locally installed binary without consulting
# a package NAME, which is the whole point — see 2 above. `%s` is the target's
# config file.
generator_template=${MIGRATION_GENERATOR:-'pnpm exec drizzle-kit generate --config %s'}

# Default target: exactly the single packages/db invocation this script had
# before targets existed, so the fixtures and `pnpm --filter @dorkos/db run
# db:check` are unaffected.
if [ "$#" -eq 0 ]; then
  set -- 'packages/db:drizzle.config.ts:drizzle:db:generate'
fi

fail() {
  printf 'assert-migrations-current: %s\n' "$1" >&2
  exit 1
}

# Check one target. $1 package dir (relative), $2 config file, $3 out dir
# (relative to the package).
check_target() {
  local pkg_rel=$1 config=$2 out_rel=$3 regen_script=$4
  local db_dir="$workspace_root/$pkg_rel"
  local drizzle_dir="$db_dir/$out_rel"
  local regen="pnpm --filter ./$pkg_rel run $regen_script"

  # Resolve the package by path. A rename, a move, or a partial checkout lands
  # here rather than sailing through as a silent no-op.
  [ -d "$db_dir" ] || fail "no package directory at $db_dir.
Nothing was checked. If $pkg_rel moved, this script and the workflow that
calls it have to move with it."
  [ -f "$db_dir/package.json" ] || fail "$db_dir has no package.json, so it is not
a workspace package. Nothing was checked."
  [ -f "$db_dir/$config" ] || fail "no $config in $db_dir.
Nothing was checked."
  [ -d "$drizzle_dir" ] || fail "no migrations directory at $drizzle_dir.
Nothing was checked."

  local generator
  # shellcheck disable=SC2059 # the template is ours, and %s is the only spec.
  generator=$(printf "$generator_template" "$config")

  # Run the generator, keeping stdout and stderr together: drizzle-kit reports
  # both its success markers and its TTY refusal on stdout, and a genuine crash
  # on stderr. Stdin is closed so an interactive prompt fails fast and
  # identically to CI rather than hanging on a developer's terminal.
  local output status
  output=$(cd "$db_dir" && eval "$generator" </dev/null 2>&1)
  status=$?

  # AFFIRMATIVE: the run counts only if it announced one of its two outcomes.
  #   "No schema changes, nothing to migrate" — the schema and migrations agree.
  #   "Your SQL migration file"               — it wrote one, which the tree check
  #                                             below then reports as drift.
  local verdict
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

  $regen

on a real terminal, answer the prompt, and commit what it writes.

Generator exit status was $status. Its output:
$output"
    fi
    fail "the migration generator did not report either of its known outcomes for
$pkg_rel ($config), so this proved nothing. Exit status was $status (which
drizzle-kit sets to 0 even when it refuses to run). Its output:
$output"
  fi

  # A non-zero status is still a failure even if a marker appeared.
  [ "$status" -eq 0 ] || fail "the migration generator exited $status. Its output:
$output"

  # `git status --porcelain` rather than `git diff --exit-code`: a newly
  # generated migration is an UNTRACKED 00NN_*.sql plus an UNTRACKED
  # meta/00NN_snapshot.json, and `git diff` reports neither. The only reason
  # drift was ever caught is that meta/_journal.json is tracked and gains an
  # entry per migration — the entire gate hung on that single file staying
  # tracked and staying append-on-generate.
  #
  # The path is passed as an absolute one and git's own exit status is checked,
  # so a moved directory cannot present as "no output, therefore clean".
  local dirty git_status
  dirty=$(git -C "$workspace_root" status --porcelain -- "$drizzle_dir")
  git_status=$?
  [ "$git_status" -eq 0 ] || fail "could not read git status for $drizzle_dir (git
exited $git_status). Nothing was proved."

  if [ -n "$dirty" ]; then
    fail "regenerating the migrations changed $drizzle_dir, so the committed
migrations do not match the schema $config points at:

$(printf '%s\n' "$dirty" | sed 's/^/  /')

Run '$regen' and commit what it writes."
  fi

  if [ "$verdict" = 'generated' ]; then
    fail "the generator wrote a migration but $drizzle_dir looks unchanged, which
should be impossible. Something outside this script is reverting or ignoring
generated files — do not trust this result."
  fi

  # Report what was OBSERVED, not what it implies. A clean directory on its own
  # is also what a generator that did nothing leaves behind; the verdict above is
  # the part that separates the two.
  printf 'assert-migrations-current: generator reported "no schema changes" for %s and %s is clean.\n' \
    "$pkg_rel/$config" "$pkg_rel/$out_rel/"
}

for target in "$@"; do
  # The regen script may itself contain a colon (`db:generate:public`), so it
  # takes everything after the third field rather than just the fourth.
  IFS=':' read -r target_pkg target_config target_out target_regen <<<"$target"
  [ -n "${target_pkg:-}" ] && [ -n "${target_config:-}" ] && [ -n "${target_out:-}" ] ||
    fail "target '$target' is not <package-dir>:<config>:<out-dir>[:<regen-script>].
Nothing was checked."
  check_target "$target_pkg" "$target_config" "$target_out" "${target_regen:-db:generate}"
done
