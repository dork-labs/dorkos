#!/bin/bash
# SessionStart hook: flag on-disk ADR manifest drift (orphan files, slug
# collisions, manifest entries with no file) that the manifest-only curation
# check (check-adr-curation.sh) and /adr:curate cannot see.
#
# Background: /adr:from-spec writes decisions/NNNN-*.md files and manifest
# entries; when numbers were later reassigned, orphan files accumulated unseen
# (18 archived on 2026-06-13). This catches recurrence at session start.
#
# Non-blocking: always exits 0.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SCRIPT="$REPO_ROOT/.claude/scripts/adr-drift-check.mjs"

[ -f "$SCRIPT" ] || exit 0
node "$SCRIPT" 2>/dev/null || true
