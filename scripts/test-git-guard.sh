#!/usr/bin/env bash
# Fixture suite for .claude/hooks/git-guard.mjs, the PreToolUse(Bash) guard that
# refuses the git commands that have destroyed work in this repo.
#
# It exists because reasoning about what a guard WOULD catch is not evidence
# about what it DOES catch. Every case below is run through the hook's real
# entry point (a PreToolUse payload on stdin) and asserted on the real contract
# (exit 2 to block, exit 0 to allow), so a regression in the matcher shows up
# as a failing case rather than as a lost afternoon.
#
# The allow half matters as much as the block half. A guard that also blocks
# `git checkout main` or `git stash list` is worse than no guard, because the
# next person switches it off.
#
#   bash scripts/test-git-guard.sh
#   GUARD=/path/to/other.mjs bash scripts/test-git-guard.sh
#
# GUARD exists so a neutered or alternative implementation can be run against
# the same fixtures to show what it gets wrong.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
guard=${GUARD:-$repo_root/.claude/hooks/git-guard.mjs}
checkpoint=$repo_root/.claude/hooks/create-checkpoint.sh

payload_dir=$(mktemp -d -t git-guard-payload.XXXXXX)
export GIT_GUARD_FIXTURE_PAYLOAD=$payload_dir/payload.json
trap 'rm -rf "$payload_dir"' EXIT

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

# Run one command through the hook exactly as Claude Code would, and report the
# verdict: allow, or which of the three refusals fired.
# The payload goes through a file rather than a pipe on purpose: under
# `pipefail` a guard that exits before draining stdin gives the payload writer
# EPIPE, and that status masks the guard's own verdict.
verdict() {
  local command=$1 stderr status
  GIT_GUARD_FIXTURE_COMMAND="$command" node -e '
      require("fs").writeFileSync(
        process.env.GIT_GUARD_FIXTURE_PAYLOAD,
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: process.env.GIT_GUARD_FIXTURE_COMMAND },
        })
      );
    '
  stderr=$(node "$guard" <"$GIT_GUARD_FIXTURE_PAYLOAD" 2>&1 >/dev/null)
  status=$?

  if [ "$status" -eq 0 ]; then
    echo allow
    return
  fi
  if [ "$status" -ne 2 ]; then
    echo "exit-$status"
    return
  fi
  case "$stderr" in
    "Blocked: git stash"*) echo block-stash ;;
    "Blocked: git checkout"*) echo block-checkout ;;
    "Blocked: git restore"*) echo block-restore ;;
    *) echo "block-unknown" ;;
  esac
}

# Each line is `<expected-verdict> <command>`. The comments record why the case
# is here, so a future edit that flips one has to argue with the reason.
while read -r expected command; do
  [ -n "${expected:-}" ] || continue
  case "$expected" in \#*) continue ;; esac
  check "$command" "$expected" "$(verdict "$command")"
