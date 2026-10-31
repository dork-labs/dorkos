---
id: 261031-020633
title: Superseded PR runs cancel themselves in the four PR workflows that had no concurrency group
kind: experiment
status: proposed
actor: agent
gates:
  - wf.changelog-fragment-check.fragment-present
  - wf.changelog-fragment-check.no-fragment-under-skip-label
  - wf.operating-skills-version-check.version-outranks-base
  - wf.security-approve-tests.acl
  - wf.security-gate.security-gate
prs: []
hypothesis:
  metric: queue.queue_wait
  baseline: 77.5
  baseline_source: 'origin/ci-steward-data snapshots/2026-10-29.json, queue_wait_min p50 over 14 merged PRs (collected 2026-10-30T11:16Z); on 2026-10-30 the Actions queue held ~470 runs against 1-2 running, and 66 runs on heads that were no longer the branch tip were cancelled by hand'
  target: 50
  after_days: 14
ratchet-release: []
field-changes: []
---

On 2026-10-30 the Actions queue held about 470 runs with one or two running, and a
merge-group build waits behind every one of them. Four `pull_request` workflows had no
`concurrency:` group, so every push to a pull request left its older runs queued:
`changelog-fragment-check`, `operating-skills-version-check`, `security-approve-tests`
and `security-gate`. Each now groups by workflow and pull request number and cancels in
progress on `pull_request` and `pull_request_target` only. Every other event (`merge_group`,
`workflow_dispatch`) gets a group keyed on its own `run_id`, so no other run can ever
share it, cancel it, or replace it while it is pending.

The event-aware groups in `test`, `lint`, `typecheck` and `browser-test` were checked and
left alone: on `pull_request` their group is `refs/pull/N/merge` plus the constant `gate`
suffix and `cancel-in-progress` is true, so they already cancel superseded runs.

Required checks keep reporting: the newest run in a group is never the one cancelled, so
the newest head always reports, on `pull_request` and on `merge_group` alike. A cancelled
run on the same head (a label or body edit re-runs it) is replaced by the later run's
result for the same check name.

Revert if a required check from one of these workflows is ever left cancelled with no
newer run on the newest head, or if `queue.queue_wait` p50 does not move after 14 days
(then the backlog is elsewhere: `claude.yml` and `security-review-initialize.yml` are the
two `pull_request` workflows still without a group).
