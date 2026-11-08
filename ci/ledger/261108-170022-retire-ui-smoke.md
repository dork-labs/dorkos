---
id: 261108-170022
title: Retire ui-smoke.yml, a duplicate of browser-test's browser-smoke
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-smoke, wf.browser-test.browser-test]
prs: []
ratchet-release: []
field-changes: []
---

`browser-smoke` (ledger 261107-203000, #3528) runs the same Playwright `@smoke`
set on every pull request in four shards, inside the required `browser-test`
check. `ui-smoke.yml` (ledgers 261030-180020 and 261101-174117) ran that set
again in three shards, only on PRs touching apps/client/ or packages/ui/, and
was never a required check: the "main: merge queue" ruleset requires
`browser-test`, not `ui-smoke`. The PM approved removing it.

It was also failing on its own. On #3505, run 42483997472 hit the
`--global-timeout=1500000` deadline in shard 2/3 on both attempts with zero
failed tests (attempt 1: 113 passed, 1 did not run; attempt 2: 112 passed, 2
did not run), so the fan-in went red. On the same head, browser-test run
42483997449 passed all four `browser-smoke` shards in 20 to 23 minutes.

Removed: the workflow and its three gates (`wf.ui-smoke.scope`,
`wf.ui-smoke.ui-smoke-shard`, `wf.ui-smoke.ui-smoke`). Both earlier entries
are now `reverted`. That frees five hosted jobs (scope, three shards, fan-in) on
every UI PR push, and two (scope, fan-in) on every other PR push and merge group.

What `browser-smoke` does not carry over, by design of 261107-203000: no
quarantine lane or gate (every PR smoke failure blocks), and `E2E_SITE=0`, so a
site spec tagged `@smoke` runs only in the queue. Revert if a UI break that
`ui-smoke` would have caught on the PR reaches the queue because of either.
