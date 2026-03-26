#!/bin/bash
# spec-status-sync.sh
# PostToolUse hook: auto-updates spec status in manifest.json when spec artifacts are written
# Maps artifact numbers to statuses and updates manifest if status should progress

# Read the file_path from the Write tool's input (nested under tool_input)
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

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
MANIFEST="$PROJECT_ROOT/specs/manifest.json"
SPEC_DIR="$PROJECT_ROOT/specs/$SLUG"

if [[ ! -f "$MANIFEST" ]]; then
  exit 0
fi

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

# Status progression order (lower index = earlier stage)
STATUS_ORDER="ideation specified implemented"

# Get current status from manifest
CURRENT_STATUS=$(python3 -c "
import json, sys
with open('$MANIFEST') as f:
    manifest = json.load(f)
for spec in manifest.get('specs', []):
    if spec.get('slug') == '$SLUG':
        print(spec.get('status', ''))
        sys.exit(0)
print('')
" 2>/dev/null || echo "")

if [[ -z "$CURRENT_STATUS" ]]; then
  exit 0
fi

# Check if new status is a progression (not a regression)
get_order() {
  local s="$1"
  local i=0
  for status in $STATUS_ORDER; do
    if [[ "$status" == "$s" ]]; then
      echo $i
      return
    fi
    i=$((i + 1))
  done
  echo -1
}

CURRENT_ORDER=$(get_order "$CURRENT_STATUS")
NEW_ORDER=$(get_order "$NEW_STATUS")

if [[ "$NEW_ORDER" -le "$CURRENT_ORDER" ]]; then
  exit 0
fi

# Update the manifest
python3 -c "
import json
with open('$MANIFEST') as f:
    manifest = json.load(f)
for spec in manifest.get('specs', []):
    if spec.get('slug') == '$SLUG':
        spec['status'] = '$NEW_STATUS'
        break
with open('$MANIFEST', 'w') as f:
    json.dump(manifest, f, indent=2)
    f.write('\n')
" 2>/dev/null || true

if [[ $? -eq 0 ]]; then
  echo "[Spec Status] Updated $SLUG status to $NEW_STATUS"
fi

exit 0
