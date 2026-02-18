#!/usr/bin/env bash
# Link all spec directories to their matching roadmap items via the Express API.
#
# Usage: link_all_specs.sh [--dry-run]
# Matches specs to items by slugifying item titles and comparing to spec directory names.
set -euo pipefail

API="${ROADMAP_API:-http://localhost:4243/api/roadmap}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=false

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
  echo "DRY RUN - No changes will be made"
  echo ""
fi

# Health check
if ! curl -sf "${API%/roadmap}/health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running. Start it with: npm run dev --filter=@dorkos/roadmap" >&2
  exit 1
fi

# Find project root via git
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SPECS_DIR="$PROJECT_ROOT/specs"

if [ ! -d "$SPECS_DIR" ]; then
  echo "Error: specs/ directory not found at $SPECS_DIR" >&2
  exit 1
fi

# Fetch all items
if ! ITEMS=$(curl -sf "$API/items"); then
  echo "Error: Failed to fetch items" >&2
  exit 1
fi

ITEM_COUNT=$(echo "$ITEMS" | jq 'length')
echo "Scanning specs/ directory..."
echo "Found $ITEM_COUNT roadmap items"
echo ""

LINKED=0
SKIPPED=0
NOT_FOUND=0

# Iterate over spec directories
for SPEC_DIR in "$SPECS_DIR"/*/; do
  [ -d "$SPEC_DIR" ] || continue
  SPEC_SLUG=$(basename "$SPEC_DIR")

  # Skip if no spec files exist
  HAS_FILES=false
  for f in 01-ideation.md 02-specification.md 03-tasks.md 04-implementation.md; do
    if [ -f "$SPEC_DIR/$f" ]; then
      HAS_FILES=true
      break
    fi
  done
  if [ "$HAS_FILES" = false ]; then
    continue
  fi

  # Find matching item by slugifying titles
  MATCH=$(echo "$ITEMS" | jq -r --arg slug "$SPEC_SLUG" '
    .[] | select(
      (.title | ascii_downcase | gsub("[^a-z0-9\\s-]"; "") | gsub("[\\s_]+"; "-") | gsub("-+"; "-") | gsub("^-|-$"; "")) == $slug
      or (.linkedArtifacts.specSlug // "") == $slug
    ) | .id' | head -1)

  if [ -z "$MATCH" ]; then
    echo "  $SPEC_SLUG: No matching roadmap item found"
    NOT_FOUND=$((NOT_FOUND + 1))
    continue
  fi

  # Check if already linked
  CURRENT_SLUG=$(echo "$ITEMS" | jq -r --arg id "$MATCH" '.[] | select(.id == $id) | .linkedArtifacts.specSlug // ""')
  if [ "$CURRENT_SLUG" = "$SPEC_SLUG" ]; then
    TITLE=$(echo "$ITEMS" | jq -r --arg id "$MATCH" '.[] | select(.id == $id) | .title')
    echo "  $SPEC_SLUG: Already linked to '$TITLE'"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  TITLE=$(echo "$ITEMS" | jq -r --arg id "$MATCH" '.[] | select(.id == $id) | .title')

  if [ "$DRY_RUN" = true ]; then
    echo "  $SPEC_SLUG: Would link to '$TITLE'"
    LINKED=$((LINKED + 1))
  else
    # Delegate to link_spec.sh
    if "$SCRIPT_DIR/link_spec.sh" "$MATCH" "$SPEC_SLUG" > /dev/null 2>&1; then
      echo "  $SPEC_SLUG: Linked to '$TITLE'"
      LINKED=$((LINKED + 1))
    else
      echo "  $SPEC_SLUG: Failed to link to '$TITLE'" >&2
      NOT_FOUND=$((NOT_FOUND + 1))
    fi
  fi
done

echo ""
echo "Summary:"
echo "  - Linked: $LINKED"
echo "  - Already linked (skipped): $SKIPPED"
echo "  - No matching item: $NOT_FOUND"
