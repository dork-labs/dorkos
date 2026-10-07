#!/usr/bin/env bash
# Fail when a retired word reappears in user-facing PROSE.
#
# WHY THIS EXISTS. DOR-1517 swept "mission control" and "cockpit" out of every
# surface a user can read, after the operator retired both words for good (the
# category phrase became "one place" then; since 2026-10 it is "a workspace
# for people and agents", meta/VOICE.md). A sweep with no guard rots: the
# next person to write a README paragraph or a release post has no idea those
# two words were spent, and the repo carries ~2,000 legitimate internal uses of
# "cockpit" in comments and identifiers for them to copy the habit from.
#
# A SECOND WORD GROUP: THE 2026-10 POSITIONING LINES (DOR-2736). The vision
# reset of 2026-10-06/07 (meta/VISION.md, meta/VOICE.md) retired more
# than words. Three lines a writer reaches for out of habit, and one link, must
# never reach public prose again:
#
#   - "operating system for AI agents", in any spelling ("operating system for
#     agents", "for autonomous AI agents", "for AI coding agents", "OS for AI
#     agents"). It was the category line; DorkOS is now "a workspace for people
#     and agents". The product name DorkOS stays.
#   - "one place for every agent" / "one place for every AI agent", the 2026-08
#     category line the reset replaced.
#   - Equal-accounts claims: "equal to humans", "equal to people", "equal
#     accounts", "agents equal". An internal design principle (ADR
#     261006-235239); public copy never states it.
#   - Discord invite links (discord.gg/..., discord.com/invite/...). There is
#     no DorkOS Discord; the community is the DorkOS Community Space. The bare
#     word "Discord" stays legal: it is a real app people connect, and the
#     relay adapter type is literally "discord".
#
# The group has its own failure message, pointing at meta/VOICE.md, the single
# list of words DorkOS uses and never uses. It reaches two surfaces wave 2 does
# not, each narrowed to what is reliable there:
#
#   - package.json manifests (root, apps/*, packages/*): the "description" is
#     what npm and GitHub show. Positioning phrases only, never wave 2: the
#     root manifest names a `cockpit` script, which is code, not copy.
#   - App and package source (apps/*/src, packages/*/src): Discord invite links
#     only. A link sits in an `href`, which check-vocab-gate.ts does not read as
#     copy, and an invite URL is never an identifier, so a plain grep cannot
#     cry wolf here. Tests, dist and node_modules are skipped.
#
# What is NOT gated, because a grep cannot judge it: "on your computer" and
# "open source" are fine in body copy and wrong only as a headline.
#
# WHY IT IS A SECOND GATE, NOT A REPLACEMENT. scripts/check-vocab-gate.ts
# already guards this vocabulary inside app source, and DOR-1517 extended it
# with wave-2 for exactly these two words. That gate parses TypeScript and only
# flags positions that actually reach a screen, which is the right tool there
# and the reason it can run over files where "cockpit" is also a variable name,
# a media key and a hundred comments. It deliberately does not read most prose
# this way — grep is simpler and good enough for a plain substring ban. So the
# split is:
#
#   check-vocab-gate.ts  →  render-path strings in apps/{client,site,server}/src,
#                            PLUS docs/**/*.mdx prose (DOR-2508, wave 4 only —
#                            see that script's own header)
#   this script          →  everything else: README/AGENTS.md/CONTRIBUTING.md,
#                            docs/ and blog/ prose for wave 2 AND wave 6 (the
#                            positioning lines above), and data files an AST
#                            walk cannot see
#
# Wave 6 is in both gates, split the same way wave 2 is: check-vocab-gate.ts
# reads it in app render paths only and leaves it out of its docs scan, so a
# docs hit is reported once, here, with one fix to follow.
#
# Both now run in the `typecheck` workflow, one step apart (DOR-1814 moved the
# parser half there; before that it rode only its own pin suite, on a workflow
# path-filtered away from every copy-only PR).
#
# THIS SCRIPT'S WORD LIST IS NOT THE WHOLE VOCABULARY. It carries waves 2 and 6 only.
# The four nouns ADR 260804-021140 retired for "Connections" — integration,
# connector, adapter, provider (DOR-1814, wave 4) — are enforced by the parser
# half ALONE, deliberately: they are ordinary English with legitimate technical
# senses everywhere this script looks, and `check-vocab-gate.ts`'s docs scan
# (DOR-2508) needs the allowlist mechanism this whole-line grep does not have
# to tell `/docs/integrations/` (a legitimate shipped URL path) from a real
# violation. `docs/api/openapi.json` stays out of both gates: it is generated
# from route descriptions that name `provider` path parameters and `connectors`
# path segments, wire naming rather than authored prose either script should
# sweep. Every release note in the frozen changelog still says "integration"
# and neither gate touches it — see both scripts' own headers for why.
#
# Neither one covers the other's ground, and a word landing in either place
# fails CI. Do not "simplify" this into a repo-wide grep: grep cannot tell the
# identifier `ProductSurface.cockpit` from the sentence "open the cockpit", and
# a gate that cries wolf on code is a gate everyone learns to skip.
#
# WHAT IT SCANS. Only files whose entire content is prose or user-visible data,
# listed in SCAN_TARGETS below. Adding a surface means adding a glob there.
#
# One of those surfaces is TypeScript: packages/operating-skills (DOR-2068).
# Its skills are template-literal prose seeded into every agent's
# `.agents/skills/`, and an agent repeats what they say to the person it works
# for. check-vocab-gate.ts cannot judge them (it reads render positions in
# apps/*/src, and a skill body is none), so they are read here as prose, line by
# line, with the same case-insensitive substring match as every other target.
# That is safe only because the package is prose all the way down: its
# identifiers are skill names and it keeps no internal "cockpit" vocabulary.
# Its __tests__ are not scanned. Should a legitimate use ever appear, mark the
# line with `vocab-allow` rather than dropping the directory.
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
#   - meta/ is not scanned at all: the brand, positioning and voice files
#     quote every retired line to state the rule, and meta/archive/ and
#     its archive/ is a historical record. Neither are research/,
#     specs/, decisions/ or plans/, which are working notes, not public prose.
#   - AGENTS.md states the prohibition, so it has to quote both words to say
#     what they are (and, since 2026-10, the retired positioning lines too). It is scanned anyway — it loads into every agent session as
#     project instructions, which makes it the likeliest place for a retired
#     word to be copied back out of and into user-facing copy. Because matching
#     is line-scoped and AGENTS.md writes a paragraph per line, the rule lives
#     in a paragraph of its own so its marker exempts that prose and nothing
#     else in the file. Do not fold it back into a neighbouring paragraph.
#
#   bash scripts/check-banned-words.sh
#   ROOT=/path/to/checkout bash scripts/check-banned-words.sh
#
# Pinned by scripts/test-check-banned-words.sh, which proves it goes red on a
# seeded violation and stays green on each exemption above.

