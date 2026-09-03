#!/usr/bin/env bash
# Fixture suite for scripts/check-dead-doc-paths.sh (DOR-1762).
#
# Every case builds a throwaway tree under a temp dir and points the guard at
# it with ROOT, so the suite never depends on this checkout's real doc content
# — it keeps passing after someone edits a guide, and it fails for the one
# reason it should: the guard stopped behaving.
#
#   bash scripts/test-check-dead-doc-paths.sh
#   CHECK=/path/to/other.sh bash scripts/test-check-dead-doc-paths.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/check-dead-doc-paths.sh}"

pass=0
fail=0

# $1 name, $2 expected exit code, $3 relative file path, $4 file contents
run_case() {
  local name="$1" want="$2" path="$3" body="$4"
  local tmp
  tmp=$(mktemp -d)
  mkdir -p "$tmp/$(dirname "$path")"
  printf '%s\n' "$body" >"$tmp/$path"

  local out got
  out=$(ROOT="$tmp" bash "$CHECK" 2>&1)
  got=$?

  if [ "$got" -eq "$want" ]; then
    pass=$((pass + 1))
    printf 'ok   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    printf 'FAIL %s — wanted exit %s, got %s\n%s\n' "$name" "$want" "$got" "$out"
  fi
  rm -rf "$tmp"
}

echo "== the guard must go RED on a live dead path =="

run_case 'contributing guide imports the dead components alias' 1 \
  'contributing/styling-theming.md' \
  "import { Button as BaseButton } from '@/components/ui/button';"

# shellcheck disable=SC2016
run_case 'a rules doc names the dead alias' 1 \
  '.claude/rules/components.md' \
  'See `@/components/ui/dialog` for the pattern.'

# shellcheck disable=SC2016
run_case 'a doc names the dead path with no @ alias' 1 \
  'contributing/design-system.md' \
  'Shows as a centered `Dialog` on desktop and a `Drawer` on mobile. See `components/ui/responsive-dialog.tsx`.'

echo ""
echo "== the guard must stay GREEN on everything we deliberately kept =="

run_case 'a marked worked example is allowed' 0 \
  'contributing/styling-theming.md' \
  "// don't: \`@/components/ui/button\` (doc-allow-dead-path: intentional anti-example)"

run_case 'the real shared/ui path is untouched' 0 \
  'contributing/styling-theming.md' \
  "import { Button } from '@/layers/shared/ui';"

run_case 'a doc outside the scanned dirs is not scanned' 0 \
  'decisions/260101-000000-something.md' \
  "import { Button } from '@/components/ui/button';"

# shellcheck disable=SC2016
run_case 'the site alias is live, not dead — a line naming apps/site is scoped out' 0 \
  'contributing/styling-theming.md' \
  "In \`apps/site\`, \`@/components/ui/button\` is the real shadcn primitive."

# shellcheck disable=SC2016
run_case 'a bare mention of the site path is scoped out too' 0 \
  'contributing/styling-theming.md' \
  'The site keeps its shadcn primitives at `apps/site/src/components/ui/`.'

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
