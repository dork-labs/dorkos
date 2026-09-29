---
id: 260927-094251
title: The executed-suite gate knows the chat connect card's browser module
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-test]
prs: [2195]
ratchet-release: []
field-changes: []
---

DOR-2415 adds `apps/e2e/tests/connections/chat-connect-card.ts`, a plain `.ts`
module that `connections.spec.ts` imports and registers, the same shape as
`owner-management.ts` and `event-notifications.ts`. The executed-suite gate
(`scripts/assert-browser-tests-executed.sh`) only accepts such a file when it is
listed in `REGISTERED_MODULES`, so the first queue build of #2195 had all three
browser shards pass and still failed: the gate read the module's report entry
as a stale file.

The change registers the module and updates the gate's own test fixture to
match (the file, its report entry, the executed total and the missing / skipped
/ deleted checks that every registered module gets). Nothing measurable should
move: the gate holds the new module to the same standard as the others. Revert
only if the module is removed or becomes a `*.spec.ts`.
