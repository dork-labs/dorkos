#!/usr/bin/env bash
# Link a spec directory to a roadmap item via the Express API.
#
# Usage: link_spec.sh <item-id> <spec-slug>
# Builds linkedArtifacts from the spec slug and detected files on disk.
set -euo pipefail

API="${ROADMAP_API:-http://localhost:4243/api/roadmap}"

# Health check
if ! curl -sf "${API%/roadmap}/health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running. Start it with: npm run dev --filter=@dorkos/roadmap" >&2
  exit 1
fi

# Argument validation
if [ $# -ne 2 ]; then
  echo "Usage: $0 <item-id> <spec-slug>"
  echo "Example: $0 550e8400-... transaction-sync"
  exit 1
fi

ITEM_ID="$1"
SPEC_SLUG="$2"

# Find project root via git
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Build linkedArtifacts JSON, checking which spec files exist
LINKED=$(jq -n --arg slug "$SPEC_SLUG" '{ specSlug: $slug }')

if [ -f "$PROJECT_ROOT/specs/$SPEC_SLUG/01-ideation.md" ]; then
  LINKED=$(echo "$LINKED" | jq --arg p "specs/$SPEC_SLUG/01-ideation.md" '. + { ideationPath: $p }')
fi
if [ -f "$PROJECT_ROOT/specs/$SPEC_SLUG/02-specification.md" ]; then
  LINKED=$(echo "$LINKED" | jq --arg p "specs/$SPEC_SLUG/02-specification.md" '. + { specPath: $p }')
fi
if [ -f "$PROJECT_ROOT/specs/$SPEC_SLUG/03-tasks.md" ]; then
  LINKED=$(echo "$LINKED" | jq --arg p "specs/$SPEC_SLUG/03-tasks.md" '. + { tasksPath: $p }')
fi
if [ -f "$PROJECT_ROOT/specs/$SPEC_SLUG/04-implementation.md" ]; then
  LINKED=$(echo "$LINKED" | jq --arg p "specs/$SPEC_SLUG/04-implementation.md" '. + { implementationPath: $p }')
fi

# Build PATCH body
BODY=$(jq -n --argjson la "$LINKED" '{ linkedArtifacts: $la }')

# PATCH the item
if ! RESPONSE=$(curl -sf -X PATCH "$API/items/$ITEM_ID" \
  -H "Content-Type: application/json" \
  -d "$BODY"); then
  echo "Error: Failed to update item '$ITEM_ID'" >&2
  exit 1
fi

echo "Linked item to specs/$SPEC_SLUG/"
echo "$RESPONSE" | jq '.linkedArtifacts'
