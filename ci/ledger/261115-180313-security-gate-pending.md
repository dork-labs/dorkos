---
id: 261115-180313
title: security-gate waits instead of failing while a PR only waits for a label
kind: experiment
status: proposed
actor: agent
gates: [wf.security-gate.security-gate]
prs: []
hypothesis:
  metric: gate.wf.security-gate.security-gate.failure_rate
  baseline: 0.37
  baseline_source: '@ci-steward read of the dashboard, Nov 15, over 2026-11-12 00Z to 2026-11-15 16Z (security-gate failure rate, every event)'
  target: 0.05
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-4459. `security-gate` showed as a failed job on roughly a third of its runs,
and almost none of them were real refusals. A hand count of the failed
`pull_request` runs from 2026-11-12 to 2026-11-15 (258 runs, read from each
run's log and the PR's label timeline at that moment): 131 had `hold` on and no
`security-reviewed` label, 75 had `hold` on and a fresh label, 46 had `hold` on
and a stale label, and 6 had a stale label with no `hold`. Every one of the 252
held runs was a PR waiting for Security's label or for `hold` to come off, the
normal path for a helper PR. The gate refused them early, mostly as "typecheck
has not finished", because a held PR skipped the existing waiting rule.

The change: the PR run of `security-gate` now treats `hold` as waiting too,
unless a Security label on the PR is wrong (a bot added it, it has no labelled
event, or its push time cannot be read). A waiting run succeeds with an
annotation and a summary line saying it is waiting, not approved. Nothing that
decides a merge changes: `security-review`, the status main's copy writes and
`arm.sh` and merge-tail require to be `success`, still says failure for these
heads, and the merge-queue run of `security-gate` still refuses them. No
permission, trigger, job name, required check or ruleset changes. A stale label
with no `hold`, and every other refusal, still fails.

The PR run checks out its base, so this takes effect on PRs opened or re-run
after it merges. Revert if any PR merges, or is armed, with `hold` on or without
a Security label covering its head, or if the failure rate stays above 0.10 at
the verdict.
