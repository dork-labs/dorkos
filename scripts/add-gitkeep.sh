#!/bin/bash
# Script to add .gitkeep files to empty directories
# This ensures empty directories are tracked by git

set -e

# Get the project root (parent of scripts directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Scanning for empty directories in: $PROJECT_ROOT"

# Counter for tracking
count=0

# Find all empty directories, excluding:
# - .git directory
# - node_modules
# - .next build directory
# - .logs directory
while IFS= read -r -d '' dir; do
  # Check if directory is truly empty (no files, no .gitkeep)
  if [ -z "$(ls -A "$dir")" ]; then
    echo "Adding .gitkeep to: ${dir#$PROJECT_ROOT/}"
    touch "$dir/.gitkeep"
    ((count++))
  fi
done < <(find "$PROJECT_ROOT" -type d -empty \
  -not -path "*/.git/*" \
  -not -path "*/node_modules/*" \
  -not -path "*/.next/*" \
  -not -path "*/.logs/*" \
  -print0)

if [ $count -eq 0 ]; then
  echo "No empty directories found."
else
  echo ""
  echo "Done! Added .gitkeep to $count empty director(y/ies)."
fi
