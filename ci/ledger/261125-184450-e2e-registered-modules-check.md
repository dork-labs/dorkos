---
id: 261125-184450
title: A pull request touching apps/e2e checks REGISTERED_MODULES against the specs' register imports
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.test.test-shard
  - wf.browser-test.browser-test
prs: []
ratchet-release: []
field-changes: []
---

Nov 25: #4334 added `apps/e2e/tests/chat/ref-link-chip.ts`, registered into `chat-mock-session.spec.ts`, without
listing it in `REGISTERED_MODULES` in `scripts/assert-browser-tests-executed.sh`. That proof runs only on full browser
runs (main, canary, release), so the PR passed and main's `browser-test` went red (fixed by #4444).

`apps/e2e/__tests__/registered-modules.test.ts` now reads the array from the script (strictly: it throws if the array
can't be found or holds anything but one quoted path per line) and checks both directions: every relative non-spec
module a `*.spec.ts` imports a `register…Tests` function from is listed, and every listed module exists and is still
imported. It runs in `@dorkos/e2e`'s vitest suite, which a PR's hash plan selects for any apps/e2e change; a change to
the script is a `scripts/**` path and runs every suite. `chat/ref-link-chip.ts` is tolerated until #4444 merges (the
`PENDING_IN_FLIGHT` map; delete the entry then). Revert if it flags a module the proof itself accepts.
