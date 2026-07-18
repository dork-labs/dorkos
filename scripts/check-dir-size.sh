#!/usr/bin/env bash
# Check that no source directory has too many files (cognitive load guard).
# Thresholds:  WARN >= 15,  ERROR >= 25
# Only checks directories that contain staged files.

set -euo pipefail

WARN_THRESHOLD=15
ERROR_THRESHOLD=25

# Collect unique directories of staged files (source code only)
dirs=$(git diff --cached --name-only --diff-filter=ACR \
  | grep -E '\.(ts|tsx|js|jsx|css)$' \
  | xargs -I{} dirname {} \
  | sort -u || true)

[ -z "$dirs" ] && exit 0

has_error=0
has_warning=0

for dir in $dirs; do
  # Skip __tests__ directories — test files naturally accumulate
  [[ "$dir" == *"__tests__"* ]] && continue
  # Skip build output, node_modules, .next
  [[ "$dir" == *"node_modules"* || "$dir" == *"/dist" || "$dir" == *"/dist/"* || "$dir" == *".next"* ]] && continue
  # Allowlist: directories that are flat by design
  #   */shared/ui, */components/ui — shadcn primitives (one file per component)
  #   dev/showcases — playground showcase files
  #   server/routes — Express routes, one-per-resource convention
  #   cli/src/commands — CLI subcommand handlers, one-per-command convention
  #   shared/lib — independent utility modules
  #   packages/*/src — package source roots
  #   marketing/ui — independent page section components
  [[ "$dir" == *"/shared/ui" || "$dir" == *"/components/ui" || "$dir" == *"dev/showcases" ]] && continue
  [[ "$dir" == *"server/src/routes" || "$dir" == *"/shared/lib" ]] && continue
  [[ "$dir" == *"cli/src/commands" ]] && continue
  [[ "$dir" == *"packages/"*"/src" || "$dir" == *"marketing/ui" ]] && continue

  # Count source files (not directories, not tests)
  count=$(find "$dir" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.css' \) 2>/dev/null | wc -l | tr -d ' ')

  if [ "$count" -ge "$ERROR_THRESHOLD" ]; then
    echo "ERROR: $dir has $count source files (max $ERROR_THRESHOLD)"
    has_error=1
  elif [ "$count" -ge "$WARN_THRESHOLD" ]; then
    echo "WARN:  $dir has $count source files (consider splitting at $WARN_THRESHOLD)"
    has_warning=1
  fi
done

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
