---
id: 261126-072144
title: Security's main path list names startup/test-composition (C4)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

C4 (DOR-5444) moves the test-mode runtime's scenario world to
`apps/server/src/startup/test-composition/`, with the stand-in cloud link that
test runs use. Security asked for the folder on the main list, so a change to
that stand-in reaches them. Added in `security-gate.yml`'s
`SECURITY_PATH_PATTERN`, its regex fixture and `Policy.swift`, with a parity row
and a look-alike that stays off. Same shape as 261126-050102 (C3).
