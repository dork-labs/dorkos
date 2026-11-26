---
id: 261126-181513
title: Security's path list covers the person and owner bars in lib/
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4978 (A1). The checks every door asks about who is calling live in
`apps/server/src/lib/`, which is not on Security's list as a folder. On
Security's call (t1j, 2026-11-26), `SECURITY_PATH_PATTERN` (workflow,
reference fixture and `Policy.swift`) gains one branch naming six files:
`lib/caller-authority.ts`, `lib/caller-principal.ts`, `lib/file-route-guards.ts`,
`lib/person-without-session.ts`, the new `lib/http/account-decision-bar.ts`, and
`lib/http/own-origin-write.ts`. The parity test gets a row for each, with a
look-alike that stays off. This only widens which PRs need Security's review.
No job, timing or trigger changes, so nothing measurable should move.