set -uo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Case-insensitive SUBSTRING match, not whole-word: "cockpit" also fires inside
# a longer word such as "cockpits" or "cockpitView". That is stricter than
# check-vocab-gate.ts, which matches whole words, and it is deliberate here:
# every scanned file is prose, so a longer word containing a retired one is
# almost always the retired word in another form.
BANNED_RE='mission control|cockpit'

# Wave 6, the 2026-10 positioning lines (see the header). POSITIONING_RE is the
# three retired lines; DISCORD_LINK_RE is the invite link, kept separate because
# it alone is safe to grep for in source. `([[:alnum:]-]+ ){0,3}` lets a line
# carry up to three qualifiers ("for autonomous AI coding agents") without the
# pattern growing a branch per spelling. The "OS for" branch needs a non-word
# character in front, written portably, so "DorkOS for agents" or "macOS for"
# never fires.
POSITIONING_RE='operating system for ([[:alnum:]-]+ ){0,3}agents?|(^|[^[:alnum:]])os for ([[:alnum:]-]+ ){0,3}agents?|one place for every ([[:alnum:]-]+ ){0,2}agents?|equal to (humans|people)|equal accounts?|agents (are )?equal'
DISCORD_LINK_RE='discord\.gg/|discord(app)?\.com/invite'

# Prose and user-visible data only — never source files. See the header.
SCAN_TARGETS=(
  'README.md'
  'CONTRIBUTING.md'
  'AGENTS.md'
  'context7.json'
  'packages/cli/README.md'
  'apps/client/public/manifest.webmanifest'
  'docs/api/openapi.json'
  'packages/operating-skills/src/tool-name-note.ts'
)
SCAN_GLOB_DIRS=(
  'docs:mdx'
  'blog:mdx'
  'packages/operating-skills/src/skills:ts'
)

# Published package manifests: positioning phrases and Discord links only.
MANIFEST_GLOBS=(
  'package.json'
  'apps/*/package.json'
  'packages/*/package.json'
)

