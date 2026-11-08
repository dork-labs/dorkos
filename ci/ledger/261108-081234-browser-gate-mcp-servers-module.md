---
id: 261108-081234
title: The executed-suite gate knows the Connections MCP servers browser module
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-test]
prs: []
ratchet-release: []
field-changes: []
---

#3501 (DOR-3213) adds `apps/e2e/tests/connections/mcp-servers.ts`, a plain
`.ts` module that `connections.spec.ts` registers, the same shape as
`session-access.ts` and `owner-management.ts`. The merge queue's
`browser-test` refused the run: the executed-suite gate
(`scripts/assert-browser-tests-executed.sh`) only accepts such a file when it
is listed in `REGISTERED_MODULES`, or it reads the module's report entry as a
stale file.

The change registers the module and updates the gate's own fixture to match
(the file, its report entry, the executed total, and the missing / skipped /
deleted checks every registered module gets). Nothing measurable should move:
the gate holds the new module to the same standard as the others. Revert only
if the module is removed or becomes a `*.spec.ts`.
