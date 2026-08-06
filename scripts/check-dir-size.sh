#!/usr/bin/env bash
# Check that no source directory has too many files (cognitive load guard).
# Thresholds:  WARN >= 15,  ERROR >= 25
#
# Two tiers, on purpose (DOR-930):
#   GROWTH (blocking)  — dirs this commit is ADDING a source file to (via
#     `git diff --cached --diff-filter=ACR`: adds, copies, renames all land a
#     file at a destination dir, which is the moment worth stopping). This is
#     the only tier that can fail the commit — growing an already-large
#     directory is the one action the author can act on right now.
#   CENSUS (informational) — every tracked source dir, whether or not this
#     commit touches it. A directory can drift over the limit through years
#     of modify-only commits, since nothing ever adds a file there again, and
#     the growth tier would never see it: session/model sat at 27 files (over
#     the 25 ERROR limit) with nothing flagging it, because nothing had added
#     a file there since it crossed the line. The census surfaces that debt
#     on every commit without blocking unrelated work. It never exits
#     non-zero, and to stay quiet on unrelated commits it only speaks at/over
#     ERROR_THRESHOLD, not the lower WARN_THRESHOLD.

set -euo pipefail

WARN_THRESHOLD=15
ERROR_THRESHOLD=25

# Skip __tests__ dirs, build output, and directories that are flat by design.
# Shared between both tiers so a dir's classification never depends on which
# tier is asking.
#   */shared/ui, */components/ui — shadcn primitives (one file per component)
#   dev/showcases — playground showcase files
#   server/routes — Express routes, one-per-resource convention
#   cli/src/commands — CLI subcommand handlers, one-per-command convention
#   shared/lib — independent utility modules
#   shared/lib/transport — one method-factory per domain, all composed by
#     http-transport.ts's declaration merging (flat by design, like shared/lib)
#   packages/*/src — package source roots
#   marketing/ui — independent page section components
is_excluded_dir() {
  local dir=$1
  [[ "$dir" == *"__tests__"* ]] && return 0
  [[ "$dir" == *"node_modules"* || "$dir" == *"/dist" || "$dir" == *"/dist/"* || "$dir" == *".next"* ]] && return 0
  [[ "$dir" == *"/shared/ui" || "$dir" == *"/components/ui" || "$dir" == *"dev/showcases" ]] && return 0
  [[ "$dir" == *"server/src/routes" || "$dir" == *"/shared/lib" ]] && return 0
  [[ "$dir" == *"/shared/lib/transport" ]] && return 0
  [[ "$dir" == *"cli/src/commands" ]] && return 0
  [[ "$dir" == *"packages/"*"/src" || "$dir" == *"marketing/ui" ]] && return 0
  return 1
}

has_error=0
has_warning=0

# ---- Tier 1: GROWTH (blocking) ----
# Unique dirs the commit added/copied/renamed a source file into.
growth_dirs=$(git diff --cached --name-only --diff-filter=ACR \
  | grep -E '\.(ts|tsx|js|jsx|css)$' \
  | xargs -I{} dirname {} \
  | sort -u || true)

for dir in $growth_dirs; do
  is_excluded_dir "$dir" && continue

  # Count source files (not directories, not tests) directly in the dir.
  count=$(find "$dir" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.css' \) 2>/dev/null | wc -l | tr -d ' ')

  if [ "$count" -ge "$ERROR_THRESHOLD" ]; then
    echo "ERROR: $dir has $count source files (max $ERROR_THRESHOLD)"
    has_error=1
  elif [ "$count" -ge "$WARN_THRESHOLD" ]; then
    echo "WARN:  $dir has $count source files (consider splitting at $WARN_THRESHOLD)"
    has_warning=1
  fi
done

# ---- Tier 2: CENSUS (informational, repo-wide) ----
# `git ls-files` is already gitignore-aware, tracked-only, and reads the
# index (so a newly staged add counts too) — no `find` walk needed. One sed
# pass turns each path into its containing dir (the `t`/fallback pair mimics
# `dirname`: strip the trailing "/basename"; if nothing was stripped — a
# root-level file — replace the whole line with "."), and one `sort | uniq -c`
# counts them. That is a single fork per pass, not one per file, which is
# what keeps a repo-wide census cheap enough to run on every commit.
# (The three `-e` flags, rather than one `;`-joined expression, are for BSD
# sed on macOS: its `t` command reads everything up to the next `-e`/newline
# as a label, so a `;`-joined `t; s#.*#.#` is parsed as one broken label
# instead of two commands. Separate `-e`s parse identically on GNU and BSD.)
census_counts=$(git ls-files -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.css' \
  | sed -E -e 's#/[^/]*$##' -e 't' -e 's#.*#.#' \
  | sort | uniq -c || true)

if [ -n "$census_counts" ]; then
  while read -r count dir; do
    [ -z "${dir:-}" ] && continue
    [ "$count" -ge "$ERROR_THRESHOLD" ] || continue
    is_excluded_dir "$dir" && continue
    # Already covered by the growth tier above (ERROR/WARN or just under it) —
    # a second, differently-worded line about the same dir is noise.
    printf '%s\n' "$growth_dirs" | grep -qxF "$dir" && continue
    echo "WARN:  $dir has $count source files (over $ERROR_THRESHOLD; not touched by this commit)"
  done <<<"$census_counts"
fi

if [ "$has_error" -eq 1 ]; then
  echo ""
  echo "Directories above $ERROR_THRESHOLD files need to be split into subdirectories."
  echo "See: contributing/project-structure.md"
  exit 1
fi

if [ "$has_warning" -eq 1 ]; then
  echo ""
  echo "(warnings are informational — commit proceeds)"
fi

exit 0
