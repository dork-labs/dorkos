---
id: 261120-201356
title: Label edits no longer cancel the newest changelog-fragment-check run
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.changelog-fragment-check.fragment-present
  - wf.changelog-fragment-check.no-fragment-under-skip-label
prs: []
hypothesis:
  metric: tracked.expected-context-blocks
  baseline: 1
  baseline_source: '#4054 on 2026-11-20: a label burst queued several changelog-fragment-check runs at one head, run 44801099072 (the newest) was cancelled before any job started, and the PR read "2 of 11 required status checks are expected" until that run was re-run by hand'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

On 2026-11-20 a burst of label edits on #4054 queued several
`changelog-fragment-check` runs at one head in the shared `pr-<N>` concurrency group.
GitHub cancelled the newest of them before any job started. A required context is
read from the newest run of its workflow, so `fragment-present` and
`no-fragment-under-skip-label` read as expected-but-missing, and auto-merge was set
but never fired. Re-running that one run fixed it.

Ledger 261031-020633 assumed the newest run in a group is never the cancelled one.
That holds for one push at a time, not for a burst of events landing together.

Change: a `labeled` or `unlabeled` event whose label is not `skip-changelog` now gets
its own `run-<run_id>` group with `cancel-in-progress: false`. Its jobs run exactly as
before, so both contexts report from it. `opened`, `reopened`, `synchronize` and
`skip-changelog` edits keep the shared group and keep cancelling older runs, because
there a newer run really does supersede the older answer. `merge_group` is unchanged.

Cost: label edits that used to cancel each other now each run once (about a minute
each, measured p95 0.70 min).

What this does not close: events that still share the group can still burst. `gh pr
create --label skip-changelog` sends `opened` and `labeled(skip-changelog)` together, and
a push followed by a skip-changelog edit does the same. They stay shared on purpose:
moving them out would let an older run with a stale label list be the newest. For those,
the backstop is the local arm script, which re-runs an empty newest run of a workflow that
owes a required check before it queues a PR. So the target of 0 counts PRs that stayed
blocked, not empty runs.

The metric is read by hand (arm refusals and room reports), not by the collector, so this
entry's verdict is written by a person after 14 days.

Revert if a required context from this workflow is again left expected at a PR's head
after a label edit, or if label-edit runs measurably add to the Actions queue.
