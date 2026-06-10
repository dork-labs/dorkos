#!/usr/bin/env bash
# Post-create hook for git-worktree-runner (gtr).
#
# Patches .env with worktree-unique ports so parallel `pnpm dev` instances
# don't collide on DORKOS_PORT (Express) or VITE_PORT (Vite).
#
# Assumes .gtrconfig already copied the live .env from the main repo
# (copy.include = .env). If .env is missing the app has no config at all —
# we warn so the user knows to create one in the main repo. We do NOT fall
# back to .env.example: .env is the runtime source of truth, and silently
# scaffolding from a stale template would mask a real setup problem.

set -euo pipefail

if [[ ! -f .env ]]; then
  echo "worktree-setup: no .env found in worktree." >&2
  echo "  .gtrconfig copies .env from the main repo; create one there first." >&2
  echo "  Hint: cp .env.example .env  (run from the main repo)" >&2
  exit 0
fi

# Derive two deterministic ports from the worktree folder name.
# Range split keeps server/client disjoint and avoids conflicts with:
#   - code defaults (4241/4242)
#   - dev convention in main repo .env (6241/6242)
#
#   DORKOS_PORT (Express) → 4250-4399
#   VITE_PORT   (Vite)    → 4400-4549
#
# Ports are paired by a shared offset. Vite proxies /api to DORKOS_PORT
# (apps/client/vite.config.ts), so both must match within one worktree.
FOLDER_NAME="$(basename "$(pwd)")"
HASH=$(printf '%s' "$FOLDER_NAME" | cksum | awk '{print $1}')
OFFSET=$(( HASH % 150 ))

# 150 slots invite birthday collisions once a few worktrees exist, so probe:
# if another worktree's .env already claims the slot, advance to the next.
port_taken() {
  local port="$1" line dir self
  self="$(pwd)"
  while IFS= read -r line; do
    dir="${line#worktree }"
    [[ "$dir" -ef "$self" ]] && continue
    [[ -f "$dir/.env" ]] || continue
    if grep -q "^DORKOS_PORT=${port}\$" "$dir/.env"; then
      return 0
    fi
  done < <(git worktree list --porcelain | grep '^worktree ')
  return 1
}

for (( i = 0; i < 150; i++ )); do
  CANDIDATE=$(( (OFFSET + i) % 150 ))
  if ! port_taken $(( CANDIDATE + 4250 )); then
    OFFSET=$CANDIDATE
    break
  fi
done

DORKOS_PORT=$(( OFFSET + 4250 ))
VITE_PORT=$(( OFFSET + 4400 ))

# Replace an existing `KEY=...` line or append it if missing.
# In-place editing differs between BSD and GNU sed, so write via a temp file.
patch_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed "s/^${key}=.*/${key}=${value}/" .env > .env.tmp && mv .env.tmp .env
  else
    echo "${key}=${value}" >> .env
  fi
}

patch_env DORKOS_PORT "$DORKOS_PORT"
patch_env VITE_PORT "$VITE_PORT"

echo "Worktree ready: DORKOS_PORT=${DORKOS_PORT} VITE_PORT=${VITE_PORT}"
