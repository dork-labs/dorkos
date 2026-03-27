#!/usr/bin/env bash
# PostToolUse hook: remind to review ADRs when a spec transitions to "implemented".
# Fires on Write tool — checks if file_path matches specs/*/04-implementation.md.
# Non-blocking: always exits 0.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

[ -z "$FILE_PATH" ] && exit 0

# Only act on implementation summary files
if [[ ! "$FILE_PATH" =~ specs/([^/]+)/04-implementation\.md$ ]]; then
  exit 0
fi

SLUG="${BASH_REMATCH[1]}"
[ -z "$SLUG" ] && exit 0

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ADR_MANIFEST="$PROJECT_ROOT/decisions/manifest.json"

[ ! -f "$ADR_MANIFEST" ] && exit 0

# Count proposed ADRs linked to this spec
PROPOSED_COUNT=$(python3 -c "
import json, sys
with open('$ADR_MANIFEST') as f:
    manifest = json.load(f)
count = sum(1 for d in manifest.get('decisions', [])
            if d.get('status') == 'proposed'
            and d.get('specSlug') == '$SLUG')
print(count)
" 2>/dev/null || echo "0")

if [ "$PROPOSED_COUNT" != "0" ] && [ "$PROPOSED_COUNT" != "" ]; then
  echo "[ADR Review] Spec '$SLUG' is now implemented with $PROPOSED_COUNT proposed ADR(s) — run /adr:review $SLUG to accept them."
fi

exit 0
