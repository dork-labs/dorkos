---
id: 261024-185346
title: The executed-suite gate knows the canvas browser's page-channel modules
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-test]
prs: []
ratchet-release: []
field-changes: []
---

DOR-2665 adds three browser modules that `browser-driving.spec.ts` imports
and registers, because they drive its served pages and preview proxy:
`workbench/doc-frame-sdk-browser.ts`, `doc-frame-companion-browser.ts` and
`doc-frame-outside-browser.ts`. They are plain `.ts` modules, so the
executed-suite gate (`scripts/assert-browser-tests-executed.sh`) read their
tests in the report as a stale report and ejected #3104 from the merge queue
five times. The gate's `REGISTERED_MODULES` and its own fixture test (the
files, their report entries, the executed total) now list them. Nothing
measurable should move. Revert only if a module is removed or becomes a
`*.spec.ts`.
