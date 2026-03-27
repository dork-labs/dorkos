#!/bin/bash
# Check if ADR review is due (>14d since last run or never run) and proposed count exceeds threshold
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
LAST_FILE="$REPO_ROOT/decisions/.last-reviewed"
MANIFEST="$REPO_ROOT/decisions/manifest.json"

# Check if manifest exists
if [ ! -f "$MANIFEST" ]; then
  exit 0
fi

# Count proposed ADRs
PROPOSED_COUNT=$(node -e "
  const m = require('$MANIFEST');
  const proposed = (m.decisions || []).filter(d => d.status === 'proposed');
  console.log(proposed.length);
" 2>/dev/null || echo "0")

# Only nag if proposed count is significant (>50)
if [ "$PROPOSED_COUNT" -le 50 ]; then
  exit 0
fi

# Check timestamp — review every 14 days
NEEDS_REVIEW=false
if [ ! -f "$LAST_FILE" ]; then
  NEEDS_REVIEW=true
else
  LAST_TS=$(cat "$LAST_FILE" 2>/dev/null || echo "")
  if [ -z "$LAST_TS" ]; then
    NEEDS_REVIEW=true
  else
    LAST_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null || echo "0")
    NOW_EPOCH=$(date +%s)
    DIFF=$(( NOW_EPOCH - LAST_EPOCH ))
    # 14 days = 1209600 seconds
    if [ "$DIFF" -gt 1209600 ]; then
      NEEDS_REVIEW=true
    fi
  fi
fi

if [ "$NEEDS_REVIEW" = "true" ]; then
  echo "[ADR Review Due] $PROPOSED_COUNT proposed ADR(s) in backlog — run /adr:review to accept implemented decisions"
fi
