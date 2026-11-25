#!/usr/bin/env bash
# user-level-guards.sh — every PreToolUse(Bash) guard this repo's own
# settings.json runs, for Claude Code sessions that do not load those settings,
# and ONLY when they work in DorkOS.
#
# WHY THIS EXISTS
#
# Project hooks come from the project a session starts in. Sessions homed
# outside this repo (agent homes such as ~/.dork/agents/ci-steward, every
# helper they start, and anyone's ad-hoc session elsewhere) load none of
# .claude/settings.json. user-level-heavy-guard.sh (#4415) gave them the
# heavy-command guard; this gives them the other five as well: file-guard
# (secret files), git-guard (`git stash`, discarding a path), process-guard
# (kill by name), merge-guard (no admin merge) and pr-create-guard (PRs only
# through scripts/open-pr.sh). Nov 25: a helper homed outside the repo ran
# `git stash` in a DorkOS worktree, which every worktree shares.
#
# Same decision as user-level-heavy-guard.sh, so other repositories on the
# Mac are never touched:
#   1. Not a Bash call, or no payload: exit 0.
#   2. The session's own project (CLAUDE_PROJECT_DIR) is a DorkOS checkout:
#      exit 0 — its project settings already run these guards.
#   3. The payload's cwd, or the directory a leading `cd` moves to, shares
#      THIS repo's git common dir: run each guard from this checkout with the
#      same payload, through run-node-hook.sh (fail closed when node is
#      missing), and stop at the first refusal (exit 2 with its message).
#   4. Anything else, including any failure to decide: exit 0, silently.
#
# User-level settings.json entry (it REPLACES the user-level-heavy-guard.sh
# entry; the heavy guard is one of the six here):
#   "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command",
#     "command": "/Users/doriancollier/Keep/dork-os/dorkos/.claude/hooks/user-level-guards.sh" }] }]
#
# Fixtures: scripts/test-user-level-guards.sh.
set -u
JQ=${JQ:-/usr/bin/jq}
GUARDS=(file-guard git-guard process-guard merge-guard pr-create-guard heavy-command-guard)
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
  dir=${dir#\"}
  dir=${dir%\"}
  dir=${dir#\'}
  dir=${dir%\'}
  case "$dir" in
    \~ | \~/*) dir="$HOME${dir#\~}" ;;
    /*) ;;
    *) dir="${cwd:-.}/$dir" ;;
  esac
  targets+=("$dir")
fi

for target in "${targets[@]}"; do
  if [ "$(common_of "$target")" = "$repo_common" ]; then
    for guard in "${GUARDS[@]}"; do
      [ -f "$here/$guard.mjs" ] || continue
      printf '%s' "$payload" | "$here/run-node-hook.sh" "$here/$guard.mjs"
      status=$?
      [ "$status" -eq 0 ] || exit 2
    done
    exit 0
  fi
done
exit 0
