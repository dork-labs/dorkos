#!/usr/bin/env bash
# Generate a URL-safe slug from a title string (pure bash, no server needed).
#
# Usage: slugify.sh <title>
# Example: slugify.sh "My Cool Feature!" -> my-cool-feature
set -euo pipefail

# Argument validation
if [ $# -lt 1 ]; then
  echo "Usage: $0 <title>"
  exit 1
fi

TITLE="$*"

# Convert to lowercase
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]')
# Replace spaces and underscores with hyphens
SLUG=$(echo "$SLUG" | sed 's/[[:space:]_]/-/g')
# Remove non-alphanumeric characters (except hyphens)
SLUG=$(echo "$SLUG" | sed 's/[^a-z0-9-]//g')
# Collapse multiple consecutive hyphens
SLUG=$(echo "$SLUG" | sed 's/-\{2,\}/-/g')
# Remove leading/trailing hyphens
SLUG=$(echo "$SLUG" | sed 's/^-//;s/-$//')

echo "$SLUG"
