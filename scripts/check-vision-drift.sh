#!/usr/bin/env bash
# Report positioning drift that no hard gate can catch.
#
# WHY THIS EXISTS. scripts/check-banned-words.sh and scripts/check-vocab-gate.ts
# FAIL the build on words that are wrong everywhere ("mission control", the
# retired category lines, equal-accounts claims). Most drift is softer than
# that: "open source" is fine in a license section and wrong in a headline;
# "local first" is fine in an architecture guide and wrong on the site; a
# north-star file can fall behind what shipped. A gate that fired on those would
# cry wolf, so this script only REPORTS. It prints candidate lines for a reader,
# person or agent, to judge against meta/VOICE.md, and always exits 0.
#
# It is the deterministic half of the `vision-drift-check` scheduled skill
# (.agents/skills/vision-drift-check/SKILL.md), which runs it and then judges
# each hit. Nothing in CI runs it.
#
#   bash scripts/check-vision-drift.sh
#   ROOT=/path/to/checkout bash scripts/check-vision-drift.sh

set -uo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 0

total=0

# section TITLE PATTERN PATHSPEC...
# Prints every tracked line matching PATTERN (Perl regex, case-insensitive:
# git grep -E has no \b on macOS, so -P it is)
# in PATHSPEC, skipping lines that carry the `vocab-allow` marker and, when
# SKIP is set, lines matching that extended regex too.
section() {
  local title="$1" pattern="$2"
  shift 2
  local hits
  hits="$(git grep -nIiP "$pattern" -- "$@" 2>/dev/null | grep -v 'vocab-allow' | grep -viE "${SKIP:-^\$}" || true)"
  local n=0
  [ -n "$hits" ] && n="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
  total=$((total + n))
  printf '\n## %s (%s)\n' "$title" "$n"
  [ "$n" -gt 0 ] && printf '%s\n' "$hits" | cut -c1-220
}

# Headline copy: the hero, page titles, descriptions, the README opening and
# npm descriptions (meta/VOICE.md, "Headline rules"). Body copy may say these.
HEADLINE_RE='on your (own )?computer|runs on your computer|open[- ]source'
headline_hits=""
for f in README.md packages/cli/README.md; do
  [ -f "$f" ] || continue
  h="$(head -n 20 "$f" | grep -nIiE "$HEADLINE_RE" | grep -v 'vocab-allow' | sed "s|^|$f:|" || true)"
  [ -n "$h" ] && headline_hits+="$h"$'\n'
done
desc="$(git grep -nIiE "\"description\": \".*($HEADLINE_RE)" -- 'package.json' 'packages/*/package.json' 'apps/*/package.json' 2>/dev/null || true)"
[ -n "$desc" ] && headline_hits+="$desc"$'\n'
meta="$(git grep -nIiE "(title|description|headline|eyebrow|lede)[\"']?[:=].*($HEADLINE_RE)" -- 'apps/site/src/app/*.tsx' 'apps/site/src/app/**/*.tsx' 'apps/site/src/app/**/*.ts' 'apps/site/src/config/site.ts' 'apps/site/src/layers/features/marketing/**' 2>/dev/null | grep -v '__tests__' || true)"
[ -n "$meta" ] && headline_hits+="$meta"$'\n'
n=0
[ -n "$headline_hits" ] && n="$(printf '%s' "$headline_hits" | grep -c .)"
total=$((total + n))
printf '## Headline copy that says "your computer" or "open source" (%s)\n' "$n"
[ "$n" -gt 0 ] && printf '%s' "$headline_hits" | cut -c1-220

PUBLIC=(
  'README.md' 'packages/cli/README.md' 'docs/*.mdx' 'docs/**/*.mdx' 'blog/*.mdx' 'blog/**/*.mdx'
  'apps/client/src/**/*.tsx' ':!apps/client/src/dev/**'
  'apps/site/src/layers/features/marketing/**' 'apps/site/src/app/(marketing)/**'
  'packages/operating-skills/src/**/*.ts'
  ':!**/__tests__/**' ':!docs/changelog.mdx' ':!docs/changelog-archive.mdx'
  ':!apps/site/src/app/(marketing)/test/**'
)

# An object key or id spelled local-first is an identifier, not prose.
SKIP="['\"]local-first['\"] *[:,]" section '"Local first" in public prose (say "ownership" or "yours")' 'local[- ]first' "${PUBLIC[@]}"
section 'Our agents called assistants (say co-workers or teammates)' 'ai assistants?\b|your assistants?\b' "${PUBLIC[@]}"
section 'Equal-accounts hints (peers, no human required, run the place)' '\b(agents?|people|humans) (are |as )?(equal )?peers\b|no human (is )?required|run the (place|company|space)|agents can be admins|equal accounts?|same account as you|agents (are )?equal to (humans|people)' "${PUBLIC[@]}"
# Comparison pages describe rivals; the story surfaces are what lead.
STORY=('README.md' 'packages/cli/README.md' 'docs/index.mdx' 'docs/getting-started/what-is-dorkos.mdx' 'apps/site/src/app/(marketing)/_components/**' ':!**/__tests__/**')
section 'Runtimes "side by side" as a lead' '(claude code|codex|opencode).*side[- ]by[- ]side|side[- ]by[- ]side.*(claude code|codex|opencode)' "${STORY[@]}"
section '"Generative UI" as a value word' 'generative ui' "${PUBLIC[@]}"
section 'The retired hero "Ask for a tool"' 'ask for a tool\. your agents build it' 'apps/site/src/app/**' 'apps/site/src/layers/features/marketing/lib/**' 'README.md' 'docs/index.mdx'
section 'Discord as our community' 'discord\.(gg|com/invite)|(our|join the|join our|dorkos) discord|discord (server|community)' "${PUBLIC[@]}"
section 'Unbuilt features described as working (check against meta/ROADMAP.md)' 'audit trail|full power|health check|access levels?|equal accounts|community space|publish(ing)? pages|live shared docs|its own computer' "${STORY[@]}" 'apps/site/src/layers/features/marketing/lib/features.ts'

# meta/ layout: only the canon belongs at the top level, and INDEX.md lists it.
printf '\n## meta/ files missing from meta/INDEX.md\n'
missing=0
for f in meta/*.md; do
  b="$(basename "$f")"
  [ "$b" = "INDEX.md" ] && continue
  if ! grep -qF "$b" meta/INDEX.md; then
    echo "$f"
    missing=$((missing + 1))
  fi
done
total=$((total + missing))

section 'Links to retired or moved positioning files' 'positioning-202610|(^|[^/])meta/positioning-202607|\]\((\.\./)*positioning-2026' 'AGENTS.md' '.claude/**' '.agents/**' 'contributing/**' 'docs/**' 'meta/*.md' 'scripts/**' ':!scripts/check-vision-drift.sh' ':!meta/archive/**'

printf '\n## North-star tickets to check against Linear\n'
grep -oE 'DOR-[0-9]+' meta/ROADMAP.md 2>/dev/null | sort -u | tr '\n' ' '
printf '\n\ncheck-vision-drift: %s candidate line(s). Judge each against meta/VOICE.md and meta/ROADMAP.md.\n' "$total"
exit 0
