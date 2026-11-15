---
id: 261111-181542
title: Hold production knip findings to a shrinking baseline
kind: experiment
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
hypothesis:
  metric: gate.wf.typecheck.typecheck.duration_p90@merge_group
  slo: pr-feedback
  baseline: 9.12
  baseline_source: 'origin/ci-steward-data snapshots 2026-11-04 through 2026-11-10, wf.typecheck.typecheck@merge_group, 183 completed duration samples; nearest-rank p90 547 seconds (9.1167 minutes).'
  target: 10.12
  after_days: 14
ratchet-release: []
field-changes: []
---

Refs DOR-4186. Production knip currently reports debt but is absent from CI.
This change stages the baseline and checker only: no workflow or existing gate
is changed. Activation waits for the workflow freeze (DOR-4030) to lift. The
existing policy scripts run before package builds, so attaching knip to them
would require extra builds and would mix unrelated checks. The intended later
activation is after turbo typecheck, reusing the outputs it already builds.
That separate pipeline PR needs a QA check and a Security light read before
activation; recheck this runtime baseline and the debt baseline against its
exact head. The 14-day experiment starts on activation, not on this staged PR.

Once activated, existing findings remain visible; a new finding or increased
multiplicity fails. A removed finding must leave the baseline. Comparing the
baseline with main prevents a PR from raising its own allowance, including when
multiple entries merge as one queue batch. No required context, timeout or retry
budget changes.

The direct quality measure is the committed baseline's finding count, which the
checker prints on every run. Once activated, it can only decrease. This is not proof that every
finding is dead code: open-project checks and security review still govern
deletions. The scored hypothesis bounds the runtime price to at most one added
minute at p90 after 14 days. Read the unused-code count beside that verdict.

Rework the placement or analysis scope if this step pushes the typecheck job
past 10.12 minutes at p90, if platform differences create unstable identities,
or if valid public entry points are treated as permission to delete code. Do
not raise the debt baseline or weaken the queue's required checks to get green.