# Source roots: Discord invite links only (see the header for why that is safe).
SOURCE_LINK_DIRS=(
  'apps'
  'packages'
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
hit_wave2=0
hit_positioning=0

# Report one hit, remembering which word group it belongs to so the failure
# message names the right fix.
#   $1 repo-relative path   $2 line number   $3 line text
report_hit() {
  local f="$1" lineno="$2" text="$3"
  if [ "$violations" -eq 0 ]; then
    echo "check-banned-words: retired vocabulary found in user-facing prose:" >&2
    echo "" >&2
  fi
  violations=$((violations + 1))
  if printf '%s' "$text" | grep -Eqi "$BANNED_RE"; then hit_wave2=1; fi
  if printf '%s' "$text" | grep -Eqi "$POSITIONING_RE|$DISCORD_LINK_RE"; then hit_positioning=1; fi
  printf '  %s:%s\n    %s\n' "$f" "$lineno" "$(printf '%s' "$text" | sed 's/^[[:space:]]*//' | cut -c1-140)" >&2
}

# Scan a list of repo-relative files against one regex.
#   $1 extended regex   $2.. repo-relative paths
scan_files() {
  local re="$1"
  shift
  local f hit hits
  for f in "$@"; do
    is_exempt_file "$f" && continue
    [ -f "$ROOT/$f" ] || continue
    # A command substitution, not `done < <(...)`: bash 3.2 (macOS) keeps
    # every process substitution opened inside a function alive until the
    # function returns, and a few hundred of them crash it outright.
    hits=$(grep -nEi "$re" "$ROOT/$f" 2>/dev/null || true)
    [ -n "$hits" ] || continue
    while IFS= read -r hit; do
      is_allowed_line "${hit#*:}" && continue
      report_hit "$f" "${hit%%:*}" "${hit#*:}"
    done <<<"$hits"
  done
}

# Prose: every word group. Every array expansion below is guarded by its
# length: bash 3.2 (macOS) treats "${empty[@]}" as unbound under `set -u`.
if [ "${#files[@]}" -gt 0 ]; then
  scan_files "$BANNED_RE|$POSITIONING_RE|$DISCORD_LINK_RE" "${files[@]}"
fi

# Manifests: positioning phrases and links, never wave 2 (see the header).
manifests=()
for g in "${MANIFEST_GLOBS[@]}"; do
  for m in "$ROOT"/$g; do
    [ -f "$m" ] && manifests+=("${m#"$ROOT"/}")
  done
done
if [ "${#manifests[@]}" -gt 0 ]; then
  scan_files "$POSITIONING_RE|$DISCORD_LINK_RE" "${manifests[@]}"
fi

# Source: Discord invite links only. One recursive grep, not a file loop.
source_dirs=()
for d in "${SOURCE_LINK_DIRS[@]}"; do
  [ -d "$ROOT/$d" ] && source_dirs+=("$ROOT/$d")
done
if [ "${#source_dirs[@]}" -gt 0 ]; then
  while IFS= read -r hit; do
    path="${hit%%:*}"
    rest="${hit#*:}"
    case "$path" in */src/*) ;; *) continue ;; esac
    is_allowed_line "${rest#*:}" && continue
    report_hit "${path#"$ROOT"/}" "${rest%%:*}" "${rest#*:}"
  done < <(grep -rnEiI "$DISCORD_LINK_RE" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
    --exclude='*.test.*' --exclude='*.spec.*' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
    --exclude-dir=__tests__ --exclude-dir=.turbo \
    "${source_dirs[@]}" 2>/dev/null || true)
fi

if [ "$violations" -gt 0 ]; then
  if [ "$hit_wave2" -eq 1 ]; then
    {
      echo ""
      echo "The words \"mission control\" and \"cockpit\" are retired (DOR-1517)."
      echo "The category phrase is \"a workspace for people and agents\"."
      echo "Write \"the DorkOS app\", \"the app\" or \"one window\" instead."
      echo "See meta/VOICE.md for the rule and its two carve-outs."
      echo ""
      echo "If this is a genuine reference to GitHub's product named \"Mission Control\","
      echo "add 'vocab-allow' plus a reason in a comment on the same line."
    } >&2
  fi
  if [ "$hit_positioning" -eq 1 ]; then
    {
      echo ""
      echo "A positioning line the 2026-10 vision reset retired is back (DOR-2736)."
      echo "DorkOS is \"a workspace for people and agents\". It is never an \"operating"
      echo "system for AI agents\" (in any form) or \"one place for every agent\"; public"
      echo "copy never says agents hold equal accounts or are equal to people; and there"
      echo "is no DorkOS Discord, so never link one. The word \"Discord\" alone is fine."
      echo "meta/VOICE.md is the single list of words DorkOS uses and never uses."
      echo ""
      echo "If a line quotes the phrase to state the rule, add 'vocab-allow' plus a"
      echo "reason in a comment on the same line."
    } >&2
  fi
  exit 1
fi

echo "check-banned-words: clean — 0 hits across ${#files[@]} prose file(s), ${#manifests[@]} manifest(s) and the app/package source."
