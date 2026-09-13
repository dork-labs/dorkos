#!/usr/bin/env bash
# in-project.sh — run a repo hook inside the checkout Claude is working in, but
# only when that checkout IS this project: the main checkout or one of its
# linked worktrees.
#
# Why this exists. Every hook in settings.json used to start with
# `cd "$(git rev-parse --show-toplevel)"`, which resolves the repo from the
# shell's CURRENT directory. When a session `cd`s into a sibling repository
# (one granted through permissions.additionalDirectories), every hook then ran
# in that repo, found no .claude/hooks/, and failed with "No such file or
# directory" — silently skipping checkpoints, formatting and docs checks for
# the turn, and (worse) the PreToolUse guards (2026-09-13).
#
# ${CLAUDE_PROJECT_DIR} is the project root where the session started. Claude
# Code keeps it fixed across `cd` and across entering a worktree, so
# settings.json can always find this wrapper. The wrapper then:
#   1. exits 0, silently, when the current directory is not inside a git
#      checkout;
#   2. exits 0, silently, when the current checkout does not share this
#      project's git common dir — it is a different repository, not a worktree
#      of this one;
#   3. otherwise cds to the current checkout's toplevel and execs the hook
#      there, exactly as before, so a worktree runs its own copy of the hook
#      against its own tree.
# With CLAUDE_PROJECT_DIR unset (an older CLI), step 2 is skipped and the only
# change from the old behaviour is that a checkout without .claude/hooks is
# skipped instead of erroring.
#
# The PreToolUse guards (file-guard, git-guard, process-guard) do NOT go
# through this wrapper: they must run whatever repo Claude is in, so
# settings.json anchors them with `cd "${CLAUDE_PROJECT_DIR}"` directly.
#
# Usage (settings.json):
#   "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.claude/hooks/in-project.sh" <command...>
# Fixtures: scripts/test-in-project-hook.sh
set -u
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
root=${CLAUDE_PROJECT_DIR:-}
if [ -n "$root" ] && [ -d "$root" ]; then
  project_common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
  current_common=$(git -C "$top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
  [ "$project_common" = "$current_common" ] || exit 0
fi
cd "$top" || exit 0
[ -d .claude/hooks ] || exit 0
exec "$@"
