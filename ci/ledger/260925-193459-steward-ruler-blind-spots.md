---
id: 260925-193459
title: "CI Steward measures what fires: main-green by workflow, headroom against Playwright's deadline, flaky coverage, repeat ejections"
kind: hygiene
status: active
actor: agent
gates:
  - wf.ci-steward.collect
prs: []
ratchet-release: []
field-changes: []
---

Hygiene: this changes the ruler, not the pipeline. No gate checks anything differently. Four
readings could not see what they claimed to, and one tracked metric had no computation at all.

**What changed.**

- `main-green` (and trigger rule 7): a red spell ends when the push workflow that failed goes green
  on `main`, not at the next commit whose push checks were green. The push workflows are
  path-filtered differently (desktop-smoke only runs when the desktop, server, client or packages
  change), so that commit often never ran the failing one. Snapshots now keep each commit's per-workflow result. A red
  workflow that reports nothing for 7 days is dropped, so a sensor retired while red cannot hold
  `main` red forever.
- `headroom` (and trigger rule 8): each gate is read against the deadline that fires first.
  `ci/config.yaml` `deadlines:` records the browser shards' Playwright `globalTimeout`, 30 minutes,
  against a 45-minute job timeout that is built never to fire. A test pins the number to
  `playwright.config.ts`'s derivation and the shard matrix.
- `flaky-test-runs`: reads `unmeasured`, with the note "coverage unknown", when a red queue build in
  the window failed a job whose report the collector does not read. community-packaged and
  community-pg run Playwright at `retries: 0` (a flake there can only be a hard failure),
  credential-free-build and harness-windows upload no test report. The share, `failed_jobs` and
  `unreported_failed_jobs` stay in the stats. Verdicts read the share without this ruler, so a
  verdict never turns n=0 because of it.
- `tracked.repeat-ejections`: computed per day by the collector (`repeatEjections`), from the same
  timeline and queue-build data as `real_catches`. A day collected before it has no count and is
  left out of a verdict, never read as 0.
- Old days get the new fields from `refreshOlderDays`, on whatever budget is left after collecting:
  one push-run listing and one merged-PR search per day (19 requests for the 7 days to 2026-09-24,
  measured against the live API). Collecting always outranks refreshing; a pulse or `--day` run
  never refreshes.

**Readings that move because the ruler changed, not because CI did.** Computed on 2026-09-25 from
the data branch (window 2026-09-18..24; main-green 2026-08-28..09-24) and the push runs for those
days:

| Reading                     | Old ruler             | New ruler                                                       |
| --------------------------- | --------------------- | --------------------------------------------------------------- |
| `headroom` p95_over_timeout | 0.648, ok             | 0.972, **breach**, browser shard                                |
| `flaky-test-runs`           | share 0, met          | share 0, **unmeasured**: 62 of 121 failed queue jobs unreported |
| `main-green` red_episodes   | 14, breach            | 9, breach                                                       |
| `main-green` restore_p90    | 65.8 min              | 356 min                                                         |
| constraint                  | queue-green (quality) | **headroom (tripwire)**                                         |
| `tracked.repeat-ejections`  | not computed          | 14 per 7 days (of 51 ejections)                                 |

Every other SLO reads the same. So:

- **The constraint moves to `headroom` on the first run after this merges**, and a red
  `headroom:wf.browser-test.browser-shard` trigger opens. Nothing got slower: healthy shards already
  ran their suite in 23-26 of Playwright's 30 minutes (run 36101786398), and 14 of 965 queue
  shard jobs in the week took longer than 30 minutes end to end. That is the ruler finally seeing it.
- **`main-green` episodes drop and restore time rises** for the same outages: spells that the old
  rule chopped in two are one spell now, and each lasts until its workflow is actually green.
  260923-094812 (openapi-fresh and scripts-test fixtures required, target 1 episode) is judged on
  `red_episodes`: its before-window is recomputed under this ruler too once its days are refreshed,
  so the comparison stays like for like, but its hand baseline of 6 was an old-ruler count, and a
  verdict that falls back to it is comparing two rulers. Read that verdict against the recomputed
  before-window only.
- **The 7-day SLO windows change on the first run; `main-green`'s 28 days change as the refresh
  reaches them** (newest first, a few requests each), so for a day or two its reading mixes rulers.
  A day not yet refreshed reads exactly as before.
- **`flaky-test-runs` stops being `met`.** It was never measuring those jobs. Its floor is null, so
  no floor moves. It reads a share again only in a week when every red queue job was one it reads.
- **260923-095512's baseline (11.5) was measured by hand with a different push signal** (the head's
  first check suite). The collector reads timeline commits and force-pushes, as `newCommit` does.
  Expect the two to differ by a little; read that entry's verdict against its before-window.
- 260923-095643 (browser shard balance) reports `headroom` as its SLO. Both of its windows are read
  with the same deadline, so its SLO movement stays like for like; the absolute numbers are higher.

**Not changed, on purpose.** The main canary's reds stay out of `main-green`: it is push-only by
definition, and the canary has its own trigger and `tracked.time-to-detect` (a canary red from the
fixture-clock break at 2026-09-25 00:17Z is on the page as `main-canary`, not as a `main-green`
spell). The 2026-09-09..11 gap on the data branch was backfill still in progress, not a lost range:
backfill runs oldest first after the recent days and had reached 09-08. A dispatched run of the
collector workflow on 2026-09-25 (36178629501) finished 09-08 and collected 09-09..11, all complete
and healthy, so no code was needed for it.

**Revert if** the refresh ever spends budget the recent days needed (a late recent day with
refreshed older ones in the same run), or `main-green` holds a spell open with no red workflow
that is still running.
