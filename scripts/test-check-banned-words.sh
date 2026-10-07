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
#   $5 optional: an allowlist.json body. The tree then also gets this
#      checkout's real banned-terms.json, which the guard reads to know which
#      entries name a wave-6 term.
#   $6 optional: text the guard's output must contain (a red case's fix hint)
run_case() {
  local name="$1" want="$2" path="$3" body="$4" allowlist="${5:-}" must_say="${6:-}"
  local tmp
  tmp=$(mktemp -d)
  mkdir -p "$tmp/$(dirname "$path")"
  printf '%s\n' "$body" >"$tmp/$path"
  if [ -n "$allowlist" ]; then
    mkdir -p "$tmp/scripts/vocab-gate"
    printf '%s\n' "$allowlist" >"$tmp/scripts/vocab-gate/allowlist.json"
    cp "$repo_root/scripts/vocab-gate/banned-terms.json" "$tmp/scripts/vocab-gate/"
  fi

  local out got
  out=$(ROOT="$tmp" bash "$CHECK" 2>&1)
  got=$?

  # A red case must be red BECAUSE of the seeded file: the guard has to name it.
  # Exit 1 alone proves nothing: a guard that dies on its own bug (an unbound
  # variable under `set -u`, a bash 3.2 quirk, as DOR-2068 hit on an empty file
  # list) also exits non-zero, and would pass every red case while checking
  # nothing.
  if [ "$want" -eq 1 ] && [ "$got" -eq 1 ] && ! printf '%s' "$out" | grep -qF "  $path:"; then
    got="1, without naming $path"
  fi
  if [ -n "$must_say" ] && ! printf '%s' "$out" | grep -qF "$must_say"; then
    got="$got, without saying \"$must_say\""
  fi

  if [ "$got" = "$want" ]; then
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

# AGENTS.md is scanned because it loads into every agent session as project
# instructions, which makes it the likeliest place for a retired word to be
# copied back out of and into user-facing copy. It also quotes both words to
# state the rule, so its own marker could mask a real regression here.
run_case 'AGENTS.md says "cockpit"' 1 'AGENTS.md' \
  'The cockpit is where you land.'

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

# The operating skills are TypeScript files, but everything they export is
# prose seeded into every agent's `.agents/skills/`, and the agent reads it back
# to the user in its own words. Neither gate read them until DOR-2068, and a
# "cockpit" sat in reading-activity.ts on main because of it.
run_case 'an operating skill says "cockpit"' 1 'packages/operating-skills/src/skills/reading-activity.ts' \
  '  its most recent session, newest first: the same map the cockpit uses for'

run_case 'the shared tool-name note says "mission control"' 1 'packages/operating-skills/src/tool-name-note.ts' \
  'export const TOOL_NAME_NOTE = `> Call it from mission control.`;'

echo ""
echo "== the 2026-10 positioning lines (DOR-2736) must go RED, one per family =="

# Family 1: the retired category line, in the spellings people actually wrote.
run_case 'README says "operating system for AI agents"' 1 'README.md' \
  'DorkOS is the operating system for AI agents.'

run_case 'a docs page says "operating system for autonomous AI agents"' 1 'docs/index.mdx' \
  'An open-source operating system for autonomous AI agents.'

run_case 'a blog post says "OS for AI agents"' 1 'blog/launch.mdx' \
  'Think of it as an OS for AI agents.'

# Family 2: the 2026-08 category line the reset replaced.
run_case 'a docs page says "one place for every agent"' 1 'docs/guides/z.mdx' \
  'One place for every agent you run.'

# Family 3: equal-accounts claims, an internal principle public copy never states.
run_case 'an operating skill says "agents are equal to people"' 1 'packages/operating-skills/src/skills/team.ts' \
  '  Agents are equal to people here: same account, same rights.'

run_case 'a README says "agents equal"' 1 'README.md' \
  'Here, agents equal people: one account each.'

run_case 'CONTRIBUTING says "equal accounts"' 1 'CONTRIBUTING.md' \
  'People and agents hold equal accounts.'

# Family 4: a Discord invite link, in prose and in the two surfaces only this
# group reaches — a package manifest and app source, where an href is
# invisible to check-vocab-gate.ts.
run_case 'a docs page links discord.gg' 1 'docs/community.mdx' \
  'Join the chat at [Discord](https://discord.gg/dorkos).'

run_case 'app source links a discord.com invite' 1 'apps/site/src/components/Footer.tsx' \
  '  <a href="https://discord.com/invite/abc123">Chat</a>'

run_case 'a package manifest description says "operating system for agents"' 1 'packages/cli/package.json' \
  '{ "description": "The operating system for agents." }'

echo ""
echo "== docs exemptions come from allowlist.json, never the marker (wave 6) =="

# check-vocab-gate.ts bans `vocab-allow` inside docs/**/*.mdx, so a docs red
# must point the writer at allowlist.json instead.
run_case 'a docs red names allowlist.json as the fix' 1 'docs/guides/voice.mdx' \
  'Never call DorkOS an OS for AI agents.' '' 'scripts/vocab-gate/allowlist.json'

DOCS_ALLOW='{ "entries": [ { "path": "docs/guides/voice.mdx", "terms": ["OS for AI agents"], "contains": "Never call DorkOS", "reason": "states the rule" } ] }'

run_case 'a contains-scoped allowlist entry exempts its docs line' 0 'docs/guides/voice.mdx' \
  'Never call DorkOS an OS for AI agents.' "$DOCS_ALLOW"

run_case 'the same entry does not exempt a different line' 1 'docs/guides/voice.mdx' \
  'DorkOS is the OS for AI agents.' "$DOCS_ALLOW"

run_case 'an entry naming no wave-6 term does not exempt wave 6' 1 'docs/guides/voice.mdx' \
  'Never call DorkOS an OS for AI agents.' \
  '{ "entries": [ { "path": "docs/guides/voice.mdx", "terms": ["adapter"], "reason": "wave 4 only" } ] }'

run_case 'the entry exempts wave 6 only, never a wave-2 word on the line' 1 'docs/guides/voice.mdx' \
  'Never call DorkOS an OS for AI agents, or a cockpit.' "$DOCS_ALLOW"

# Outside docs/ the allowlist is not read: there the marker is the exemption.
run_case 'an allowlist entry does not reach a blog post' 1 'blog/voice.mdx' \
  'Never call DorkOS an OS for AI agents.' \
  '{ "entries": [ { "path": "blog/voice.mdx", "terms": ["OS for AI agents"], "reason": "x" } ] }'

echo ""
echo "== the guard must stay GREEN on everything we deliberately kept =="

# The bare word "Discord" is a real app people connect (the relay adapter type
# is literally "discord"). Only an invite link is banned.
run_case 'the bare word "Discord" is fine in prose' 0 'docs/guides/relay.mdx' \
  'Connect Discord, Telegram or Slack so your agents can reach you.'

run_case 'the bare word "Discord" is fine in app source' 0 'apps/client/src/features/discord/Setup.tsx' \
  "  label: 'Discord bot token',"

# "DorkOS" contains "OS"; the short-form branch needs a non-word character in
# front, so the product name followed by "for agents" must not fire.
run_case '"DorkOS for agents" is not the short form' 0 'README.md' \
  'Install DorkOS for agents and the people who run them.'

# Every wave-6 branch is fenced as a whole phrase. Each of these fired before
# the boundaries were written out, and each is an ordinary docs sentence.
run_case '"agents equally" is not "agents equal"' 0 'docs/guides/fp1.mdx' \
  'Budget runs across your agents equally.'

run_case 'a benchmark "equal to humans" is not an accounts claim' 0 'docs/guides/fp2.mdx' \
  'The model scored equal to humans on the reading test.'

run_case '"the OS for each agent" is not the short form' 0 'docs/guides/fp3.mdx' \
  "Pick the OS for each agent's sandbox."

run_case '"Unequal accounts" is not "equal accounts"' 0 'docs/guides/fp4.mdx' \
  'Unequal accounts of what happened are common in a long run.'

run_case '"OS for every agent" is not the short form' 0 'docs/guides/fp5.mdx' \
  "A shared OS for every agent's container image keeps builds fast."

# Source is scanned for links ONLY. A positioning phrase in a code comment is
# not prose; check-vocab-gate.ts judges render paths in app source.
run_case 'a positioning phrase in a source comment is not flagged' 0 'apps/server/src/x.ts' \
  '// The old headline was one place for every agent you run.'

# The link scan reads app and package SOURCE (`*/src/*`) only. A build script
# or a fixture outside src/ is not something a person reads.
run_case 'a Discord link outside src/ is not flagged' 0 'apps/x/scripts/a.ts' \
  "const url = 'https://discord.gg/abc123';"

# The root manifest names a `cockpit` script: code, not copy. Manifests are
# read for the positioning group only, never wave 2.
run_case 'a manifest script named cockpit is not flagged' 0 'package.json' \
  '{ "scripts": { "capture:cockpit": "node x.js" } }'

# A line that quotes a retired phrase to state the rule carries the marker.
run_case 'a marked line quoting the rule is allowed' 0 'AGENTS.md' \
  'Never write "operating system for AI agents" or "equal accounts". <!-- vocab-allow: states the rule -->'

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
  'DorkOS is a workspace for people and agents.'

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
