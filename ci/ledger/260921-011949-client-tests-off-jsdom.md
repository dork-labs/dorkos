---
id: 260921-011949
title: 'Client tests that never touch the DOM run on node, not jsdom'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p90@merge_group'
  slo: 'queue-build'
  baseline: 17.4
  baseline_source: 'origin/ci-steward-data:snapshots/2026-09-19.json, gate wf.test.test-shard@merge_group: n=64, p50 15.4 min, p90 17.4 min (the PR leg reads p50 1.2 / p90 15.5 and is affected-only, so it is not the comparable)'
  target: 15
  after_days: 14
ratchet-release: []
field-changes: []
---

## The observation

`apps/client/vite.config.ts` sets `environment: 'jsdom'` for the whole project,
so every one of its test files pays for a DOM. Vitest defaults to a worker per
core, so one client run is about 14 jsdom workers on this 14-core, 48 GB
machine, and several agents run suites at once. Measured while this was written:
109 node processes, 8 Claude sessions, swap 11.4 GB of 12.3 GB used, 330,049
pageouts.

That is the same symptom the `machine-saturated` trigger (rule 12,
`ci/config.yaml` `triage.machine_*`) now reports, and this is the structural fix
behind it: the trigger says the machine is out of memory, and this is one of the
reasons it is.

## The first step is measurement, not a migration

Counted on 2026-09-20 with `find` over `apps/client/src` (1,240 test files;
`apps/server/src` has 1,126 on the `node` environment — a separate count from
the operator's 1,245/1,241, so reconcile the method before quoting either):

- **230** contain no reference to `@testing-library`, `jsdom`, `document`,
  `window` or `render(` at all.
- **824** are `.test.tsx`, which is a good proxy for a component test.

So the candidate set looks like **about a fifth** of the project, not most of
it. The target above is set accordingly and is deliberately modest; the honest
first task is to replace that crude grep with a real classification, because a
fifth of the files may be much less than a fifth of the time and memory.

## The cost, and the risk

The cost is the migration: per-file `@vitest-environment node` pragmas, or a
second vitest project with its own include globs, plus the churn of moving
files to match it.

The risk is specific and quiet. A test that asserts on the DOM and is moved to
`node` does not necessarily fail — an assertion can stop running rather than
start failing, and the suite stays green while covering less. Any migration
needs a check that the moved files' assertion counts did not drop, not just
that they still pass.

Revert if `wf.test.test-shard` failure rate rises at all: a shard that got
faster by testing less is the failure mode, and it is worth more than the
minutes.
