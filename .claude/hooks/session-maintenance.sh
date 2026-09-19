#!/bin/bash
# session-maintenance.sh
# The ONE SessionStart hook. Replaces check-adr-curation.sh, check-adr-review.sh,
# check-adr-drift.sh, check-docs-staleness.sh, and check-research-curation.sh.
#
# Contract: <500ms total, at most 5 lines, prints NOTHING when everything is
# healthy. One line per finding, prefixed "[Harness]". Always exits 0.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$REPO_ROOT" ] || exit 0

# --- (a) ADR manifest drift (orphans, collisions, missing files) ------------
# adr-drift-check.mjs is silent when clean; condense any report to one line.
DRIFT_SCRIPT="$REPO_ROOT/.claude/scripts/adr-drift-check.mjs"
if [ -f "$DRIFT_SCRIPT" ]; then
  DRIFT=$(node "$DRIFT_SCRIPT" 2>/dev/null | head -1)
  if [ -n "$DRIFT" ]; then
    echo "[Harness] ${DRIFT#\[ADR Drift\] }"
  fi
fi

# --- (b) Proposed-ADR backlog ------------------------------------------------
MANIFEST="$REPO_ROOT/decisions/manifest.json"
if [ -f "$MANIFEST" ]; then
  PROPOSED=$(node -e "console.log((require('$MANIFEST').decisions||[]).filter(d=>d.status==='proposed').length)" 2>/dev/null || echo 0)
  if [ "$PROPOSED" -ge 10 ] 2>/dev/null; then
    echo "[Harness] $PROPOSED proposed ADRs await /adr:review"
  fi
fi

# --- (b2) Accepted-ADR verification age ---------------------------------------
# `lastVerified` is stamped per manifest entry by /adr:audit; a missing field
# counts as never verified. Threshold 25 keeps this quiet under a normal
# quarterly audit cadence and loud when a backlog accumulates.
if [ -f "$MANIFEST" ]; then
  UNVERIFIED=$(node -e "const c=Date.now()-120*86400000;console.log((require('$MANIFEST').decisions||[]).filter(d=>d.status==='accepted'&&(!d.lastVerified||Date.parse(d.lastVerified)<c)).length)" 2>/dev/null || echo 0)
  if [ "$UNVERIFIED" -ge 25 ] 2>/dev/null; then
    echo "[Harness] $UNVERIFIED accepted ADRs unverified in 120+ days — run /adr:audit"
  fi
fi

# --- (c) Docs staleness -------------------------------------------------------
# Nag only when the review marker is >21 days old AND commits since then touch
# areas mapped to a tracked guide/doc (via the shared coverage map). Committed
# churn only — this must stay cheap.
DOCS_MARKER="$REPO_ROOT/docs/.last-reviewed"
COVERAGE_MAP="$REPO_ROOT/.claude/scripts/docs-coverage-map.mjs"
if [ -f "$DOCS_MARKER" ] && [ -f "$COVERAGE_MAP" ]; then
  LAST_TS=$(head -1 "$DOCS_MARKER" 2>/dev/null)
  LAST_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null || echo "")
  if [ -n "$LAST_EPOCH" ] && [ $(($(date +%s) - LAST_EPOCH)) -gt 1814400 ]; then
    HITS=$(git -C "$REPO_ROOT" log --since="$LAST_TS" --name-only --pretty=format: 2>/dev/null |
      sort -u | node "$COVERAGE_MAP" --match 2>/dev/null | grep -c . || true)
    if [ "${HITS:-0}" -gt 0 ] 2>/dev/null; then
      echo "[Harness] docs review >21d old with changes in $HITS tracked area(s) — run /docs:status"
    fi
  fi
fi

# --- (d) Unclassified research ------------------------------------------------
# One grep -L pass over research/*.md (no per-file spawns). README.md and
# plan.md are meta files that /research:curate skips.
RESEARCH_DIR="$REPO_ROOT/research"
if [ -d "$RESEARCH_DIR" ]; then
  UNCLASSIFIED=$(grep -L '^status:' "$RESEARCH_DIR"/*.md 2>/dev/null |
    grep -cv -e '/README\.md$' -e '/plan\.md$' || true)
  if [ "${UNCLASSIFIED:-0}" -gt 10 ] 2>/dev/null; then
    echo "[Harness] $UNCLASSIFIED research files lack status: frontmatter — run /research:curate"
  fi
fi

# --- (e) CI Steward dead-man's switch ------------------------------------------
# One line when the daily collector's newest snapshot on origin/ci-steward-data
# is over 2 days old, its health failed, a data-branch safeguard is missing, a
# local SLO is breached, or this clone's last hook run was killed
# (plans/ci-steward-plan.md §4.4). Reads git objects only, never the network.
# Node does not even start until the data branch exists here (one rev-parse),
# and it runs behind a hard 0.4 s timeout: a slow start under load is silence,
# never a slow SessionStart.
CI_LINE_SCRIPT="$REPO_ROOT/packages/ci-steward/bin/session-line.mjs"
CI_DATA_BRANCH=$(sed -n 's/^data_branch:[[:space:]]*//p' "$REPO_ROOT/ci/config.yaml" 2>/dev/null)
if [ -f "$CI_LINE_SCRIPT" ] && [ -n "$CI_DATA_BRANCH" ] &&
  git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/remotes/origin/$CI_DATA_BRANCH" >/dev/null 2>&1; then
  CI_LINE=$(
    node "$CI_LINE_SCRIPT" 2>/dev/null &
    CI_PID=$!
    (sleep 0.4 && kill "$CI_PID" 2>/dev/null) >/dev/null 2>&1 &
    CI_WATCH=$!
    wait "$CI_PID" 2>/dev/null
    kill "$CI_WATCH" 2>/dev/null
  )
  [ -n "$CI_LINE" ] && printf '%s\n' "$CI_LINE" | head -1
fi

exit 0
