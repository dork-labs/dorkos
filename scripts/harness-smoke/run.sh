#!/usr/bin/env bash
# The H tier — ask a real `claude`, `codex` or `opencode` what it found in a tree
# the projection engine just wrote.
#
#   bash scripts/harness-smoke/run.sh claude --free
#   DORKOS_HARNESS_SMOKE=1 ANTHROPIC_API_KEY=<key> \
#     bash scripts/harness-smoke/run.sh claude --max-usd 0.50
#
# Flags: --free --scenario <project|user-tier> --max-usd N --report DIR --binary PATH --model ID
#
# `--free` reaches no model, so it needs neither the flag nor a key; it answers
# everything that happens before the first API request and reports NOT RUN for
# the rest. The paid form spends real money, so it is gated by BOTH the flag and
# the harness's own named key; a key alone arms nothing, and a sign-in stored on
# this machine is never read by either form. Without both it writes a SKIP report
# naming the one that is missing, and exits 0 — the gate refusing is the gate
# working.
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
