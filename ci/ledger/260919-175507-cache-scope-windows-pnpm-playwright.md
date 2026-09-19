---
id: 260919-175507
title: 'Cache-scope fix for the Windows pnpm store and the Playwright browsers'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.harness-windows.harness-windows
  - wf.browser-test.browser-shard
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: null
  baseline_source: 'research/20260919_ci-pipeline-01-inventory.md §6.3: no Windows pnpm or Playwright cache exists on main, so every PR and queue ref re-downloads and re-saves them (735 MB and 268 MB); Actions cache at 10.31 of 10 GB; hit rate not yet measured'
  target: 0.8
  after_days: 14
ratchet-release: []
field-changes: []
---

Seeded proposal 8 of 14 from plans/ci-steward-plan.md §6.

Caches saved under PR merge refs and queue refs can never be read by any other ref, and they evict the useful ones. Saving them from a ref main can read frees the pool. Revert if cache restore time exceeds the download it replaces.
