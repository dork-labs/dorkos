---
id: 261128-012239
title: Security's path list covers the shared wire contract
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-5164 (step 8, W1). `packages/shared/src/wire/` holds the contract between
a home and its computers: every feature id, the minimum set a computer needs
for turns, and the rule that each side uses only what both named. Spec
`space-computer-contract` §13 names the folder as a path that decides trust.
On Security's call (t1j, 2026-11-27), `SECURITY_PATH_PATTERN` (workflow,
reference fixture and `Policy.swift`, byte-identical) gains
`packages/shared/src/wire/`, and the parity test gets a row with a look-alike
(`packages/shared/src/wired/`) that stays off. This only widens which PRs need
Security's review. No job, timing or trigger changes, so nothing measurable
should move.
