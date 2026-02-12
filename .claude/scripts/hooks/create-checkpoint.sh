#!/usr/bin/env bash
# Creates git stash checkpoint on stop

# Read config
CONFIG_FILE=".claude/hooks-config.json"
PREFIX="claude"
MAX_CHECKPOINTS=10

if [ -f "$CONFIG_FILE" ]; then
  PREFIX=$(node -e "const c=require('./$CONFIG_FILE'); console.log(c['create-checkpoint']?.prefix || 'claude')" 2>/dev/null || echo "claude")
  MAX_CHECKPOINTS=$(node -e "const c=require('./$CONFIG_FILE'); console.log(c['create-checkpoint']?.maxCheckpoints || 10)" 2>/dev/null || echo "10")
fi

# Check for changes
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  exit 0  # No changes, exit silently
fi

# Create checkpoint
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MESSAGE="${PREFIX}-checkpoint: Auto-save at ${TIMESTAMP}"

# Add all files and create stash
git add -A
STASH_SHA=$(git stash create "$MESSAGE")

if [ -n "$STASH_SHA" ]; then
  git stash store -m "$MESSAGE" "$STASH_SHA"
  git reset  # Unstage files

  # Clean up old checkpoints
  CHECKPOINT_COUNT=$(git stash list | grep -c "${PREFIX}-checkpoint" || echo "0")
  if [ "$CHECKPOINT_COUNT" -gt "$MAX_CHECKPOINTS" ]; then
    # Drop oldest checkpoints
    git stash list | grep "${PREFIX}-checkpoint" | tail -n +$((MAX_CHECKPOINTS + 1)) | while read -r line; do
      INDEX=$(echo "$line" | grep -o 'stash@{[0-9]*}')
      git stash drop "$INDEX" 2>/dev/null
    done
  fi
fi

exit 0
