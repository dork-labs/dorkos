---
id: 261124-133558
title: The merge queue runs the unit suites its entry can reach, not every suite
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.test.test
  - wf.test.test-shard
  - wf.test.test-shard-count
  - wf.test.test-binary
prs: []
ratchet-release: []
field-changes: []
---

DOR-5130 step 6b, approved by Dorian Nov 24: "the merge queue runs what its batch changed plus
everything that depends on it; the full suite runs on main (rolling) + daily canary + pre-release".
Depends on ledger 261124-131757 (the rolling full run on main), which must land first.

Now: on `merge_group`, test-shard-count runs scripts/pr-test-plan.sh (read from the base commit)
over HEAD^1..HEAD. A queue entry is one squash commit on the entry ahead of it or main (checked on
runs 45399090865, 45398718443, 45398571799: one parent each, the entry named in the branch). The
plan is computed on the combined tree, so a change reaches every suite that builds on it. Root
config, the lockfile and the planner's control paths still select every suite. A missing parent,
planner or turbo pin, a failed planner, or a malformed or empty list all run every suite. The sweep,
its build step and test-binary follow the plan. Shards are ten for every suite or a plan reaching
packages/shared, six for apps/server, and two otherwise. The retry budget, the quarantine lane and
both proofs stay. assert-tests-executed.sh and assert-shard-union.sh take `--packages` and require
exactly the planned set (an empty or invalid list is refused). The binary union requires the binary
suites inside planned packages, and a quarantined file outside the plan is not expected in the
union. The push run on main, the canary and release PRs pass no plan and prove every package.

Baseline (week of Nov 16-22): queue test-shard 57,233 runner-min/week, queue `test` p50 21.2 min.
Target: queue test-shard under 30,000 runner-min/week and queue `test` p50 under 15 min, with no
break the queue would have caught reaching main more than once a week (read from the rolling run's
after-merge-alert issues).
Evaluate: Dec 1.

Revert if the rolling run on main turns red more than twice a week on a break a full queue sweep
would have caught (an undeclared cross-package read, or a two-PR clash outside the turbo graph).
