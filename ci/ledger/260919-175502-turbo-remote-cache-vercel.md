---
id: 260919-175502
title: 'Turbo remote cache through Vercel Remote Cache'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
  - wf.lint.lint
  - wf.test.test-shard
  - wf.credential-free-build.credential-free-build
prs: []
hypothesis:
  metric: 'gate.wf.typecheck.typecheck.duration_p50'
  slo: 'pr-feedback'
  baseline: 4.62
  baseline_source: 'typecheck.yml timeout comment: 207 merge_group typecheck jobs 2026-08-11..09-03, p50 4.62 min, p90 7.64'
  target: 2.5
  after_days: 14
ratchet-release: []
field-changes: []
---

Seeded proposal 3 of 14 from plans/ci-steward-plan.md §6.

About 11 cold builds of the shared packages per queue entry, with no remote cache anywhere. Vercel Remote Cache is free on all plans under fair use and needs no Vercel hosting. The Actions-cache fallback is not viable until the cache-scope fix frees the 10 GB pool. Revert if a cache hit ever produces a green run a cold run would fail.
