#!/usr/bin/env bash
# Fixture suite for .claude/hooks/user-level-guards.sh, the wrapper a user-level
# settings.json would run so sessions homed outside this repo get all six of
# its PreToolUse(Bash) guards while they work in DorkOS — and none elsewhere.
#
# A throwaway "DorkOS" repo gets a copy of the wrapper, the six guards and
# their helpers, plus a linked worktree; an unrelated repo and a plain folder
# stand in for the Mac's other projects. Each case pipes a real payload in.
#
#   bash scripts/test-user-level-guards.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d -t user-level-guards.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
unset DORKOS_SESSION_ID CLAUDE_PROJECT_DIR

pass=0
fail=0
check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$name" "$expected" "$actual" >&2
  fi
}

mk_repo() { git init -q "$1" && git -C "$1" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init; }

dorkos=$tmp/dorkos
mk_repo "$dorkos"
mkdir -p "$dorkos/.claude/hooks/lib"
for f in user-level-guards.sh run-node-hook.sh lib/shell-command.mjs file-guard.mjs git-guard.mjs \
  process-guard.mjs merge-guard.mjs pr-create-guard.mjs heavy-command-guard.mjs; do
  cp "$repo_root/.claude/hooks/$f" "$dorkos/.claude/hooks/$f"
done
# file-guard's deny rules come from the checkout's own settings.json.
cp "$repo_root/.claude/settings.json" "$dorkos/.claude/settings.json"
wrapper=$dorkos/.claude/hooks/user-level-guards.sh
git -C "$dorkos" worktree add -q "$tmp/wt-x" -b x
other=$tmp/other
mk_repo "$other"
plain=$tmp/plain
mkdir -p "$plain"

# verdict <cwd> <command> [tool] -> "exit=<code> said=<yes|no>"
verdict() {
  local cwd=$1 command=$2 tool=${3:-Bash} payload out code
  payload=$(jq -cn --arg c "$command" --arg d "$cwd" --arg t "$tool" \
    '{tool_name: $t, cwd: $d, tool_input: {command: $c}}')
  out=$(printf '%s' "$payload" | "$wrapper" 2>&1 >/dev/null)
  code=$?
  printf 'exit=%s said=%s' "$code" "$([ -n "$out" ] && echo yes || echo no)"
}

# The hook process as a session homed OUTSIDE DorkOS starts it: its working
# folder and CLAUDE_PROJECT_DIR are the agent home, not the checkout (t2, Nov 25).
verdict_from_home() {
  local cwd=$1 command=$2 payload out code
  payload=$(jq -cn --arg c "$command" --arg d "$cwd" '{tool_name: "Bash", cwd: $d, tool_input: {command: $c}}')
  out=$(cd "$plain" && printf '%s' "$payload" | CLAUDE_PROJECT_DIR=$plain "$wrapper" 2>&1 >/dev/null)
  code=$?
  printf 'exit=%s said=%s' "$code" "$([ -n "$out" ] && echo yes || echo no)"
}

# --- each guard refuses in a DorkOS worktree ---
check 'git-guard: git stash in a DorkOS worktree' 'exit=2 said=yes' "$(verdict "$tmp/wt-x" 'git stash')"
check 'process-guard: pkill by name in a DorkOS worktree' 'exit=2 said=yes' "$(verdict "$tmp/wt-x" 'pkill -f node')"
check 'heavy-command-guard: turbo build in the main checkout' 'exit=2 said=yes' "$(verdict "$dorkos" 'turbo build')"
check 'pr-create-guard: a raw gh pr create' 'exit=2 said=yes' "$(verdict "$tmp/wt-x" 'gh pr create --title x --body y')"
check 'file-guard: reading a .env file' 'exit=2 said=yes' "$(verdict "$tmp/wt-x" 'cat .env')"
check 'a leading cd into the worktree is followed' 'exit=2 said=yes' "$(verdict "$plain" "cd $tmp/wt-x && git stash")"
check 'file-guard from an agent home: a leading cd, then cat .env' 'exit=2 said=yes' \
  "$(verdict_from_home "$plain" "cd $tmp/wt-x && cat .env")"
check 'file-guard from an agent home: payload cwd in a worktree, cat .env' 'exit=2 said=yes' \
  "$(verdict_from_home "$tmp/wt-x" 'cat .env')"
check 'file-guard from an agent home: an absolute .env path' 'exit=2 said=yes' \
  "$(verdict_from_home "$tmp/wt-x" "cat $tmp/wt-x/apps/server/.env")"
check 'from an agent home: .env.example stays readable' 'exit=0 said=no' \
  "$(verdict_from_home "$tmp/wt-x" 'cat .env.example')"
check 'from an agent home: git stash with a leading cd' 'exit=2 said=yes' \
  "$(verdict_from_home "$plain" "cd $tmp/wt-x && git stash")"
check 'from an agent home: cat .env in another repo is untouched' 'exit=0 said=no' \
  "$(verdict_from_home "$other" 'cat .env')"
# --- allowed in DorkOS ---
check 'git status in DorkOS is allowed' 'exit=0 said=no' "$(verdict "$tmp/wt-x" 'git status')"
check 'git stash list in DorkOS is allowed' 'exit=0 said=no' "$(verdict "$tmp/wt-x" 'git stash list')"
check 'through the gate is allowed' 'exit=0 said=no' "$(verdict "$dorkos" 'pnpm heavy turbo build')"
# --- never anywhere else ---
check 'another repo: git stash is untouched' 'exit=0 said=no' "$(verdict "$other" 'git stash')"
check 'another repo: pkill is untouched' 'exit=0 said=no' "$(verdict "$other" 'pkill -f node')"
check 'another repo: gh pr create is untouched' 'exit=0 said=no' "$(verdict "$other" 'gh pr create --title x --body y')"
check 'a plain folder: turbo build is untouched' 'exit=0 said=no' "$(verdict "$plain" 'turbo build')"
# --- the edges ---
check 'a session homed in DorkOS is left to its project hooks' 'exit=0 said=no' \
  "$(CLAUDE_PROJECT_DIR=$dorkos verdict "$tmp/wt-x" 'git stash')"
check 'a non-Bash tool is ignored' 'exit=0 said=no' "$(verdict "$dorkos" 'git stash' Read)"
status=$(printf '' | "$wrapper" >/dev/null 2>&1; echo $?)
check 'an empty payload passes' 0 "$status"
status=$(printf 'not json' | "$wrapper" >/dev/null 2>&1; echo $?)
check 'an unreadable payload passes' 0 "$status"

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
