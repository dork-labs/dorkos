#!/usr/bin/env bash
# PostToolUse hook: remind to extract ADRs when a spec is finalized.
# Fires on Write tool — checks if file_path matches specs/*/02-specification.md.
# Non-blocking: always exits 0.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

# Check if the written file is a spec specification document
if echo "$FILE_PATH" | grep -qE 'specs/([^/]+)/02-specification\.md$'; then
  SLUG=$(echo "$FILE_PATH" | sed -E 's|.*specs/([^/]+)/02-specification\.md$|\1|')
  echo "[ADR Extraction] Spec '$SLUG' was written — consider running /adr:from-spec $SLUG to extract Architecture Decision Records."
fi

exit 0
