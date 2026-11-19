#!/usr/bin/env bash
# migrate-spec-metadata.sh — Normalize YAML frontmatter in spec ideation files
# One-time migration script. Safe to re-run (idempotent).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
MANIFEST="$REPO_ROOT/specs/manifest.json"
UPDATED=0
SKIPPED=0
ERRORS=0

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: specs/manifest.json not found. Create it first."
  exit 1
fi

# Read manifest entries
SPEC_COUNT=$(python3 -c "import json; m=json.load(open('$MANIFEST')); print(len(m['specs']))")
echo "Processing $SPEC_COUNT specs from manifest..."
echo ""

for i in $(seq 0 $((SPEC_COUNT - 1))); do
  SLUG=$(python3 -c "import json; m=json.load(open('$MANIFEST')); print(m['specs'][$i]['slug'])")
  NUMBER=$(python3 -c "import json; m=json.load(open('$MANIFEST')); print(m['specs'][$i]['number'])")
  CREATED=$(python3 -c "import json; m=json.load(open('$MANIFEST')); print(m['specs'][$i]['created'])")
  STATUS=$(python3 -c "import json; m=json.load(open('$MANIFEST')); print(m['specs'][$i]['status'])")

  IDEATION="$REPO_ROOT/specs/$SLUG/01-ideation.md"

  if [ ! -f "$IDEATION" ]; then
    echo "  SKIP: $SLUG (no 01-ideation.md)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Check if already has normalized frontmatter (has number: field)
  if head -10 "$IDEATION" | grep "^number:" >/dev/null; then
    echo "  SKIP: $SLUG (already normalized)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Check current frontmatter state
  FIRST_LINE=$(head -1 "$IDEATION")

  if [ "$FIRST_LINE" = "---" ]; then
    # Has YAML frontmatter — replace it with normalized version
    # Find the closing --- line number
    CLOSE_LINE=$(awk 'NR>1 && /^---$/{print NR; exit}' "$IDEATION")
    if [ -z "$CLOSE_LINE" ]; then
      echo "  ERROR: $SLUG (malformed frontmatter — no closing ---)"
      ERRORS=$((ERRORS + 1))
      continue
    fi

    # Extract any roadmapId from existing frontmatter
    ROADMAP_ID=$(sed -n "2,${CLOSE_LINE}p" "$IDEATION" | grep "^roadmapId:" | sed 's/roadmapId: *//' || true)

    # Build new frontmatter
    NEW_FM="---\nslug: $SLUG\nnumber: $NUMBER\ncreated: $CREATED\nstatus: $STATUS"
    if [ -n "$ROADMAP_ID" ]; then
      NEW_FM="$NEW_FM\nroadmapId: $ROADMAP_ID"
    fi
    NEW_FM="$NEW_FM\n---"

    # Replace old frontmatter with new
    TAIL_START=$((CLOSE_LINE + 1))
    BODY=$(tail -n +"$TAIL_START" "$IDEATION")
    { printf '%b\n' "$NEW_FM"; printf '%s' "$BODY"; } > "$IDEATION"

  else
    # No YAML frontmatter — prepend normalized frontmatter
    BODY=$(cat "$IDEATION")
    { printf '%s\n' "---"; printf 'slug: %s\n' "$SLUG"; printf 'number: %d\n' "$NUMBER"; printf 'created: %s\n' "$CREATED"; printf 'status: %s\n' "$STATUS"; printf '%s\n\n' "---"; printf '%s' "$BODY"; } > "$IDEATION"
  fi

  echo "  OK: $SLUG (#$NUMBER, $CREATED)"
  UPDATED=$((UPDATED + 1))
done

echo ""
echo "=== Migration Complete ==="
echo "  Updated: $UPDATED"
echo "  Skipped: $SKIPPED"
echo "  Errors:  $ERRORS"
