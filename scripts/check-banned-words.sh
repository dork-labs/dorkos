#!/usr/bin/env bash
# Fail when a retired word reappears in user-facing PROSE.
#
# WHY THIS EXISTS. DOR-1517 swept "mission control" and "cockpit" out of every
# surface a user can read, after the operator retired both words for good (the
# category phrase is now "one place" — meta/website-copy/decisions.md,
# Decision 18). A sweep with no guard rots: the next person to write a README
# paragraph or a release post has no idea those two words were spent, and the
# repo carries ~2,000 legitimate internal uses of "cockpit" in comments and
# identifiers for them to copy the habit from.
#
# WHY IT IS A SECOND GATE, NOT A REPLACEMENT. scripts/check-vocab-gate.ts
# already guards this vocabulary inside app source, and DOR-1517 extended it
# with wave-2 for exactly these two words. That gate parses TypeScript and only
# flags positions that actually reach a screen, which is the right tool there
# and the reason it can run over files where "cockpit" is also a variable name,
# a media key and a hundred comments. It deliberately does not read prose:
# its own header says docs/ is "prose, not a render path". So the split is:
#
#   check-vocab-gate.ts  →  render-path strings in apps/{client,site,server}/src
#   this script          →  prose and data files an AST walk cannot see
#
# Neither one covers the other's ground, and a word landing in either place
# fails CI. Do not "simplify" this into a repo-wide grep: grep cannot tell the
# identifier `ProductSurface.cockpit` from the sentence "open the cockpit", and
# a gate that cries wolf on code is a gate everyone learns to skip.
#
# WHAT IT SCANS. Only files whose entire content is prose or user-visible data,
# listed in SCAN_TARGETS below. Adding a surface means adding a glob there.
#
# WHAT IS DELIBERATELY EXEMPT (see ALLOW_PATTERNS):
#   - docs/changelog.mdx and docs/changelog-archive.mdx are COMPILED from
#     CHANGELOG.md, which AGENTS.md forbids editing by hand. They record what
#     was said at the time and keep their historical wording.
#   - The media key `cockpit`, in both the forms prose files spell it:
#     `cockpit-light.png` (the generated file) and `<ProductShot id="cockpit">`
#     (the registry key that resolves it). It keys the live
#     apps/site/public/product/manifest.json and every archived per-version
#     manifest back to v0.46.0; renaming it orphans that media, and no visitor
#     ever reads a word of it. The registry entry is apps/e2e/capture/shots.ts,
#     where the same decision is recorded in a comment.
#   - GitHub ships a product literally named "Mission Control", so a genuine
#     reference to it is allowed. Mark such a line with `vocab-allow` in a
#     comment or HTML comment on the same line, with a reason.
#
#   bash scripts/check-banned-words.sh
#   ROOT=/path/to/checkout bash scripts/check-banned-words.sh
#
# Pinned by scripts/test-check-banned-words.sh, which proves it goes red on a
# seeded violation and stays green on each exemption above.

set -uo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Whole-word, case-insensitive. "cockpit" must not fire inside a longer word,
# matching how check-vocab-gate.ts matches its own terms.
BANNED_RE='mission control|cockpit'

# Prose and user-visible data only — never source files. See the header.
SCAN_TARGETS=(
  'README.md'
  'context7.json'
  'packages/cli/README.md'
  'apps/client/public/manifest.webmanifest'
  'docs/api/openapi.json'
)
SCAN_GLOB_DIRS=(
  'docs:mdx'
  'blog:mdx'
)

# A line matching any of these is exempt. Keep each one justified in the header.
ALLOW_PATTERNS=(
  'cockpit-light\.png'  # generated media filename; renaming orphans archived manifests
  'id="cockpit"'        # the same media key, as a ProductShot registry reference
  'vocab-allow'         # explicit inline marker, e.g. GitHub's real product name
)

# Compiled from the frozen CHANGELOG.md — historical record, never rewritten.
EXEMPT_FILES=(
  'docs/changelog.mdx'
  'docs/changelog-archive.mdx'
)

is_exempt_file() {
  local f="$1"
  for e in "${EXEMPT_FILES[@]}"; do
    [ "$f" = "$e" ] && return 0
  done
  return 1
}

is_allowed_line() {
  local line="$1"
  for p in "${ALLOW_PATTERNS[@]}"; do
    if printf '%s' "$line" | grep -Eq "$p"; then return 0; fi
  done
  return 1
}

# Collect the file list.
files=()
for t in "${SCAN_TARGETS[@]}"; do
  [ -f "$ROOT/$t" ] && files+=("$t")
done
for spec in "${SCAN_GLOB_DIRS[@]}"; do
  dir="${spec%%:*}"
  ext="${spec##*:}"
  [ -d "$ROOT/$dir" ] || continue
  while IFS= read -r f; do
    files+=("${f#"$ROOT"/}")
  done < <(find "$ROOT/$dir" -type f -name "*.${ext}" | sort)
done

violations=0
for f in "${files[@]}"; do
  is_exempt_file "$f" && continue
  [ -f "$ROOT/$f" ] || continue
  while IFS= read -r hit; do
    lineno="${hit%%:*}"
    text="${hit#*:}"
    is_allowed_line "$text" && continue
    if [ "$violations" -eq 0 ]; then
      echo "check-banned-words: retired vocabulary found in user-facing prose:" >&2
      echo "" >&2
    fi
    violations=$((violations + 1))
    printf '  %s:%s\n    %s\n' "$f" "$lineno" "$(printf '%s' "$text" | sed 's/^[[:space:]]*//' | cut -c1-140)" >&2
  done < <(grep -nEi "$BANNED_RE" "$ROOT/$f" 2>/dev/null || true)
done

if [ "$violations" -gt 0 ]; then
  {
    echo ""
    echo "The words \"mission control\" and \"cockpit\" are retired (DOR-1517)."
    echo "The category phrase is \"one place\": \"All your agents. One place.\""
    echo "Write \"the DorkOS app\", \"the app\", \"one place\" or \"one window\" instead."
    echo "See meta/brand-foundation.md section 10 for the rule and its two carve-outs."
    echo ""
    echo "If this is a genuine reference to GitHub's product named \"Mission Control\","
    echo "add 'vocab-allow' plus a reason in a comment on the same line."
  } >&2
  exit 1
fi

echo "check-banned-words: clean — 0 hits across ${#files[@]} prose file(s)."
