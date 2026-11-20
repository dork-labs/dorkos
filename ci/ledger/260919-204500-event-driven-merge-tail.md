---
id: 260919-204500
title: 'Event-driven merge-tail: arm on workflow_run completion, keep the cron as a backstop'
kind: experiment
status: withdrawn
actor: agent
gates:
  - wf.merge-tail.arm
prs: []
hypothesis:
  metric: 'tracked.green-to-armed'
  slo: 'lead-time'
  baseline: 162
  baseline_source: 'measured 2026-09-19 by the CI Steward orchestrator: over 200 scheduled merge-tail runs (2026-08-25 to 09-19) the gap between runs was p50 162 min, p90 305, max 748, so a finished PR waits about 2.7 h at the median for a backstop arm'
  target: 10
  after_days: 14
ratchet-release: []
floor-release: []
field-changes: []
---

merge-tail asks for `*/10`, but GitHub throttles scheduled workflows to about 7 runs a day here,
so it cannot be the arming path it was documented as. Trigger it on `workflow_run: completed` of
the required workflows, and on `pull_request: labeled`/`unlabeled` for the hold labels, and keep
the cron as a backstop. Implementing this also teaches the collector to compute
`tracked.green-to-armed` (a head SHA's all-green time joined to the next arming or queue entry),
which it does not yet.

Revert if the event fan-out costs more runner minutes than it saves in lead time, or if
`workflow_run` runs from forks ever reach the arming step.

**Withdrawn 2026-11-19 (ci-steward, ledger 261119-131000).** Never built. Faster ticks would not fix
the real flaw: a GitHub runner cannot see arm.sh's local gates (Security's review files, waivers,
FREEZE, the local verify record), and merge-tail armed #3934 before QA's sign-off on 2026-11-18. Arming
moves to a launchd sweep that only calls arm.sh. The GitHub-side end state is a gate App posting a
required check, after per-role Apps (DOR-3183).
