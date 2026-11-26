---
id: 261126-050102
title: Security's path lists cover the Connections lease types' new homes (C3)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

C3 (DOR-5403) moves the Connections lease types from `services/connectors/`
to the kernel module `services/core/connections-lease/`, and three plain values
to `packages/shared/src/connections-lease.ts`. The old files were on Security's
main path list, so the new homes join it in `security-gate.yml`'s
`SECURITY_PATH_PATTERN`, its regex fixture and `Policy.swift`, each with a
parity row and a look-alike path that stays off. Same shape as C2's entry
(261125-212923). Revert only with the move itself.
