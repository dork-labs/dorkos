---
id: 261016-150940
title: community-pg gets a 25-minute limit, so its browser leg stops timing out
kind: incident-fix
status: active
actor: agent
gates: [wf.test.community-pg]
prs: []
hypothesis:
  metric: gate.wf.test.community-pg.ejections_caused
  slo: headroom
  baseline: 1
  baseline_source: 'Hand sample of test.yml runs created since 2026-10-15 (52 runs, 45 community-pg jobs with a duration): p50 12.2 min, p90 14.2 min, max green 14.7 min against timeout-minutes 15; one green-bound run killed at 15.1 min (the v0.118.0 release PR #2948). ci-steward-data latest.json (collected 2026-10-16) has no gate-level row for this job yet.'
  target: 0
  after_days: 14
ratchet-release: []
field-changes:
  - gate: wf.test.community-pg
    field: timeout-minutes
    from: '15'
    to: '25'
---

Since C8 part 1 (#2946) put the community browser suite under a strict content policy and added tests, `community-pg` runs 12 to 15 minutes against a 15-minute limit: p90 14.2 min is 95% of the limit. One run that would have passed was killed at the limit, failing the required `test` check. 25 minutes puts today's p90 at 57%, inside the 60% headroom objective.

This is a stopgap, not a speed-up. The follow-up is to split the browser leg (Playwright against real Postgres) into its own job, or to share one build between the two legs; either should bring the job well under 15 minutes again. Revert to 15 once that lands. Revert sooner if p90 climbs past 15 minutes: that would mean the suite is growing, not just near its limit.