done <<'CASES'
# --- stash: the shared stack. Bare and every mutating subcommand. ---
block-stash git stash
block-stash git stash -u
block-stash git stash --include-untracked
block-stash git stash -k
block-stash git stash push -u src/
block-stash git stash pop
block-stash git stash apply
block-stash git stash apply stash@{2}
block-stash git stash drop
block-stash git stash clear
block-stash git stash store -m note deadbeef
block-stash git stash branch topic
block-stash git stash save wip
block-stash git stash create
# The three spellings the native prefix matcher cannot see (see PR body).
block-stash cd /tmp && git stash
block-stash git  stash
block-stash git -C /some/dir stash
block-stash pnpm build && git stash -u && pnpm test
block-stash sh -c "git stash pop"
block-stash echo $(git stash pop)
# --- stash: read-only forms stay usable. This is how you prove nothing was lost. ---
allow git stash list
allow git stash list --stat
allow git stash show stash@{0}
allow git stash show -p stash@{0}
allow git -C /some/dir stash list
# --- checkout: the pathspec form that silently reverts your own edits. ---
block-checkout git checkout -- src/app.ts
block-checkout git checkout -- .
block-checkout git checkout --  src/a.ts src/b.ts
block-checkout git checkout -f -- src/app.ts
block-checkout git checkout HEAD -- src/app.ts
block-checkout git checkout .
block-checkout git checkout ./src
block-checkout git checkout ../sibling/file.ts
block-checkout cd apps/server && git checkout -- src/index.ts
# --- checkout: branch switching must never be touched. ---
allow git checkout main
allow git checkout -b chore/guard-destructive-git-commands
allow git checkout -B topic origin/main
allow git checkout feature/some-branch
allow git checkout -
allow git checkout --detach
allow git checkout 661ab3156
# A named source other than HEAD is a deliberate retrieval, not a blind discard.
allow git checkout HEAD~1 -- src/app.ts
allow git checkout origin/main -- package.json
# Conflict resolution names its side, so it is not a blind discard either.
allow git checkout --ours -- src/app.ts
# --- restore: the same discard under a newer name. ---
block-restore git restore src/app.ts
block-restore git restore .
block-restore git restore --staged --worktree src/app.ts
block-restore git restore -S -W src/app.ts
block-restore git restore --worktree src/app.ts
block-restore git restore --source=HEAD src/app.ts
block-restore git restore -s HEAD src/app.ts
# --- restore: unstaging and deliberate retrieval stay usable. ---
allow git restore --staged src/app.ts
allow git restore --source=HEAD~1 src/app.ts
allow git restore --source origin/main -- package.json
allow git restore --ours src/app.ts
# --- everything else the repo runs every day. ---
allow git status
allow git diff src/app.ts
allow git worktree add ../wt -b topic
allow git worktree remove ../wt
allow git worktree list
allow git clean -fd
allow git reset --hard 661ab3156
allow git reset --hard origin/main
allow git add -A
allow git commit -m "wip"
allow git push -u origin HEAD
allow git log --oneline -20
allow git stash-like-tool run
allow gh pr create --title "chore: guard git stash and git checkout --"
CASES

# Quoted text that merely NAMES a blocked command must not trip the guard, or
# writing the commit that ships this guard becomes impossible.
check 'commit message naming git stash' allow \
  "$(verdict 'git commit -m "refuse git stash and git checkout -- <path>"')"
check 'commit message with an operator inside quotes' allow \
  "$(verdict 'git commit -m "git stash && git checkout -- x are blocked"')"

# --- The guard must be able to FAIL. A neutered copy has to break this suite. ---
# Without this, a matcher that quietly stopped matching would look like 60 green
# assertions. Here the same fixture is run against a guard that always allows,
# and the suite records that it gets a different answer.
neutered_dir=$(mktemp -d -t git-guard-neutered.XXXXXX)
printf 'process.exit(0);\n' >"$neutered_dir/guard.mjs"
real_guard=$guard
guard=$neutered_dir/guard.mjs
neutered_verdict=$(verdict 'git stash pop')
guard=$real_guard
check 'a neutered guard allows what the real one blocks' allow "$neutered_verdict"
check 'the real guard blocks it' block-stash "$(verdict 'git stash pop')"
rm -rf "$neutered_dir"

# --- The Stop-hook checkpoint mechanism still works after all of the above. ---
# create-checkpoint.sh calls `git stash create` and `git stash store`, both of
# which the guard refuses when a MODEL types them. It runs from the Stop hook,
# not through the Bash tool, so the guard never sees it. This proves the script
# itself still produces a checkpoint; scripts/test-git-guard.sh cannot prove the
# hook wiring, so that half was verified with a live headless session (PR body).
checkpoint_scratch=$(mktemp -d -t git-guard-checkpoint.XXXXXX)
(
  cd "$checkpoint_scratch" || exit 1
  git init -q main-checkout
  cd main-checkout || exit 1
  git config user.email guard@example.com
  git config user.name Guard
  echo original >tracked.txt
  git add -A
  git commit -qm initial
  # create-checkpoint.sh deliberately skips the shared main checkout, so the
  # checkpoint has to be taken from a linked worktree, same as in real use.
  git worktree add -q ../wt -b topic
  cd ../wt || exit 1
  echo edited >tracked.txt
  bash "$checkpoint"
  git stash list | grep -q 'claude-checkpoint' || exit 1
  # And the checkpoint must actually hold the edit, not an empty tree.
  git stash show -p 'stash@{0}' | grep -q '^+edited$' || exit 1
) >/dev/null 2>&1
check 'create-checkpoint.sh still records a checkpoint' 0 "$?"
rm -rf "$checkpoint_scratch"

printf 'git-guard fixtures: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
