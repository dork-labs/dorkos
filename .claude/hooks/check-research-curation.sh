#!/bin/bash
# Check if research curation is due (>30d since last curate) AND there is genuine
# uncurated activity: new research files added since the marker, or files missing
# the `status:` frontmatter. Advisory only: prints a nag and always exits 0.
# Mirrors check-adr-curation.sh.
set -euo pipefail

# Resolve repo root; bail quietly if we are not in a git repo.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi

LAST_FILE="$REPO_ROOT/research/.last-curated"
RESEARCH_DIR="$REPO_ROOT/research"

# 30 days in seconds (research churns slower than docs).
THRESHOLD=2592000

# No research dir -> nothing to curate.
if [ ! -d "$RESEARCH_DIR" ]; then
  exit 0
fi

# --- Guard A: marker age -------------------------------------------------------
# Mirror the ADR hooks: a missing or empty marker counts as "due". The second
# guard (real uncurated activity) keeps a missing marker quiet when the library
# is already clean.
NEEDS_CURATION=false
SINCE_DATE=""
if [ ! -f "$LAST_FILE" ]; then
  NEEDS_CURATION=true
else
  LAST_TS=$(cat "$LAST_FILE" 2>/dev/null || echo "")
  if [ -z "$LAST_TS" ]; then
    NEEDS_CURATION=true
  else
    LAST_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null || echo "")
    if [ -z "$LAST_EPOCH" ]; then
      exit 0
    fi
    NOW_EPOCH=$(date +%s)
    DIFF=$(( NOW_EPOCH - LAST_EPOCH ))
    if [ "$DIFF" -gt "$THRESHOLD" ]; then
      NEEDS_CURATION=true
    fi
    SINCE_DATE="$LAST_TS"
  fi
fi

# Age threshold not met -> stay silent.
if [ "$NEEDS_CURATION" != "true" ]; then
  exit 0
fi

# --- Guard B: genuine uncurated activity --------------------------------------
# Two cheap signals, either one is sufficient:
#   1) research/*.md files added since the marker date (new, likely unclassified)
#   2) research/*.md files missing `status:` frontmatter (definitely unclassified)

# Signal 1: files added under research/ since the marker date (git is cheap here).
NEW_COUNT=0
if [ -n "$SINCE_DATE" ]; then
  NEW_FILES=$(git -C "$REPO_ROOT" log --since="$SINCE_DATE" --diff-filter=A --name-only --pretty=format: -- 'research/*.md' 2>/dev/null | sort -u | grep -v '^$' || echo "")
  if [ -n "$NEW_FILES" ]; then
    NEW_COUNT=$(printf '%s\n' "$NEW_FILES" | grep -c . || echo "0")
  fi
fi

# Signal 2: files lacking `status:` frontmatter. README.md and plan.md are meta
# files that /research:curate explicitly skips, so exclude them here too.
MISSING_STATUS=0
for f in "$RESEARCH_DIR"/*.md; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  if [ "$base" = "README.md" ] || [ "$base" = "plan.md" ]; then
    continue
  fi
  if ! grep -qE "^status:" "$f" 2>/dev/null; then
    MISSING_STATUS=$(( MISSING_STATUS + 1 ))
  fi
done

# Neither signal fired -> the library is current -> stay silent.
if [ "$NEW_COUNT" -eq 0 ] && [ "$MISSING_STATUS" -eq 0 ]; then
  exit 0
fi

echo "[Research Curation Due] $NEW_COUNT new + $MISSING_STATUS unclassified research file(s) since the last curation: run /research:curate"
exit 0
