#!/usr/bin/env bash
# Update workflowState for a roadmap item via the Express API.
#
# Usage: update_workflow_state.sh <item-id> <json>
# The JSON argument is the workflowState object (or partial update).
#
# Examples:
#   update_workflow_state.sh abc-123 '{"phase": "implementing"}'
#   update_workflow_state.sh abc-123 '{"phase": "testing", "tasksCompleted": 5}'
set -euo pipefail

API="${ROADMAP_API:-http://localhost:4243/api/roadmap}"

# Health check
if ! curl -sf "${API%/roadmap}/health" > /dev/null 2>&1; then
  echo "Error: Roadmap server is not running. Start it with: npm run dev --filter=@dorkos/roadmap" >&2
  exit 1
fi

# Argument validation
if [ $# -ne 2 ]; then
  echo "Usage: $0 <item-id> <workflow-state-json>"
  echo ""
  echo "Examples:"
  echo "  $0 abc-123 '{\"phase\": \"implementing\"}'"
  echo "  $0 abc-123 '{\"phase\": \"testing\", \"tasksCompleted\": 5}'"
  exit 1
fi

ITEM_ID="$1"
WORKFLOW_JSON="$2"

# Validate that the argument is valid JSON
if ! echo "$WORKFLOW_JSON" | jq empty 2>/dev/null; then
  echo "Error: Second argument must be valid JSON" >&2
  exit 1
fi

# Build the PATCH body with workflowState wrapper
BODY=$(jq -n --argjson ws "$WORKFLOW_JSON" '{ workflowState: $ws }')

# PATCH the item
if ! RESPONSE=$(curl -sf -X PATCH "$API/items/$ITEM_ID" \
  -H "Content-Type: application/json" \
  -d "$BODY"); then
  echo "Error: Failed to update item '$ITEM_ID'" >&2
  exit 1
fi

echo "$RESPONSE" | jq '.workflowState'
