---
id: 261127-031500
title: Security's path list covers the shared files that decide caller-bar labels
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4978 (A1). Two shared files decide what a caller behind a declared bar is
called and which bars exist: `packages/shared/src/activity-schemas.ts`
(`personBarActivityActor`: "a program" or "You") and
`packages/shared/src/capabilities.ts` (`HttpCallerBar`, `PersonBarCopy` and the
fixed cross-site sentence). Neither was on Security's list. On Security's call
(t1j, 2026-11-27), both join the shared-files alternative of
`SECURITY_PATH_PATTERN` (workflow, reference fixture and `Policy.swift`), and
the parity test gets a row for each, with a look-alike that stays off. This
only widens which PRs need Security's review. No job, timing or trigger
changes, so nothing measurable should move.
