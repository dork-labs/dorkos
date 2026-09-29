---
id: 260928-075416
title: Boot the marketing-site leg on one browser shard, and print leg output
kind: incident-fix
status: active
actor: agent
gates:
  - wf.browser-test.browser-shard
prs: []
hypothesis:
  metric: 'gate.wf.browser-test.browser-shard.failure_rate@merge_group'
  slo: 'queue-green'
  baseline: 0.015
  baseline_source: 'hand count over job logs of the 67 six-shard merge_group browser-test runs created 2026-09-28T01:48Z..07:08Z (after #2243 fixed the status-line-fit/session-canvas-sync failures): 6 of 402 shard jobs failed, 5 of them `Timed out waiting 242000ms from config.webServer` (the Marketing Site leg), 1 a real connections-spec failure. Script and logs: DOR-2360 comment.'
  target: 0.005
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-2360. Since the matrix went to six shards (#2212) the queue has been
ejecting PRs with `Error: Timed out waiting 242000ms from config.webServer.`
on a different shard each time. 242000 is the Marketing Site leg's timeout and
no other leg's.

## What the data says

The first 120 six-shard queue builds (2026-09-27 20:32Z to 2026-09-28 07:08Z,
720 shard jobs, every job log read):

- **8 builds (6.7%) failed on the site leg's timeout**, 1 shard boot in 90.
  Since #2243 merged (01:48Z) it is 5 of the 6 failed builds.
- **It is a stall, not a slow tail.** The whole boot phase (every leg, global
  setup, test load; suite step start to the balanced-shard line) ran p50 300s,
  p95 316s, p99 324s, max 368s over 712 green shards, the same on every shard
  index. In the 8 failures the four legs ahead of the site leg were up after
  120-186s, which leaves roughly a minute for a healthy site boot; the failed
  ones sat silent past 242s. Raising the number would not have caught them.
- **Runner contention did not predict it.** Boot phase p50 was 300s whether
  the shard waited under 2 minutes or over 10 for a runner, and the 8 failing
  shards waited anywhere from 6s to 23 min.
- **Nothing says why**, because no leg's output ever reached the log. Every
  leg sets `stdout: 'pipe'`, which hands the output to the reporters; CI's
  reporters (html, json, github, manifest, balanced-shard) print none of it,
  and the manifest reporter's silence on `printsToStdio` stops Playwright's
  `dot` fallback, the one default that would.

## The change

1. **Boot the site leg on shard 1 only.** Only `features.spec.ts` and
   `marketplace.spec.ts` use it. Every shard still collects them (so the
   duration-balanced cut stays identical everywhere), the balanced-shard
   reporter pins them to shard 1, and only shard 1 starts `next dev`. The
   workflow passes `E2E_SHARD_INDEX`; the pinned shard refuses to run if its
   leg was not booted, and `__tests__/site-leg.test.ts` fails if a spec that
   points at the site is missing from the pinned list.
2. **Print the legs' output.** `reporters/webserver-legs-reporter.ts` (a v2
   reporter, so output arrives live rather than held until `onBegin`) prints
   each leg's first 150 lines during the boot, one summary line with each leg's first and
   last output time, and each leg's last 40 lines on a failed run. The in-leg
   `turbo` commands get `--output-logs=new-only`, so cache replays stay quiet
   and a cache miss (the #2243 shape) is what shows.
3. The 242s timeout is **kept**, with the measurement beside it in
   `playwright.config.ts`. `LEG_BOOT_MINUTES` (5) and `ci/config.yaml`'s
   25-minute deadline are unchanged: shard 1 still boots every leg, so the
   slowest shard's boot is what it was.

## Expected

Five of six shards stop booting the leg, so its stall chance per queue build
falls from about 6 boots' worth to 1: site-leg timeouts from 8 in 120 builds
(1 in 15) to about 1 in 90 builds. The shard failure rate after #2243 was 0.015, 5/6 of it this
timeout; the target 0.005 is what is left with it cut by five sixths.

**Hand check beside the verdict:** count `Timed out waiting 242000ms` in
shard logs over the after-window; success is at most 1 per 60 builds. The
next one, if it comes, now carries the leg's own output and the per-leg boot
line, which is the second deliverable: the cause of the stall becomes
readable.

**Confounders.** 260919-175503 (six shards) and 260927-170236 are active on
this gate in the same window, and the verdict may read `inconclusive` for that
reason; the hand check above does not share the confound.

**Revert if** a site spec runs on a shard without the leg (the pin should make
that a loud refusal, not a timeout), or the leg-output lines flood the log
(the reporter caps each leg at 150 live lines; revert if the boot still
prints more than about 500 per shard).
