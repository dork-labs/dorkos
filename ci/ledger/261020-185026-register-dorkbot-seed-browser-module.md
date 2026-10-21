---
id: 261020-185026
title: The executed-suite gate knows the sidebar's renamed browser module
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-test]
prs: []
ratchet-release: []
field-changes: []
---

The sidebar no longer has a Heads up zone or a Today zone (DOR-3092), so the
two browser modules that tested them are gone: `now-survives-reload.ts` and
`send-lands-in-today.ts`. The one case still worth a browser, that the Ask
DorkBot seed names an errored session after a reload (DOR-1136), moved into
`apps/e2e/tests/dashboard-sidebar/dorkbot-seed-survives-reload.ts`, a plain
`.ts` module `chat-mock.spec.ts` registers, the same shape as before.

The executed-suite gate (`scripts/assert-browser-tests-executed.sh`) refuses a
`REGISTERED_MODULES` entry naming a deleted file, and reads an unlisted module
as a stale report, so the list swaps the two old names for the new one. Its own
fixture test follows (the file, its report entry, the executed total). Nothing
measurable should move. Revert only if the module is removed or becomes a
`*.spec.ts`.
