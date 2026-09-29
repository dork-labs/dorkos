---
id: 260929-130905
title: The executed-suite gate knows the Connections session-access browser module
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-test]
prs: []
ratchet-release: []
field-changes: []
---

The Connections "session access status" browser test ran out of its 30 s
budget in merge-queue builds: six page reloads behind an 8 s chat setup. It is
now split and moved into `apps/e2e/tests/connections/session-access.ts`, a
plain `.ts` module that `connections.spec.ts` registers, the same shape as
`owner-management.ts`, `event-notifications.ts` and `chat-connect-card.ts`.
The executed-suite gate (`scripts/assert-browser-tests-executed.sh`) only
accepts such a file when it is listed in `REGISTERED_MODULES`, or it reads the
module's report entry as a stale file.

The change registers the module and updates the gate's own test fixture to
match (the file, its report entry, the executed total, and the missing /
skipped / deleted checks every registered module gets). Nothing measurable
should move: the gate holds the new module to the same standard as the others.
Revert only if the module is removed or becomes a `*.spec.ts`.
