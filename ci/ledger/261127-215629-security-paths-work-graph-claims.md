---
id: 261127-215629
title: Security's path list covers the work graph, the claim service and their owner rule
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4972 (W6). The work graph's reads now decide what a reader sees of a chat
(`work_item_chats`, the private-span scrub), the claim service writes the
history those reads show, `namesPerson` in the capability registry is the
owner rule for that read, the composition root wires the claim recorder, and
the shared shapes say what a reader gets. On Security's call (t1j,
2026-11-27), `SECURITY_PATH_PATTERN` (workflow, reference fixture and
`Policy.swift`) gains `services/work-graph/`, `services/session/claims/`,
`services/core/self-description/dorkos-registry.ts`,
`startup/steps/work-graph.ts` and `packages/shared/src/work-graph-reads.ts`,
and the parity test gets a row for each with a look-alike that stays off. This
only widens which PRs need Security's review. No job, timing or trigger
changes, so nothing measurable should move.
