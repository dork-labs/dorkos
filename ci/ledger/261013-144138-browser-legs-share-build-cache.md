---
id: 261013-144138
title: Browser legs stop rebuilding the workspace because VITE_PORT was in the build hash
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
prs: []
hypothesis:
  metric: 'gate.wf.browser-test.browser-shard.duration_p90@merge_group'
  slo: 'headroom'
  baseline: 24.9
  baseline_source: 'origin/ci-steward-data snapshots 2026-10-06..12, wf.browser-test.browser-shard@merge_group job seconds (n=2148): p50 21.6, p90 24.9, p95 25.5 min. latest.json for 2026-10-12 reads headroom 1.02 with this gate the worst.'
  target: 21.5
  after_days: 14
ratchet-release: []
field-changes: []
---

**The incident.** Browser shard 2/6 hit its 25-minute `globalTimeout` on four queue builds on 2026-10-13 with every test that ran passing (DOR-2887). Two causes: a stale shard cut, fixed by refreshing `apps/e2e/reporters/shard-timings.json` in #2851, and a boot that had grown to 6.5-6.7 minutes per shard. This entry is the second.

**Why boot was slow.** Playwright starts the webServer legs one after another, and each Express leg runs `turbo run build --filter=@dorkos/server` before it boots. The workflow's warm-up step builds the same packages first so those runs are cache replays. They were not: every leg logged `cache miss` for every package. `turbo.json`'s `build` task hashes `VITE_*`, and the legs set `VITE_PORT` (4244 for the cockpit leg, 4248 for the test-mode leg, none in the warm-up), so each leg got its own hash and rebuilt the whole workspace: about 118 s for the cockpit leg and 125 s for the test-mode leg in run 38406320118. Turbo's Vite framework inference added `VITE_PORT` to the client's `generate:api-docs` hash the same way.

`VITE_PORT` is only the dev server's port (`apps/client/vite.config.ts`); no build output reads it (`import.meta.env.VITE_PORT` appears nowhere in client source). Excluding it from `build` and `generate:api-docs` makes `turbo run build --filter=@dorkos/server --filter=@dorkos/client --dry=json` print identical hashes with no `VITE_PORT`, `VITE_PORT=4244` or `VITE_PORT=4248`.

**Not changed.** The production leg sets `NODE_ENV=production`, which is a real build input, so it still rebuilds (about 140 s). Warming that hash too would only move the time from inside the deadline to before it.

**Expected effect.** Boot drops by about 3.5 minutes on every shard, so p90 shard job time goes from 24.9 to about 21.5 minutes. #2851 lands the same week and also moves the slowest shard, so a verdict will be confounded. The boot itself is the cleaner check: the `webServer legs ... tests begin at +Ns` line each shard prints should read about 180-200 s, not about 400.

**Revert if** a shard serves a stale client or server build, or if any build output turns out to depend on `VITE_PORT`.
