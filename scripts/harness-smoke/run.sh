#!/usr/bin/env bash
# The H tier — ask a real `claude`, `codex` or `opencode` what it found in a tree
# the projection engine just wrote.
#
#   DORKOS_HARNESS_SMOKE=1 ANTHROPIC_API_KEY=<key> \
#     bash scripts/harness-smoke/run.sh claude --max-usd 0.50
#
# It spends real money, so it is gated by BOTH the flag above and the harness's
# own named key; a key alone arms nothing and a sign-in stored on this machine is
# never read. Without both it writes a SKIP report that says which one is
# missing, and exits 0 — the gate refusing is the gate working.
#
# Never run this from CI, and never add any of its variable names to a turbo
# task: `packages/evals/src/runner/__tests__/paid-provider.test.ts` walks the
# whole parsed turbo.json for them.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

if [[ ! -x "$repo/node_modules/.bin/tsx" ]]; then
  echo "tsx is not installed; run \`pnpm install\` first." >&2
  exit 2
fi

if [[ ! -f "$repo/packages/harness/dist/index.js" ]]; then
  echo "The projection engine is not built. Run:" >&2
  echo "  pnpm exec turbo build --filter=@dorkos/harness" >&2
  exit 2
fi

exec "$repo/node_modules/.bin/tsx" "$here/run.ts" "$@"
