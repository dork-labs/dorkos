#!/usr/bin/env bash
# Find roadmap items by title (case-insensitive) via the Express API.
#
# Usage: find_by_title.sh <query>
# Outputs: single item ID if one match, JSON array if multiple matches.
# Exit codes: 0 = found, 1 = error/no match, 2 = multiple matches.
set -euo pipefail

API="${ROADMAP_API:-http://localhost:4243/api/roadmap}"

# Health check
if ! curl -sf "${API%/roadmap}/health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running. Start it with: npm run dev --filter=@dorkos/roadmap" >&2
  exit 1
fi

# Argument validation
if [ $# -lt 1 ]; then
  echo "Usage: $0 <title-query>"
  exit 1
fi

QUERY="$*"
QUERY_LOWER=$(echo "$QUERY" | tr '[:upper:]' '[:lower:]')

# GET all items and filter by title
if ! ITEMS=$(curl -sf "$API/items"); then
  echo "Error: Failed to fetch items" >&2
  exit 1
fi

# Filter items whose title contains the query (case-insensitive)
MATCHES=$(echo "$ITEMS" | jq --arg q "$QUERY_LOWER" \
  '[.[] | select(.title | ascii_downcase | contains($q)) | { id, title, status, moscow }]')

COUNT=$(echo "$MATCHES" | jq 'length')

if [ "$COUNT" -eq 0 ]; then
  echo "No items found matching '$QUERY'" >&2
  exit 1
elif [ "$COUNT" -eq 1 ]; then
  echo "$MATCHES" | jq -r '.[0].id'
else
  echo "$MATCHES" | jq .
  exit 2
fi
