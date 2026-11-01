---
id: 261101-191731
title: Catch file-size and pipeline-ledger failures before push
kind: experiment
status: proposed
actor: agent
gates:
  - lefthook.pre-push.max-lines
  - lefthook.pre-push.ledger-coverage
prs: []
hypothesis:
  metric: tracked.first-try-pr-pass-rate
  baseline: 0.57
  baseline_source: Engineering coordinator seven-day audit supplied 2026-11-01; 57% of PRs passed required checks on their first head.
  target: 0.80
  after_days: 12
ratchet-release: []
field-changes: []
---

Pre-push adds the existing read-only max-lines ratchet and ledger coverage check.
The hypothesis is that catching these failures locally raises first-try PR pass
rate from 57% to 80% by 2026-11-13, through fewer CI-only ratchet failures.
Repeat the coordinator audit on that date using the same cohort and required
checks. This metric is hand-audited, not computed by the daily collector.
Concurrent fixes can affect the aggregate: count file-size and missing-ledger
first-head failures separately when assessing the result.

Coverage uses the existing discovered pipeline paths and the diff from the merge
base with origin/main to HEAD, so later main changes do not count against this
branch. No network fetch is added. Coverage measured 0.38 seconds against the
previous committed diff; max-lines took 14.7 seconds. Each hook keeps its timing
wrapper. Neither tests nor typecheck returns to push. Rework if the checks are
slow enough that people bypass them, or if the repeat audit shows no reduction
in ratchet failures.
