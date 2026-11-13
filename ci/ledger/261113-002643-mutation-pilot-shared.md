---
id: 261113-002643
title: An on-demand Stryker mutation run of packages/shared, on CI only
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.mutation-pilot.shared
prs: []
ratchet-release: []
field-changes: []
---

## Why

Refs DOR-4186. Codebase Cleanup's Phase 0 asks for a bounded, per-test Stryker
pilot to calibrate which tests catch real changes, and says it must run on CI,
never on a team Mac. Nothing in the repo runs mutation tests today.

## What changes

- **A new `workflow_dispatch` job, `mutation-pilot` / `shared`, on `ubuntu-latest`.**
  It runs Stryker 10.1.1 with the vitest runner and per-test coverage on
  `packages/shared` only, then keeps the JSON and HTML report for 30 days and
  writes the score, mutant counts, elapsed time and peak memory to the job
  summary. Missing data prints as unknown, never zero.
- **Bounded.** The `mutate` input can narrow the files inside `packages/shared`;
  it is checked against a fixed character set and refused if it tries to leave
  the package. `concurrency` is 1-8. Static mutants are skipped (`ignoreStatic`),
  since each forces a full suite run.
- **Least access.** Workflow `permissions: {}`, job `contents: read`, no secrets,
  `persist-credentials: false`, actions pinned by SHA.
- **Nothing else changes.** Not required, no PR, queue or push trigger, no effect
  on any gate that runs today. Two devDependencies on `packages/shared`.
- **`timeout-minutes: 300` is unmeasured.** No run exists yet. Record the first
  run's elapsed time here and lower it.

Revert if it is dispatched and its report is never read, or if a run holds a
runner the queue needed.
