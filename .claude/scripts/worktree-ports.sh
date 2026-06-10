#!/usr/bin/env bash
# Print port assignments for every worktree, one line each:
#
#   <folder-name>\t<DORKOS_PORT>\t<VITE_PORT>
#
# Used by /worktree:list. Ports live in each worktree's .env (written by
# worktree-setup.sh), but the agent can't read .env directly — the
# file-guard hook denies it to keep secrets out of context. This script
# extracts only the two port values, so nothing sensitive is exposed.
# Missing .env or missing keys print as "?".

set -uo pipefail

while IFS= read -r line; do
  dir="${line#worktree }"
  name="$(basename "$dir")"
  dorkos=""
  vite=""
  if [[ -f "$dir/.env" ]]; then
    dorkos="$(grep -m1 '^DORKOS_PORT=' "$dir/.env" | cut -d= -f2 || true)"
    vite="$(grep -m1 '^VITE_PORT=' "$dir/.env" | cut -d= -f2 || true)"
  fi
  printf '%s\t%s\t%s\n' "$name" "${dorkos:-?}" "${vite:-?}"
done < <(git worktree list --porcelain | grep '^worktree ')
