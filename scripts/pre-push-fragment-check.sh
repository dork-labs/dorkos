#!/usr/bin/env bash
# Pre-push gate: refuse a push that carries a broken changelog fragment, most
# often a seed nobody rewrote.
#
# --help
# Purpose: refuse a push that carries a broken changelog fragment, most often a
#          seeded one nobody rewrote. Same command as `fragment-present`.
# Runs in: pre-push (`fragments`); by hand.
# To fix:  rewrite or delete the fragment it names (changelog/README.md), commit,
#          push again.
# Usage:   bash scripts/pre-push-fragment-check.sh
# --help end
#
#   bash scripts/pre-push-fragment-check.sh
#
# WHY THIS EXISTS
#
# The post-commit hook (.claude/git-hooks/changelog-populator.py) seeds a
# fragment from every `feat(`/`fix(`/`refactor(`/`perf(` commit, marked
# `dorkos-changelog:seeded`. The required `fragment-present` check refuses that
# marker until someone rewrites the bullet. In one week (Oct 23-30) five PRs
# found that out from CI instead: #3290, #3294, #3295, #3297 and #3205, each a
# push, a red, a fix commit and another full CI run on an overloaded queue.
#
# It runs the SAME command as the `Validate the changelog fragments this PR
# touched` step of .github/workflows/changelog-fragment-check.yml, with the same
# `--changed-only` scope, so it can never disagree with the check it front-runs:
# a fragment you did not touch never refuses your push. Coverage (`--check`) is
# not run here; it needs the PR number and labels, which only CI has.
#
# The base is the merge base with origin/main (else main), the same expression
# scripts/pre-push-format-check.sh and the pre-commit lint use. `--changed-only`
# reads committed fragments, so the scope is what this push carries.
#
# Pure-stdlib Python 3, ~0.1 s. A machine with no python3 skips with a note
# rather than refusing: CI still runs the real check.

# --help (DOR-4950). A gate checked out alone, as the PR-side gates are, runs without it.
gate_help="$(dirname "$0")/lib/gate-help.sh"
# shellcheck source=lib/gate-help.sh
[ ! -r "$gate_help" ] || . "$gate_help"

set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=
if [ -z "$repo_root" ]; then
  printf 'pre-push fragments: not inside a git repository — skipping.\n'
  exit 0
fi
cd "$repo_root" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  printf 'pre-push fragments: no python3 — skipping; CI still checks fragments.\n'
  exit 0
fi

base="$(git rev-parse --verify --quiet origin/main || echo main)"
merge_base=$(git merge-base "$base" HEAD 2>/dev/null) || merge_base=
if [ -z "$merge_base" ]; then
  printf 'pre-push fragments: no origin/main or main to diff against — skipping.\n'
  exit 0
fi

report=$(python3 .claude/scripts/changelog_backfill.py \
  --since "$merge_base" --validate --changed-only 2>&1)
status=$?
[ "$status" -eq 0 ] && exit 0

printf '%s\n' "$report"
printf '\ngit push refused: a changelog fragment in this push fails the required\n'
printf '`fragment-present` check. For a seeded fragment (the file named above):\n\n'
printf '  * rewrite its bullet for a person and delete the seed comment line, or\n'
printf '  * delete the whole file if the change needs no changelog entry.\n\n'
printf 'Leave its `covers:` lines alone. Commit the fix, then push again.\n\n'
exit 1
