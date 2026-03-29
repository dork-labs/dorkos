#!/bin/bash
# spec-status-sync.sh
# PostToolUse hook: auto-updates spec status in manifest.json when spec artifacts are written
# Delegates to spec-manifest-ops.ts for manifest reads/writes and progression checks

# Read the file_path from the Write tool's input (nested under tool_input)
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.tool_input?.file_path || '')")

# Only act on spec artifact files (01-ideation.md through 05-feedback.md)
if [[ ! "$FILE_PATH" =~ specs/[^/]+/0[1-5]-.*\.md$ ]]; then
  exit 0
fi

# Extract the slug from the path
SLUG=$(echo "$FILE_PATH" | sed -n 's|.*specs/\([^/]*\)/0[1-5]-.*\.md|\1|p')
if [[ -z "$SLUG" ]]; then
  exit 0
fi

# Get the project root
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SPEC_DIR="$PROJECT_ROOT/specs/$SLUG"

# Determine the highest artifact number in the spec directory
HIGHEST=0
for f in "$SPEC_DIR"/0[1-5]-*.md; do
  if [[ -f "$f" ]]; then
    NUM=$(basename "$f" | sed 's/^0\([1-5]\)-.*/\1/')
    if [[ "$NUM" -gt "$HIGHEST" ]]; then
      HIGHEST=$NUM
    fi
  fi
done

if [[ "$HIGHEST" -eq 0 ]]; then
  exit 0
fi

# Map artifact number to status
case $HIGHEST in
  1) NEW_STATUS="ideation" ;;
  2) NEW_STATUS="specified" ;;
  3) NEW_STATUS="specified" ;;
  4) NEW_STATUS="implemented" ;;
  5) NEW_STATUS="implemented" ;;
  *) exit 0 ;;
esac

# Delegate to spec-manifest-ops.ts for status update
# The script handles: reading current status, progression checks, no-op if unchanged, writing manifest
OUTPUT=$(node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$PROJECT_ROOT/.claude/scripts/spec-manifest-ops.ts" \
  update-status "$SLUG" "$NEW_STATUS" --quiet 2>&1) || true

if [[ -n "$OUTPUT" ]]; then
  echo "$OUTPUT"
fi

exit 0
