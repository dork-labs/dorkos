---
id: 261126-024020
title: Copy-spec drift fails the required typecheck job and pre-push
kind: experiment
status: proposed
actor: agent
gates: [wf.typecheck.typecheck, lefthook.pre-push.copy-spec-drift, wf.browser-test.browser-test]
prs: []
hypothesis:
  metric: 'gate.wf.browser-test.browser-test.ejections_caused'
  slo: queue-green
  baseline: 18
  baseline_source: 'ci-steward-data snapshots 2026-11-18 to 2026-11-24, ejections_caused["wf.browser-test.browser-test"] summed (2+0+2+6+4+4+0)'
  target: 16
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4937, with its bug DOR-4009. Browser specs assert literal copy and run only in the merge queue, so a copy rewrite that strands one is green on the PR and ejected in the queue. `scripts/check-copy-spec-drift.ts` catches that shape in seconds, but it ran only as the advisory `copy-spec-drift` job in `browser-test.yml`, so a red blocked nothing. In the week above that job failed 26 of 763 PR runs and 2 of 505 queue builds: two drifts it saw reached the queue anyway.

The change: the script runs as a step of the required `typecheck` job (unfiltered, no attest skip, reports on `pull_request` and `merge_group`), on the base the file-size ratchet uses (the merge commit's first parent on a PR and on the canary, `merge_group.base_sha` in the queue). It also runs at pre-push on the branch point, time-wrapped. The advisory job is gone, and nothing needed it. No required check is added. DOR-4009 first: a finding from a deleted file never cleared, because only its own file could answer. Now the corpus answers for a deleted file, so a string that still renders elsewhere clears and one that is gone still fails.

Hypothesis: with drift refused before the queue, `browser-test` ejections fall by the two a week the advisory job let through, from 18 to 16 over 7 days. The effect is small against that gate's weekly swing (0 to 6 a day), so an `inconclusive` verdict is likely; read it beside this gate's own record, which is that no queue build should fail on copy drift.

Guards, not the hypothesis. `gate.wf.typecheck.typecheck.duration_p90@pull_request` was 10.68 min (same snapshots, n=741) and should stay at or under 10.9: the step measured 0.5 s on a branch with no copy change and 3 s with one (three runs each, 2026-11-25). Pre-push gains the same 0.5 to 3 s. Removing the job saves about one runner-minute per PR run and per queue build (p50 1.03 min, 1268 runs that week).

Revert or rework if the step reds a PR whose copy still renders (a false positive now blocks the merge rather than costing a look), if the typecheck p90 guard is breached, or if pre-push p90 rises by more than 5 s.
