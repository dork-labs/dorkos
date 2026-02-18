#!/usr/bin/env bash
# Update roadmap item status via the Express API.
#
# Usage: update_status.sh <item-id> <status>
# Valid statuses: not-started, in-progress, completed, on-hold
set -euo pipefail

API="${ROADMAP_API:-http://localhost:4243/api/roadmap}"

# Health check
if ! curl -sf "${API%/roadmap}/health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running. Start it with: npm run dev --filter=@dorkos/roadmap" >&2
  exit 1
fi

# Argument validation
if [ $# -ne 2 ]; then
  echo "Usage: $0 <item-id> <status>"
  echo "Valid statuses: not-started, in-progress, completed, on-hold"
  exit 1
fi

ITEM_ID="$1"
STATUS="$2"

# Validate status value
case "$STATUS" in
  not-started|in-progress|completed|on-hold) ;;
  *)
    echo "Error: Invalid status '$STATUS'" >&2
    echo "Valid statuses: not-started, in-progress, completed, on-hold" >&2
    exit 1
    ;;
esac

# PATCH the item status
if ! RESPONSE=$(curl -sf -X PATCH "$API/items/$ITEM_ID" \
  -H "Content-Type: application/json" \
  -d "{\"status\": \"$STATUS\"}"); then
  echo "Error: Failed to update item '$ITEM_ID'" >&2
  exit 1
fi

echo "$RESPONSE" | jq .
