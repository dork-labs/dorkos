#!/usr/bin/env bash
# Fail when a ground-truth doc teaches an import path or file path that no
# longer exists in the codebase.
#
# WHY THIS EXISTS (DOR-1762). contributing/styling-theming.md once taught
# `import { Button as BaseButton } from '@/components/ui/button'` as the
# canonical way to extend a shadcn primitive — but `apps/client/src/components/`
# has not existed since the FSD migration; the real path is
# `apps/client/src/layers/shared/ui/`. An agent copying that line writes an
# import that fails both `tsc` and the FSD lint rule, having done exactly what
# the ground-truth doc told it to. This guard makes sure the specific dead
# alias that caused that regression can't quietly return, and gives the next
# stale path an obvious place to be added.
#
# WHAT IT SCANS. Prose only — the ground-truth docs contributors and agents
# read before touching a primitive — never source, which has its own compiler
# and lint gate for real import correctness. Listed in SCAN_TARGETS below.
#
# WHAT IS DELIBERATELY EXEMPT. A doc that wants to SHOW the dead pattern as a
# worked "don't do this" example (the way styling-theming.md itself used to)
# may still do so — mark that line with `doc-allow-dead-path` in a comment on
# the same line.
#
# WHY TWO NEEDLES. The regression the guard was built for shipped in two
# spellings: the aliased `@/components/ui/...` import AND the bare
# `components/ui/....tsx` file reference (design-system.md once pointed at
# `components/ui/responsive-dialog.tsx`, which hasn't existed since the FSD
# migration either). Both are dead under `apps/client`.
#
# APP-SCOPED, ON PURPOSE. `@/components/` and `components/ui/` are dead in
# `apps/client` but genuinely live in `apps/site` (`apps/site/src/components/ui/`,
# declared by `apps/site/components.json`). SCAN_TARGETS below only reaches
# docs that today describe the client, so this hasn't collided yet — but a
# needle this generic would misfire the moment a doc legitimately names the
# site's own path. A line that also mentions `apps/site` is read as
# documenting the site's real path, not the client's dead one, and is skipped.
#
#   bash scripts/check-dead-doc-paths.sh
#   ROOT=/path/to/checkout bash scripts/check-dead-doc-paths.sh
#
# Pinned by scripts/test-check-dead-doc-paths.sh, which proves it goes red on a
# seeded violation and stays green on the exemption above.

set -uo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Each entry is a literal string that must never appear, unmarked, in a
# ground-truth doc. Add the next dead path here rather than writing a new
# script.
DEAD_PATHS=(
  '@/components/'
  'components/ui/'
)

# A line naming the site's own real component dir (`apps/site/src/components/ui/`)
# is not the dead client path — see APP-SCOPED, ON PURPOSE above.
SITE_SCOPE_MARKER='apps/site'

SCAN_TARGETS_GLOB_DIRS=(
  'contributing:md'
  '.claude/rules:md'
)

ALLOW_MARKER='doc-allow-dead-path'

violations=0
files=()
for spec in "${SCAN_TARGETS_GLOB_DIRS[@]}"; do
  dir="${spec%%:*}"
  ext="${spec##*:}"
  [ -d "$ROOT/$dir" ] || continue
  while IFS= read -r f; do
    files+=("${f#"$ROOT"/}")
  done < <(find "$ROOT/$dir" -type f -name "*.${ext}" | sort)
done

for f in ${files[@]+"${files[@]}"}; do
  [ -f "$ROOT/$f" ] || continue
  for needle in "${DEAD_PATHS[@]}"; do
    while IFS= read -r hit; do
      lineno="${hit%%:*}"
      text="${hit#*:}"
      printf '%s' "$text" | grep -Fq "$ALLOW_MARKER" && continue
      printf '%s' "$text" | grep -Fq "$SITE_SCOPE_MARKER" && continue
      if [ "$violations" -eq 0 ]; then
        echo "check-dead-doc-paths: a dead path found in ground-truth docs:" >&2
        echo "" >&2
      fi
      violations=$((violations + 1))
      printf '  %s:%s\n    %s\n' "$f" "$lineno" "$(printf '%s' "$text" | sed 's/^[[:space:]]*//' | cut -c1-140)" >&2
    done < <(grep -nF "$needle" "$ROOT/$f" 2>/dev/null || true)
  done
done

if [ "$violations" -gt 0 ]; then
  {
    echo ""
    echo "A ground-truth doc names a path that does not exist in the codebase (DOR-1762)."
    echo "Fix the path, or if this is a deliberate worked 'don't do this' example, mark"
    echo "the line with '$ALLOW_MARKER' plus a short reason."
  } >&2
  exit 1
fi

echo "check-dead-doc-paths: clean — 0 hits across ${#files[@]} doc file(s)."
