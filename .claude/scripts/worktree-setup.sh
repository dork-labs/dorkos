#!/usr/bin/env bash
# Post-create hook for git-worktree-runner (gtr).
# Copies .env.example → .env and assigns a deterministic port based on folder name.

set -euo pipefail

# Copy .env.example to .env if it exists and .env doesn't
if [[ -f .env.example && ! -f .env ]]; then
  cp .env.example .env
fi

# Derive a deterministic port from the worktree folder name.
# Range: 4250-4399 (150 ports, avoids default 4242).
FOLDER_NAME="$(basename "$(pwd)")"
HASH=$(printf '%s' "$FOLDER_NAME" | cksum | awk '{print $1}')
PORT=$(( (HASH % 150) + 4250 ))

# Patch DORKOS_PORT in .env
if [[ -f .env ]]; then
  if grep -q '^DORKOS_PORT=' .env; then
    sed -i '' "s/^DORKOS_PORT=.*/DORKOS_PORT=${PORT}/" .env
  else
    echo "DORKOS_PORT=${PORT}" >> .env
  fi
fi

echo "Worktree ready: DORKOS_PORT=${PORT}"
