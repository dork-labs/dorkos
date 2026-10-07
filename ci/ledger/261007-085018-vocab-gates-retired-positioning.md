---
id: 261007-085018
title: Both vocabulary gates ban the 2026-10 retired positioning lines
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck, wf.scripts-test.harness]
prs: [2654]
ratchet-release: []
field-changes: []
---

The 2026-10 vision reset (DOR-2736) retired three positioning lines and one
link: "operating system for AI agents" in any spelling, "one place for every
agent", the equal-accounts claims, and Discord invite links. Nothing stopped
the next README, docs page or UI string from saying them again.

`check-banned-words.sh` gains a second word group with its own failure
message pointing at `meta/VOICE.md`. It scans the same prose as wave 2, plus
package manifests (positioning only, never wave 2, because the root manifest
names a `cockpit` script) and app/package source for Discord invite links only
(an `href` is invisible to the parser gate). Every phrase is fenced as whole
words with POSIX boundaries, so "Unequal accounts" or "your agents equally"
never fire. A docs page cannot carry the `vocab-allow` marker (the parser gate
bans it there), so for a wave-6 hit under `docs/` the shell gate honours
`scripts/vocab-gate/allowlist.json` entries that name a wave-6 term. Two bash
3.2 bugs surfaced and are fixed: a process substitution per file inside a
function crashed it, and an empty array tripped `set -u`.
`check-vocab-gate.ts` gains wave 6 in `banned-terms.json` for render-path
strings; a space in a term now matches any whitespace, so a JSX line wrap
cannot hide a phrase. Wave 6 stays out of the docs scan so a docs hit is
reported once.

Baseline on main: 0 hits on both gates (AGENTS.md, the one file that quoted
the retired lines, was rewritten in #2661). Target: both stay at 0 hits on
main through 2026-11-07, and no fixture-pinned false positive returns. Fixture
cases pin each family red, five ordinary sentences green, and the allowlist
path both ways.

No timing, retry, shard or required-status change. Revert, or narrow a
pattern, if the group ever fires on a legitimate use that is not quoting the
rule.
