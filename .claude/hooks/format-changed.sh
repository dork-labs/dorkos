#!/usr/bin/env bash
# Stop hook: format everything this working tree changed, once per turn.
#
# WHY THIS IS A `Stop` HOOK AND NOT A `PostToolUse` HOOK
#
# It used to be a PostToolUse hook on Write|Edit|MultiEdit that ran prettier on
# the single file just written — the pattern Claude Code, Copilot and Continue
# all ship as their flagship hook example, and the pattern
# `research/20260320_prettier_formatting_ai_agents.md` called "the
# highest-leverage intervention" (its Layer 1).
#
# That pattern has a documented failure mode, researched in
# `research/20260824_agent_post_edit_formatting_stale_context.md` and reproduced
# live in this repo twice on 2026-08-24 while that report was being written:
# formatting a file immediately after the agent edits it makes the agent's
# in-context copy of that file stale. The agent's NEXT string-replace edit then
# computes `old_string` against text prettier has already rewritten (quotes,
# trailing commas, `**bold**` to `_bold_`) and fails with "String to replace not
# found". Claude Code's own Write-tool error text names linters as a first-class
# cause of this, and Zed issue #55295 reproduces the identical mechanism on a
# different agent. Every failed edit costs a re-read and a retry.
#
# The per-edit pass was buying almost nothing, because formatting in this repo
# is already enforced twice downstream, neither of which an agent can bypass:
#
#   1. lefthook `pre-commit` → `prettier --write {staged_files}` with
#      `stage_fixed: true` (lefthook.yml) — nothing gets committed unformatted.
#   2. CI `prettier --check .` (`pnpm format:check`) inside the REQUIRED
#      `lint` workflow (.github/workflows/lint.yml, DOR-485) — the
#      unforgeable gate.
#
# So the trade was: a real, reproduced edit-failure mode in exchange for a tidy
# tree between two gates that already guarantee tidiness. Moving to `Stop`
# formats once per turn instead of once per edit, which cuts the number of
# staleness windows from "one per Edit call" to "one per turn" while the tree
# still ends every turn formatted.
#
# HONEST ABOUT THE RESIDUAL RISK: this reduces the failure mode, it does not
# eliminate it. Session context survives across turns, so an agent that edits a
# file, ends its turn, and then edits the same region again next turn can still
# hit a stale `old_string`. The 2026-08-24 report's trade-off table says exactly
# this. Eliminating it entirely means formatting only at commit time, which
# gives up the tidy working tree the operator reads between turns.
#
# DELIBERATELY NOT `async: true`. The March report recommended it. Async does
# not fix staleness — the rewrite still lands under the agent's feet, just at an
# unpredictable moment — it only trades a known window for a race. This hook is
# fast enough (see below) that blocking for it is cheaper than reasoning about
# when it finished.
#
# WHICH FILES
#
# A Stop hook gets no `file_path` on stdin, so it has to decide for itself. The
# honest set is "what this working tree changed": unstaged (`git diff`), staged
# (`git diff --cached`), and untracked-but-not-ignored
# (`git ls-files --others --exclude-standard`). Deletions are excluded
# (`--diff-filter=d`) because prettier cannot format a path that is gone. All
# three commands emit repo-relative paths and we run from the repo root, so the
# hook can never reach outside it — and in a linked worktree they report only
# that worktree's changes, which is what "one checkout, one writer" wants.
#
# `.prettierignore` is honored by prettier itself, which skips ignored paths it
# is handed explicitly; the extension filter here only avoids handing prettier
# files it has no parser for. Filenames containing newlines are quoted by git,
# fail the `-f` existence test, and are silently skipped — this repo has none,
# and skipping beats mangling.
#
# `--cache` matters more than it looks: the changed-file set is cumulative over
# a branch's life, so a long-running branch with 200 touched files would
# otherwise re-format all 200 at the end of every single turn. The cache makes
# every turn after the first pay only for files whose content actually moved.
#
# FAILS OPEN, ALWAYS. Exit 2 from a Stop hook blocks the turn from ending; any
# other non-zero prints an error to the operator. Neither is an acceptable
# outcome for a cosmetic pass whose job is already done twice downstream, so
# every path here ends in `exit 0`. No node_modules, no prettier, no git, a
# corrupt cache, a parse error in a half-written file — all no-ops.
#
# Runs in parallel with the other Stop hooks (Claude Code does not order them).
# create-checkpoint.sh may therefore stash pre- or post-format content; that is
# harmless, a checkpoint is a throwaway stash, and prettier never touches the
# git index so the two cannot contend for index.lock.

set -uo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$REPO_ROOT" ] || exit 0
cd "$REPO_ROOT" 2>/dev/null || exit 0

# Pinned workspace binary, never `npx` — same reasoning as the CI gate, which
# resolves prettier from the lockfile so the hook and the gate can never
# disagree about what "formatted" means. Absent (fresh worktree, no install)
# means no-op, not error.
PRETTIER_BIN="$REPO_ROOT/node_modules/.bin/prettier"
[ -x "$PRETTIER_BIN" ] || exit 0

# Same extension set as the lefthook pre-commit `format` glob — the two layers
# must agree on what prettier owns or a file formatted here gets reformatted
# there (or vice versa) and the diff churns.
EXT_RE='\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css|md|mdx|yml|yaml)$'

CHANGED=$(
  {
    git diff --name-only --diff-filter=d
    git diff --name-only --diff-filter=d --cached
    git ls-files --others --exclude-standard
  } 2>/dev/null | sort -u
)
[ -n "$CHANGED" ] || exit 0

FILES=()
while IFS= read -r file; do
  [ -n "$file" ] || continue
  [[ "$file" =~ $EXT_RE ]] || continue
  [ -f "$file" ] || continue
  FILES+=("$file")
done <<<"$CHANGED"

[ ${#FILES[@]} -gt 0 ] || exit 0

# Silent on success, per the harness convention. `--log-level warn` suppresses
# prettier's per-file listing; `--ignore-unknown` is belt-and-braces against the
# extension filter drifting from prettier's parser support.
"$PRETTIER_BIN" --write --cache --ignore-unknown --log-level warn "${FILES[@]}" >/dev/null 2>&1

exit 0
