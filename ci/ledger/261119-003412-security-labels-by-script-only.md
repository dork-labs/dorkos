---
id: 261119-003412
title: agents are told only Security's label-pr.sh adds or removes security-* labels
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Instructions only, no gate changes. On #3950 (2026-11-18) both `security-*` labels went on by
hand, 7 minutes apart, with no Security review file; the arm script refused it, as designed
(DOR-4618). AGENTS.md and the `creating-pull-requests` skill now say only Security's
`label-pr.sh` adds or removes those labels (DOR-4711). Nothing measurable should move. Revert if
it ever conflicts with how Security labels.
