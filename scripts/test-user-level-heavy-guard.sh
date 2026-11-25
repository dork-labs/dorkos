#!/usr/bin/env bash
# Fixture suite for .claude/hooks/user-level-heavy-guard.sh, the wrapper a
# user-level settings.json runs so sessions homed outside this repo are held by
# the heavy-command guard while they work in DorkOS — and never anywhere else.
#
# A throwaway "DorkOS" repo gets a copy of the wrapper, the guard and their
# helpers, plus a linked worktree; an unrelated repo and a plain folder stand in
# for the Mac's other projects. Each case pipes a real PreToolUse payload in.
#
#   bash scripts/test-user-level-heavy-guard.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d -t user-level-heavy-guard.XXXXXX)
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
for f in user-level-heavy-guard.sh heavy-command-guard.mjs run-node-hook.sh lib/shell-command.mjs; do
  cp "$repo_root/.claude/hooks/$f" "$dorkos/.claude/hooks/$f"
done
wrapper=$dorkos/.claude/hooks/user-level-heavy-guard.sh
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

check 'another repo: turbo build runs untouched and silently' 'exit=0 said=no' \
  "$(verdict "$other" 'turbo build')"
check 'another repo: a whole vitest run is not ours' 'exit=0 said=no' "$(verdict "$other" 'npx vitest run')"
check 'a plain folder: a whole vitest run is not ours' 'exit=0 said=no' "$(verdict "$plain" 'vitest run')"
check 'another repo: a leading cd to another plain folder stays out' 'exit=0 said=no' \
  "$(verdict "$other" "cd $plain && turbo build")"
check 'the DorkOS main checkout: turbo build is refused' 'exit=2 said=yes' "$(verdict "$dorkos" 'turbo build')"
check 'a DorkOS worktree anywhere: a whole vitest run is refused' 'exit=2 said=yes' \
  "$(verdict "$tmp/wt-x" 'pnpm vitest run')"
check 'a plain folder with a leading cd into a DorkOS worktree is refused' 'exit=2 said=yes' \
  "$(verdict "$plain" "cd $tmp/wt-x && pnpm vitest run")"
check 'a relative leading cd into the worktree is followed' 'exit=2 said=yes' \
  "$(verdict "$tmp" 'cd wt-x && turbo build')"
check 'DorkOS, light command: allowed' 'exit=0 said=no' "$(verdict "$dorkos" 'git status')"
check 'DorkOS, through the gate: allowed' 'exit=0 said=no' \
  "$(verdict "$dorkos" 'pnpm heavy turbo build')"
check 'a non-Bash tool is ignored' 'exit=0 said=no' "$(verdict "$dorkos" 'npx tsc' Read)"
check 'a session homed in DorkOS is left to its project hooks' 'exit=0 said=no' \
  "$(CLAUDE_PROJECT_DIR=$dorkos verdict "$tmp/wt-x" 'turbo build')"
check 'a session homed elsewhere is guarded in DorkOS' 'exit=2 said=yes' \
  "$(CLAUDE_PROJECT_DIR=$other verdict "$tmp/wt-x" 'turbo build')"
status=$(printf '' | "$wrapper" >/dev/null 2>&1; echo $?)
check 'an empty payload passes' 0 "$status"
status=$(printf 'not json' | "$wrapper" >/dev/null 2>&1; echo $?)
check 'an unreadable payload passes' 0 "$status"

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
