---
id: 261126-202655
title: Security's path list covers the person bar in lib/http/
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4978 (A1). The person bar (`assessPerson`) moves out of
`routes/extensions-person-bar.ts` into `apps/server/src/lib/http/person-bar.ts`,
beside the account-decision bar, because the capability mount now runs it too.
On Security's call (t1j, 2026-11-26), the lib/ branch of
`SECURITY_PATH_PATTERN` (workflow, reference fixture and `Policy.swift`) gains
`http/person-bar`, and the parity test gets a row with a look-alike
(`lib/http/person-bars.ts`) that stays off. This only widens which PRs need
Security's review. No job, timing or trigger changes, so nothing measurable
should move.
