#!/usr/bin/env bash
# Clear all roadmap items by deleting each one via the Express API.
#
# Usage: clear_roadmap.sh
# Fetches all items, then DELETEs each one individually.
set -euo pipefail

API="${ROADMAP_API:-http://localhost:4243/api/roadmap}"

# Health check
if ! curl -sf "${API%/roadmap}/health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running. Start it with: npm run dev --filter=@dorkos/roadmap" >&2
  exit 1
fi

# Get all item IDs
if ! ITEMS=$(curl -sf "$API/items"); then
  echo "Error: Failed to fetch items" >&2
  exit 1
fi

IDS=$(echo "$ITEMS" | jq -r '.[].id')
COUNT=$(echo "$ITEMS" | jq 'length')

if [ "$COUNT" -eq 0 ]; then
  echo "Roadmap is already empty."
  exit 0
fi

echo "Deleting $COUNT items..."

DELETED=0
FAILED=0

for ID in $IDS; do
  if curl -sf -X DELETE "$API/items/$ID" > /dev/null 2>&1; then
    DELETED=$((DELETED + 1))
  else
    echo "  Warning: Failed to delete item $ID" >&2
    FAILED=$((FAILED + 1))
  fi
done

echo "Done. Deleted: $DELETED, Failed: $FAILED"
