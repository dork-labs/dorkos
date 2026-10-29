---
id: 261027-053504
title: The browser suite runs on ubuntu-24.04 while it fails on 26.04
kind: incident-fix
status: proposed
actor: agent
gates: [wf.browser-test.browser-shard, wf.browser-test.browser-test]
prs: [3217]
hypothesis:
  metric: gate.wf.browser-test.browser-shard.failure_rate@merge_group
  baseline: 1
  baseline_source: 'merge_group runs 40442057994 (03:04Z), 40450511301 (04:34Z) and 40453263811 (05:04Z) on 2026-10-27: every queue build on ubuntu-26.04 failed browser-shard 2/6 and 4/6'
  target: 0.05
  after_days: 14
ratchet-release: []
field-changes: []
---

Every job in `browser-test.yml` now asks for `ubuntu-24.04` instead of
`ubuntu-latest`.

Why: between 00:51Z and 03:04Z on 2026-10-27 GitHub moved `ubuntu-latest` to
ubuntu-26.04. #3211's queue run (40429032161) passed the browser suite on
ubuntu-24.04 testing tree `d53b681a86`. The same tree, as `main` at
`fd785479fa` under #3215 and #3217, then failed the same specs three times on
ubuntu-26.04: `connections/owner-management.ts`, three in
`connections/session-access.ts`, and `conversation/ask-parks.ts`, all 30-second
timeouts. The code didn't change; the runner did. The unit-test shards pass on
26.04, so only this file is pinned.

The target is the suite's pass rate before the move. Lift the pin, and revert
this entry's change, once the browser suite passes on ubuntu-26.04 (its own
ticket), and before GitHub retires the 24.04 image.
