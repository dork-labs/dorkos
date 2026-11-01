---
id: 261101-174117
title: ui-smoke runs in three balanced shards behind one fan-in, so the set can finish
kind: hygiene
status: proposed
actor: agent
gates: [wf.ui-smoke.scope, wf.ui-smoke.ui-smoke-shard, wf.ui-smoke.ui-smoke]
prs: []
ratchet-release: []
field-changes: []
---

The @smoke set has grown to 335 tests in 71 spec units, about 44 minutes of tests
by `shard-timings.json`. On one worker under a 25-minute step cap it had never
finished, and the cap killed Playwright before its reporters flushed, because the
unsharded `globalTimeout` is 105 minutes.

Now three shards using the balanced-shard reporter, a 30-minute step cap and
`--global-timeout=1500000`, behind a fan-in that keeps the one `ui-smoke`
context. Checked with `--list` in CI mode: the three cuts hold 121, 103 and 111
tests, which sum to the unsharded 335, at ~14.7 minutes each. The pnpm store key
also takes browser-test.yml's `ImageOS` fix (ledger 261031-071000).

Not yet measured on a runner. browser-test.yml's estimate of 5 minutes of boot
plus 1.25x the test share at p95 puts a shard near 23.4 of its 25 minutes, so
this is tight. Add a fourth shard if `--global-timeout` fires on a healthy set,
and revert if the set still cannot finish.
