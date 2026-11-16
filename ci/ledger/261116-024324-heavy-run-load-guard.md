---
id: 261116-024324
title: A heavy job waits for the load to drop, then refuses
kind: experiment
status: proposed
actor: agent
gates:
  - lefthook.pre-commit.lint
prs: []
hypothesis:
  metric: 'local-commit'
  slo: 'local-commit'
  baseline: 107.6
  baseline_source: 'origin/ci-steward-data latest.json, collected 2026-11-15T12:37Z: SLO local-commit over 2026-11-08..2026-11-14, n=413 hook runs, p90 107.6 s, killed_share 0. Beside it, machine.load_per_core_p90 1.11 (n=15120 readings, 2 clones).'
  target: 95
  after_days: 14
ratchet-release: []
field-changes: []
---

## What changed

`scripts/heavy-run-lock.sh` caps how many heavy runs START (3 slots), not how
busy the host is. On 2026-11-15 a load of about 40, mostly from work no slot
covers, held QA's gates for hours. So a `--job` now reads the 1-minute load
first. Over `local.heavy_max_load` (24) it waits, re-reading every
`local.heavy_load_poll_seconds` (30 s), for up to
`local.heavy_load_wait_seconds` (600 s). Still over: it runs nothing and exits
75, printing the load and the slot holders. A job waiting on the load holds no
slot. `DORKOS_HEAVY_LOCK=0` still switches everything off, and now leaves a
`lock_off` note. New notes: `load_wait <s>`, `load_refused <load>`.

The commit gate (no `--job`) is never load-checked and never refuses: a gate
that refuses gets skipped. Not checked either: nested calls, CI, `--hold` (a
bare `turbo` run, whose helper never fails a run) and an unreadable load.

The shot and Playwright entry points now go through the lock as jobs: the
`apps/e2e` `e2e`, `e2e:first-run`, `capture`, `capture:record` and `demo`
scripts, and the root `test:browser`. Under `CI` they run exactly as before.
`turbo.json` passes `DORKOS_HEAVY_*` to the `e2e` task so the opt-out reaches it.

## Why `local-commit`

No metric scores the host's load (`tracked.machine-load` is reported, never
scored, and has no verdict reader). The commit gate is what a busy box slows,
and it is the one path this change leaves unchecked on purpose, so it is where
the freed capacity should show: fewer jobs piling on at load 24+ means a faster
pre-commit `lint` p90. Read `machine.load_per_core_p90` beside it; 1.11 now
(about 15.5 on 14 cores), and it should fall too.

Confounder: `local-commit` is also moved by other local changes in the same
window (`261115-173750-pre-push-midrun`, the verify proof). If both land, read
an improvement as shared.

## What would make us revert

`load_refused` notes on most job runs on a quiet day (the reading is wrong, or
24 is too low for this host), or a report of an agent skipping a gate with
`DORKOS_HEAVY_LOCK=0` as a habit. Raise `heavy_max_load` before removing the
guard.
