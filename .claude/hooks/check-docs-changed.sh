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
INDEX_FILE="$PROJECT_ROOT/guides/INDEX.md"

# Check if INDEX.md exists
if [ ! -f "$INDEX_FILE" ]; then
  exit 0  # Silently exit if no index file
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

# Pattern mappings (simplified from INDEX.md)
# NOTE: These patterns are duplicated from guides/INDEX.md for performance.
# If INDEX.md patterns change significantly, update these mappings to match.
# Format: "guide:pattern1|pattern2|pattern3"
MAPPINGS=(
  "01-project-structure.md:apps/server|apps/client|apps/obsidian-plugin|packages/shared|packages/test-utils"
  "02-environment-variables.md:env.ts|\.env|config.ts"
  "03-database-prisma.md:prisma|services/.*\.ts|lib/prisma|generated/prisma"
  "04-forms-validation.md:form|schema|model/types"
  "05-data-fetching.md:apps/server/src/routes|apps/client/src/hooks|query-client"
  "06-state-management.md:store|hooks/"
  "07-animations.md:animation|motion"
  "08-styling-theming.md:globals.css|packages/shared|components/ui|tailwind"
)

# Track affected guides
declare -a AFFECTED_GUIDES

# Check each changed file against patterns
while IFS= read -r file; do
  [ -z "$file" ] && continue

  for mapping in "${MAPPINGS[@]}"; do
    guide="${mapping%%:*}"
    patterns="${mapping#*:}"

    # Check if file matches any pattern
    for pattern in $(echo "$patterns" | tr '|' ' '); do
      if echo "$file" | grep -qE "$pattern"; then
        # Add guide if not already in list
        if [[ ! " ${AFFECTED_GUIDES[*]} " =~ " ${guide} " ]]; then
          AFFECTED_GUIDES+=("$guide")
        fi
        break  # Move to next mapping
      fi
    done
  done
done <<< "$ALL_CHANGED"

# If any guides are affected, show reminder
if [ ${#AFFECTED_GUIDES[@]} -gt 0 ]; then
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}📚 Documentation Reminder${NC}"
  echo ""
  echo "   Changes during this session touched areas covered by:"
  for guide in "${AFFECTED_GUIDES[@]}"; do
    echo "   • $guide"
  done
  echo ""
  echo "   Consider running: /docs:reconcile"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
fi

exit 0
