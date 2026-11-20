---
id: 261117-170155
title: only main saves the Playwright Chromium cache, and a weekly main run keeps the Windows pnpm store warm
kind: experiment
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-smoke
  - wf.browser-test.browser-shard
  - wf.browser-test.first-run
  - wf.app-frame-browser.gesture-spec
  - wf.harness-windows.harness-windows
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: null
  baseline_source: 'gh api actions/cache/usage and actions/caches, 2026-11-17 17:00Z: 10.82 GB in 102 entries against the 10 GB budget. playwright-chromium: one entry, on refs/heads/main (playwright-chromium-Linux-1.65.0-alpha-2026-10-30, 298 MB), none on queue or PR refs. Windows pnpm store: no entry on any ref, main included. Largest scope: 90 buildkit-blob-* entries (4.53 GB) on the v0.135.13 tag ref, which this change does not touch.'
  target: 0.8
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-4190, follow-up to ledger 261116-114104 (#3852), which moved every pnpm store to a restore
plus a main-only save. Two caches were left over.

**playwright-chromium.** The four `key: playwright-chromium-…` steps (browser-test.yml
browser-smoke, browser-shard, first-run; app-frame-browser.yml gesture-spec) used a plain
`actions/cache`, which saves in its post step on any ref whose restore missed. Today main
holds the entry and nothing else does, but every Playwright version bump leaves main without
one until the next canary, and each queue build and PR run in that gap saves its own ~300 MB
copy into a scope nothing else can read. browser-smoke runs only on pull_request, so every
save it made was of that kind. Each step is now `actions/cache/restore` plus an
`actions/cache/save` gated on `refs/heads/main` and a restore miss, placed after the install
step succeeds, both pinned to v6.1.0 by SHA. Main still saves through browser-test.yml's
schedule canary (`41 0,5,10,21 * * *`; browser-shard and first-run run on it).

**harness-windows.** Since #3852 only a run on main saves the Windows pnpm store, and nothing
ran this workflow on main except a manual dispatch, so no entry exists and every queue build
installs from the registry. It gains a weekly `schedule` (`43 2 * * 1`, clear of the canaries'
:29/:33/:37/:41 slots). That is cheaper than a push trigger (a run for every merge) or a
Windows leg on test.yml's canary (four a day, and the workflow header says a Windows leg never
joins `test`). The job reads no secrets and has `contents: read` only. Lockfile changes land
about every two days, so a weekly save covers the current lockfile only part of the week.

Expected within 7 days: no `playwright-chromium-*` or `pnpm-store-Windows-*` entry on any
non-main ref; main holds a `pnpm-store-Windows-*` entry after the first Monday run; total use
under 10 GB once the tag's buildkit entries age out (they are outside this change). Watch
`gate.wf.harness-windows.harness-windows.duration_p50@merge_group` beside the hit rate. Revert
the schedule if it costs more Windows runner time than the queue installs it saves, or if
Playwright browsers on PRs go cold for longer than a canary interval after a version bump.
