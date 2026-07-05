#!/bin/bash
# spec-status-sync.sh
# PostToolUse (Write) hook for spec artifacts:
#   1. Auto-updates spec status in specs/manifest.json (via spec-manifest-ops.ts)
#   2. Reminds to extract ADRs when a spec is finalized without any (02-specification.md)
#   3. Reminds to review proposed ADRs when a spec is implemented (04-implementation.md)
#
# Reminders are emitted as PostToolUse JSON on stdout — the ONLY way hook output
# reaches the model on exit 0 (plain stdout is discarded):
#   {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}

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
ADR_MANIFEST="$PROJECT_ROOT/decisions/manifest.json"

# Collected reminder lines, emitted once as additionalContext at the end
CONTEXT=""
append_context() {
  if [[ -n "$CONTEXT" ]]; then
    CONTEXT="$CONTEXT"$'\n'"$1"
  else
    CONTEXT="$1"
  fi
}

# --- 1. Status sync -------------------------------------------------------
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
  append_context "$OUTPUT"
fi

# --- 2. ADR extraction reminder (spec finalized, no ADRs extracted) --------
if [[ "$FILE_PATH" =~ specs/[^/]+/02-specification\.md$ ]] && [[ -f "$ADR_MANIFEST" ]]; then
  LINKED_COUNT=$(node -e "
    const m = require('$ADR_MANIFEST');
    console.log((m.decisions || []).filter(d => d.specSlug === '$SLUG').length);
  " 2>/dev/null || echo "")
  if [[ "$LINKED_COUNT" == "0" ]]; then
    append_context "[ADR Extraction] Spec '$SLUG' is specified but has no extracted ADRs — run /adr:from-spec $SLUG."
  fi
fi

# --- 3. ADR review reminder (spec implemented, proposed ADRs pending) ------
if [[ "$FILE_PATH" =~ specs/[^/]+/04-implementation\.md$ ]] && [[ -f "$ADR_MANIFEST" ]]; then
  PROPOSED_COUNT=$(node -e "
    const m = require('$ADR_MANIFEST');
    console.log((m.decisions || []).filter(d => d.status === 'proposed' && d.specSlug === '$SLUG').length);
  " 2>/dev/null || echo "0")
  if [[ "$PROPOSED_COUNT" =~ ^[0-9]+$ ]] && [[ "$PROPOSED_COUNT" -gt 0 ]]; then
    append_context "[ADR Review] Spec '$SLUG' is now implemented with $PROPOSED_COUNT proposed ADR(s) — run /adr:review $SLUG to accept them."
  fi
fi

# --- Emit ------------------------------------------------------------------
if [[ -n "$CONTEXT" ]]; then
  CONTEXT="$CONTEXT" node -e '
    const ctx = process.env.CONTEXT;
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx },
    }));
  '
fi

exit 0
