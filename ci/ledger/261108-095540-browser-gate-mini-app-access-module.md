---
id: 261108-095540
title: The executed-suite gate knows the Connections mini-app-access browser module
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-test]
prs: []
ratchet-release: []
field-changes: []
---

DOR-3547 adds browser tests for the one page where a person lets a mini app
read a connected app. They live in `apps/e2e/tests/connections/mini-app-access.ts`,
a plain `.ts` module that `connections.spec.ts` registers, because they need
the scripted provider's accounts that file resets before every test (the same
shape as `owner-management.ts` and `session-access.ts`). The executed-suite
gate (`scripts/assert-browser-tests-executed.sh`) only accepts such a file when
it is listed in `REGISTERED_MODULES`, or it reads the module's report entry as
a stale file.

The change registers the module and updates the gate's own test fixture to
match (the file, its report entry, the executed total, and the missing /
skipped / deleted checks every registered module gets; 57 pass). Nothing
measurable should move: the gate holds the new module to the same standard as
the others. Revert only if the module is removed or becomes a `*.spec.ts`.
