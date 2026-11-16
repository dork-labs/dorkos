---
id: 261115-200656
title: The executed-suite gate knows the project add-ons notice browser module
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-test]
prs: []
ratchet-release: []
field-changes: []
---

DOR-4404 adds a browser test for the lasting note that a project's own
OpenCode add-ons are off. It lives in `apps/e2e/tests/chat/project-addons-notice.ts`,
a plain `.ts` module that `chat-mock-turns.spec.ts` registers, because its
`project-addons-off` scenario exists only on the test-mode leg and it reloads
the page on that file's sequential worker (the same shape as
`live-turn-visibility.ts`). The executed-suite gate
(`scripts/assert-browser-tests-executed.sh`) only accepts such a file when it is
listed in `REGISTERED_MODULES`; without it, #3771 was ejected from the queue four
times with every browser shard green.

The change registers the module and updates the gate's own test fixture to
match (the file, its report entry and the executed total; 62 pass). Nothing
measurable should move: the gate holds the new module to the same standard as
the others. Revert only if the module is removed or becomes a `*.spec.ts`.
