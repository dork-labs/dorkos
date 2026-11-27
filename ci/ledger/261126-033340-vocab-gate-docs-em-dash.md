---
id: 261126-033340
title: The vocab gate bans em dashes in docs prose (wave 12)
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

The docs rule "no em dashes" (`.claude/rules/user-facing-writing.md`) was a
must nothing checked (DOR-4943). Wave 12 in
`scripts/vocab-gate/banned-terms.json` bans the em dash in docs prose: its
`roots` keep it to `docs/`, and `MDX_SCANNED_WAVES` puts it in the docs scan,
which blanks inline code and fenced blocks first. The same change rewrites
all 306 em dashes the scan found in 32 pages, so the wave starts with no
allowlist entries.

Hygiene, not an experiment: one more term in an existing line scan, no gate
timing or failure rate should move. Revert the wave, or add a scoped,
reasoned allowlist entry, if it fires on a docs line that must keep one.
