#!/bin/bash
# Check if docs review is due (>21d since last review) AND doc-relevant code churned since then.
# Advisory only: prints a nag and always exits 0. Mirrors check-adr-curation.sh.
set -euo pipefail

# Resolve repo root; bail quietly if we are not in a git repo.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi

LAST_FILE="$REPO_ROOT/docs/.last-reviewed"
COVERAGE_MAP="$REPO_ROOT/.claude/scripts/docs-coverage-map.mjs"

# 21 days in seconds.
THRESHOLD=1814400

# --- Guard A: marker age -------------------------------------------------------
# Mirror the ADR hooks: a missing or empty marker counts as "due". The second
# guard (real doc-relevant churn) is what actually keeps a missing marker quiet.
NEEDS_REVIEW=false
SINCE_DATE=""
if [ ! -f "$LAST_FILE" ]; then
  NEEDS_REVIEW=true
else
  LAST_TS=$(cat "$LAST_FILE" 2>/dev/null || echo "")
  if [ -z "$LAST_TS" ]; then
    NEEDS_REVIEW=true
  else
    # macOS-compatible epoch parse; unparseable timestamp -> fail safe to silence.
    LAST_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null || echo "")
    if [ -z "$LAST_EPOCH" ]; then
      exit 0
    fi
    NOW_EPOCH=$(date +%s)
    DIFF=$(( NOW_EPOCH - LAST_EPOCH ))
    if [ "$DIFF" -gt "$THRESHOLD" ]; then
      NEEDS_REVIEW=true
    fi
    # Pass the marker date to `git log --since` so guard B only sees new churn.
    SINCE_DATE="$LAST_TS"
  fi
fi

# Age threshold not met -> stay silent.
if [ "$NEEDS_REVIEW" != "true" ]; then
  exit 0
fi

# --- Guard B: genuine doc-relevant activity since the marker -------------------
# We only nag if code that maps to a tracked guide or doc actually changed.
# Without the coverage-map helper we cannot evaluate this guard, so fail safe
# toward silence rather than nag on a timer alone.
if [ ! -f "$COVERAGE_MAP" ]; then
  exit 0
fi

# Collect candidate changed files: committed since the marker date (when known)
# plus anything currently uncommitted. Keep this cheap: two git calls, no scan.
if [ -n "$SINCE_DATE" ]; then
  COMMITTED=$(git -C "$REPO_ROOT" log --since="$SINCE_DATE" --name-only --pretty=format: 2>/dev/null || echo "")
else
  # No usable marker date: look only at the most recent commit to stay cheap and
  # avoid nagging on the entire history.
  COMMITTED=$(git -C "$REPO_ROOT" show --name-only --pretty=format: HEAD 2>/dev/null || echo "")
fi
UNCOMMITTED=$(git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null || echo "")

CHANGED=$(printf '%s\n%s\n' "$COMMITTED" "$UNCOMMITTED" | sort -u | grep -v '^$' || echo "")

# No changed files at all -> nothing to nag about.
if [ -z "$CHANGED" ]; then
  exit 0
fi

# Ask the coverage map which guides/docs these files touch.
HITS=$(printf '%s\n' "$CHANGED" | node "$COVERAGE_MAP" --match 2>/dev/null || echo "")

# No mapped guide/doc -> the churn was not doc-relevant -> stay silent.
if [ -z "$HITS" ]; then
  exit 0
fi

HIT_COUNT=$(printf '%s\n' "$HITS" | grep -c . || echo "0")

echo "[Docs Review Due] doc-relevant changes touch $HIT_COUNT tracked guide/doc area(s) since the last review: run /docs:status (then /docs:reconcile if it flags drift)"
exit 0
