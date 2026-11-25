#!/usr/bin/env bash
# user-level-heavy-guard.sh — the heavy-command guard for Claude Code sessions
# that do not load this repo's own hooks, and ONLY when they work in DorkOS.
#
# WHY THIS EXISTS
#
# Project hooks come from the project a session starts in. Sessions homed
# outside this repo (agent homes such as ~/.dork/agents/ci-steward, and every
# helper they start) load none of .claude/settings.json, so their typechecks
# and test runs in DorkOS worktrees walked around the load gate. On Nov 25 the
# Mac crashed twice on exhausted memory. A USER-level PreToolUse(Bash) hook
# runs in every session, so this wrapper is what a user-level settings.json
# points at.
#
# It must not guard other repositories: this Mac also runs Claude in repos with
# their own tsc and vitest and no `pnpm heavy`. So it decides first, and runs
# nothing at all when the work is not in DorkOS:
#   1. Not a Bash call, or no payload: exit 0.
#   2. The session's own project (CLAUDE_PROJECT_DIR) is a DorkOS checkout:
#      exit 0 — the project settings already run the guard there.
#   3. The payload's cwd, or the directory a leading `cd` in the command
#      moves to, is inside a checkout that shares THIS repo's git common dir
#      (the main checkout or any of its linked worktrees, wherever they live,
#      /private/tmp included): run .claude/hooks/heavy-command-guard.mjs from
#      this checkout with the same payload, through run-node-hook.sh, and
#      return its verdict.
#   4. Anything else, including any failure to decide: exit 0, silently.
#
# User-level settings.json entry (absolute path to the MAIN checkout's copy):
#   "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command",
#     "command": "/Users/doriancollier/Keep/dork-os/dorkos/.claude/hooks/user-level-heavy-guard.sh" }] }]
#
# Fixtures: scripts/test-user-level-heavy-guard.sh.
set -u
JQ=${JQ:-/usr/bin/jq}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 0
repo_common=$(git -C "$here" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0

payload=$(cat) || exit 0
[ -n "$payload" ] || exit 0
[ -x "$JQ" ] || exit 0
[ "$("$JQ" -r '.tool_name // empty' <<<"$payload" 2>/dev/null)" = Bash ] || exit 0

common_of() {
  [ -n "${1:-}" ] && [ -d "$1" ] || return 1
  git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null
}

# 2. The project settings already guard a session homed in DorkOS.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ "$(common_of "$CLAUDE_PROJECT_DIR")" = "$repo_common" ]; then
  exit 0
fi

cwd=$("$JQ" -r '.cwd // empty' <<<"$payload" 2>/dev/null)
command=$("$JQ" -r '.tool_input.command // empty' <<<"$payload" 2>/dev/null)

# 3. Where the command runs: the payload cwd, and a leading `cd <dir>`.
targets=("$cwd")
if [[ "$command" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\;\&\|]+) ]]; then
  dir=${BASH_REMATCH[1]}
  dir=${dir#\"}; dir=${dir%\"}; dir=${dir#\'}; dir=${dir%\'}
  case "$dir" in
    \~ | \~/*) dir="$HOME${dir#\~}" ;;
    /*) ;;
    *) dir="${cwd:-.}/$dir" ;;
  esac
  targets+=("$dir")
fi

for target in "${targets[@]}"; do
  if [ "$(common_of "$target")" = "$repo_common" ]; then
    printf '%s' "$payload" | "$here/run-node-hook.sh" "$here/heavy-command-guard.mjs"
    exit $?
  fi
done
exit 0
