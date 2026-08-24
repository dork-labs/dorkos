#!/usr/bin/env bash
# Fixture suite for scripts/check-banned-words.sh, the DOR-1517 prose guard.
#
# It exists because a guard nobody has watched fail is not known to work. The
# sweep it protects (DOR-1517 retired "mission control" and "cockpit" from
# every surface a user can read) left ~2,000 legitimate internal uses of
# "cockpit" behind in comments and identifiers, so the interesting question is
# not "does it find the word" but "does it find the word ONLY where the word is
# prose, and stay quiet on all four things we deliberately kept".
#
# Every case builds a throwaway tree under a temp dir and points the guard at
# it with ROOT, so the suite never depends on this checkout's real content —
# it keeps passing after someone edits a README, and it fails for the one
# reason it should: the guard stopped behaving.
#
#   bash scripts/test-check-banned-words.sh
#   CHECK=/path/to/other.sh bash scripts/test-check-banned-words.sh
#
# CHECK exists so a candidate rewrite can be run against the same fixtures.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/check-banned-words.sh}"

pass=0
fail=0

# Build a throwaway tree, run the guard against it, assert on the exit code.
#   $1 human-readable case name
#   $2 expected exit code (0 green, 1 red)
#   $3 relative file path to create
#   $4 file contents
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

echo "== the guard must go RED on real prose violations =="

# The regression this whole gate exists to prevent: someone writes the retired
# word into a README paragraph, having never read the decision.
run_case 'README says "cockpit"' 1 'README.md' \
  'DorkOS is the cockpit for every agent you run.'

# Same word, different surface. Each SCAN_TARGETS entry is a separate chance to
# regress, so the two highest-traffic ones are pinned independently.
run_case 'context7.json says "mission control"' 1 'context7.json' \
  '{ "description": "Mission control for every agent you run." }'

run_case 'a blog post says "cockpit"' 1 'blog/dorkos-1-0-0.mdx' \
  'The cockpit got faster this release.'

run_case 'a docs page says "mission control"' 1 'docs/guides/x.mdx' \
  'Open mission control to see every session.'

# Case-insensitivity is load-bearing: headings capitalize, prose does not.
run_case 'capitalized "Cockpit" still fails' 1 'docs/guides/y.mdx' \
  '## The Cockpit'

# The PWA manifest is user-visible data rather than prose, and is the surface
# most likely to be forgotten in a copy sweep.
run_case 'the PWA manifest says "cockpit"' 1 'apps/client/public/manifest.webmanifest' \
  '{ "description": "All your agents. One cockpit." }'

# packages/shared schema descriptions reach docs/api/openapi.json without ever
# passing through the AST gate, which only reads apps/*/src. That gap is why
# this file is scanned.
run_case 'generated openapi.json says "cockpit"' 1 'docs/api/openapi.json' \
  '{ "description": "so a cockpit never needs this route" }'

echo ""
echo "== the guard must stay GREEN on everything we deliberately kept =="

# Carve-out 1: the compiled changelog is generated from CHANGELOG.md, which
# AGENTS.md forbids editing. It keeps its historical wording.
run_case 'compiled changelog keeps its history' 0 'docs/changelog.mdx' \
  '- Three cockpit papercuts, one per surface.'

run_case 'archived changelog keeps its history' 0 'docs/changelog-archive.mdx' \
  '- The cockpit got simpler and faster.'

# Carve-out 2: GitHub ships a product literally named "Mission Control".
# Competitive copy may name it, marked with the inline marker.
run_case "GitHub's real product name is allowed when marked" 0 'docs/guides/compare.mdx' \
  'What is GitHub Mission Control? <!-- vocab-allow: GitHub ships a product by that name -->'

# Carve-out 3: the media key, in both forms a prose file spells it. Renaming it
# would orphan the archived per-version manifests.
run_case 'generated media filename is allowed' 0 'blog/dorkos-0-58-0.mdx' \
  '![The DorkOS app](/product/archive/v0.58.0/cockpit-light.png)'

run_case 'ProductShot registry key is allowed' 0 'docs/index.mdx' \
  '  id="cockpit"'

# The point of the whole design: prose files only. A word inside code is not a
# violation here (check-vocab-gate.ts judges app source with a real parser),
# and a guard that fired on identifiers would be one everyone learns to skip.
run_case 'clean prose passes' 0 'README.md' \
  'DorkOS is one place for every AI agent you run.'

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
