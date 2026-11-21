---
id: 261119-165508
title: The executed-suite gate knows the Git refusal heading browser module
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-test]
prs: []
ratchet-release: []
field-changes: []
---

DOR-4534 adds a browser test that a known Codex Git refusal names the next step,
live and after a durable replay, on phone and desktop. It lives in
`apps/e2e/tests/chat/git-refusal-heading.ts`, a plain `.ts` module that
`chat-mock-session.spec.ts` registers, because its `codex-git-refusal` scenario
exists only on the test-mode leg. The executed-suite gate
(`scripts/assert-browser-tests-executed.sh`) only accepts such a file when it is
listed in `REGISTERED_MODULES`; without it, #3994 was ejected from the queue.

The change registers the module and updates the gate's own test fixture to
match (the file, its report entry and the executed total, 22 -> 23; 63 pass).
Nothing measurable should move: the gate holds the new module to the same
standard as the others. Revert only if the module is removed or becomes a
`*.spec.ts`.
