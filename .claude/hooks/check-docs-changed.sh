#!/bin/bash
# check-docs-changed.sh
# Stop hook that reminds about potentially affected developer guides
# Based on files changed during the session

set -e

# Colors for output
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get the project root (where this script is run from)
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
INDEX_FILE="$PROJECT_ROOT/contributing/INDEX.md"

# Check if INDEX.md exists — this is the lynchpin for doc drift detection
if [ ! -f "$INDEX_FILE" ]; then
  echo "ERROR: contributing/INDEX.md is missing. This file is required for documentation drift detection." >&2
  echo "Create it with the Guide Coverage Map and Maintenance Tracking tables." >&2
  exit 2  # Exit 2 = block session end, Claude auto-fixes
fi

# Get files changed since the session started
# We use git diff to find uncommitted changes plus recent commits from today
CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null || echo "")
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || echo "")
ALL_CHANGED="$CHANGED_FILES"$'\n'"$STAGED_FILES"

# Remove empty lines and duplicates
ALL_CHANGED=$(echo "$ALL_CHANGED" | grep -v '^$' | sort -u)

# If no changes, exit silently
if [ -z "$ALL_CHANGED" ]; then
  exit 0
fi

# Source-path -> docs mapping.
#
# The mapping lives in ONE place: contributing/INDEX.md (the Guide Coverage Map
# and External Docs Coverage tables), generated into the machine-readable
# .claude/scripts/docs-coverage-map.json. This hook no longer re-encodes those
# patterns; it shells out to the shared helper so the three former copies
# (INDEX.md, this hook, .claude/commands/docs/reconcile.md) can never drift.
#
# Source of truth: contributing/INDEX.md Guide Coverage Map. Do not re-add inline
# mappings here; edit INDEX.md and run: node .claude/scripts/docs-coverage-map.mjs --regen
MAP_HELPER="$PROJECT_ROOT/.claude/scripts/docs-coverage-map.mjs"

declare -a AFFECTED_GUIDES
declare -a AFFECTED_DOCS

if command -v node >/dev/null 2>&1 && [ -f "$MAP_HELPER" ]; then
  # Helper prints "GUIDE:contributing/<name>" and "DOC:<docs/path>" lines.
  MATCH_OUTPUT=$(printf '%s\n' "$ALL_CHANGED" | node "$MAP_HELPER" --match 2>/dev/null || echo "")
  while IFS= read -r line; do
    case "$line" in
      GUIDE:contributing/*) AFFECTED_GUIDES+=("${line#GUIDE:contributing/}") ;;
      DOC:*) AFFECTED_DOCS+=("${line#DOC:}") ;;
    esac
  done <<< "$MATCH_OUTPUT"
fi

# If any guides or docs are affected, show reminder
if [ ${#AFFECTED_GUIDES[@]} -gt 0 ] || [ ${#AFFECTED_DOCS[@]} -gt 0 ]; then
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}📚 Documentation Reminder${NC}"
  echo ""
  if [ ${#AFFECTED_GUIDES[@]} -gt 0 ]; then
    echo "   Contributing guides potentially affected:"
    for guide in "${AFFECTED_GUIDES[@]}"; do
      echo "   • contributing/$guide"
    done
  fi
  if [ ${#AFFECTED_DOCS[@]} -gt 0 ]; then
    if [ ${#AFFECTED_GUIDES[@]} -gt 0 ]; then echo ""; fi
    echo "   External docs potentially affected:"
    for doc in "${AFFECTED_DOCS[@]}"; do
      echo "   • $doc"
    done
  fi
  echo ""
  echo "   Consider running: /docs:reconcile"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
fi

exit 0
