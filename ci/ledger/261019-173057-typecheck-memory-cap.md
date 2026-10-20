---
id: 261019-173057
title: The typecheck step runs at most three tasks at once, so it fits in the runner's memory
kind: incident-fix
status: active
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
hypothesis:
  metric: gate.wf.typecheck.typecheck.failure_rate
  slo: queue-green
  baseline: 0.17
  baseline_source: 'Hand sample of typecheck.yml runs created 2026-10-19 12:00 to 17:15 UTC: 8 failed of 48 completed, non-cancelled runs (0.17), each with the typecheck step killed at 4 to 8 minutes ("The operation was canceled", well under the 20-minute limit), including merge-queue runs for #3085 and #3096. The 40 runs between 00:19 and 12:00 had none. ci-steward-data latest.json (collected 2026-10-19 10:39) predates the failures.'
  target: 0.03
  after_days: 7
ratchet-release: []
field-changes: []
---

The typecheck step ran out of memory. A memory sampler on #3108 showed used
memory climb to 15.5 of the runner's 16 GB, with 496 MB free and 2.5 GB of
swap in use, while five big tsc processes overlapped at the end of the run
(server, client, desktop, evals, cli, each allowed an 8 GB heap). The runner
then killed the step. Every failed run killed the same five. The server
package grew today (DOR-3008, DOR-3009), which pushed the overlap past the
runner's memory.

The fix caps turbo at three tasks at once for this step and keeps the sampler,
which prints each new memory peak as a notice. No bigger runner: that costs
money.

Revert or retune if the step's duration p90 rises past 12 minutes (the job's
limit is 20), or if a run's printed peak climbs back above 14 GB: then the
next fix is a smaller per-process heap or splitting the step.
