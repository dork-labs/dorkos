---
id: 261117-194143
title: A multi-file local test run waits while the load is over 16
kind: experiment
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: 'local-commit'
  slo: 'local-commit'
  baseline: 134
  baseline_source: 'origin/ci-steward-data, ci-steward status for 2026-11-16 (collected 2026-11-17): SLO local-commit over 2026-11-10..2026-11-16, n=1105 hook runs, p90 134 s, killed_share 0.0036. Beside it, the open machine-saturated trigger (283 MB free p10, 6293 MB swap p50).'
  target: 115
  after_days: 14
ratchet-release: []
field-changes: []
---

## What changed

An interim step until DOR-4209 (DOR-4646). A full or multi-file local test run
now waits while the 1-minute load is over `local.heavy_test_max_load` (16),
not the 24 every other `--job` uses, and prints `waiting for load`. The poll,
the 10-minute bound and the exit-75 refusal are the existing load guard's
(`261116-024324-heavy-run-load-guard`).

- `pnpm test` and the test step of `pnpm verify` go through
  `scripts/heavy-run-lock.sh --tests` (a `--job` with the lower bar).
- A bare root `pnpm vitest run` with no path or more than one waits through
  `scripts/lib/load-wait.ts`, the root config's `globalSetup`. One path never waits.
- `DORKOS_IGNORE_LOAD=1` skips the load wait for one run, keeping the slot
  cap. It is printed, and the lock records it as a `load_ignored` note.
- `CI` never waits, a nested run never waits twice, and an unreadable load
  lets the run through.

Still not covered: a package's own config (`pnpm --filter <pkg> test`, `vitest`
inside a package) and `vitest run --config <other>`.

## Why `local-commit`

The same reasoning as the load guard: no metric scores the host's load, and the
commit gate is the one heavy path left unchecked on purpose, so freed capacity
shows there first. Test runs are the heavy job agents start most often.

Confounder: `261116-024324` moves the same SLO inside this window. Read an
improvement as shared between the two.

## What would make us revert

Test runs refused on most days at a load the box handles fine (16 is too low
for this host), or agents setting `DORKOS_IGNORE_LOAD=1` as a habit. Raise
`heavy_test_max_load` before removing it.
