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

# Pattern mappings (simplified from INDEX.md)
# NOTE: These patterns are duplicated from contributing/INDEX.md for performance.
# If INDEX.md patterns change significantly, update these mappings to match.
# Format: "guide:pattern1|pattern2|pattern3"
MAPPINGS=(
  "project-structure.md:apps/client/src/layers/|apps/server/src/|packages/"
  "architecture.md:transport.ts|direct-transport|http-transport|apps/obsidian-plugin/build-plugins"
  "design-system.md:apps/client/src/index.css|apps/client/src/layers/shared/ui/"
  "api-reference.md:openapi-registry|apps/server/src/routes/|packages/shared/src/schemas"
  "configuration.md:config-manager|config-schema|packages/cli/"
  "interactive-tools.md:interactive-handlers|apps/client/src/layers/features/chat/"
  "keyboard-shortcuts.md:use-interactive-shortcuts"
  "obsidian-plugin-development.md:apps/obsidian-plugin/"
  "data-fetching.md:apps/server/src/routes/|apps/client/src/layers/entities/|apps/client/src/layers/features/chat/"
  "state-management.md:app-store|apps/client/src/layers/entities/|apps/client/src/layers/shared/model/"
  "animations.md:animation|motion|apps/client/src/index.css"
  "styling-theming.md:index.css|apps/client/src/layers/shared/ui/|tailwind"
  "parallel-execution.md:.claude/agents/|\.claude/commands/"
  "autonomous-roadmap-execution.md:.claude/commands/roadmap/"
)

# External docs (MDX) mappings
# Format: "docs-path:pattern1|pattern2"
DOCS_MAPPINGS=(
  "docs/getting-started/configuration.mdx:config-manager|config-schema|packages/cli/"
  "docs/integrations/sse-protocol.mdx:apps/server/src/routes/sessions|stream-adapter|session-broadcaster"
  "docs/integrations/building-integrations.mdx:transport.ts|direct-transport|http-transport"
  "docs/self-hosting/deployment.mdx:packages/cli/|config-manager"
  "docs/self-hosting/reverse-proxy.mdx:apps/server/src/routes/sessions|stream-adapter"
  "docs/contributing/architecture.mdx:apps/server/src/services/|transport.ts|apps/obsidian-plugin/"
  "docs/contributing/testing.mdx:packages/test-utils/|vitest"
  "docs/contributing/development-setup.mdx:package.json|turbo.json|apps/"
  "docs/guides/cli-usage.mdx:packages/cli/"
  "docs/guides/tunnel-setup.mdx:tunnel-manager"
  "docs/guides/slash-commands.mdx:command-registry|.claude/commands/"
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

# Track affected external docs
declare -a AFFECTED_DOCS

# Check each changed file against docs patterns
while IFS= read -r file; do
  [ -z "$file" ] && continue

  for mapping in "${DOCS_MAPPINGS[@]}"; do
    doc="${mapping%%:*}"
    patterns="${mapping#*:}"

    for pattern in $(echo "$patterns" | tr '|' ' '); do
      if echo "$file" | grep -qE "$pattern"; then
        if [[ ! " ${AFFECTED_DOCS[*]} " =~ " ${doc} " ]]; then
          AFFECTED_DOCS+=("$doc")
        fi
        break
      fi
    done
  done
done <<< "$ALL_CHANGED"

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
