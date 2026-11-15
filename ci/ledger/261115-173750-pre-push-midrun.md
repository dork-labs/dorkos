---
id: 261115-173750
title: Refuse a push that would cancel CI still running from the last push
kind: experiment
status: proposed
actor: agent
gates:
  - lefthook.pre-push.ci-midrun
prs: []
hypothesis:
  metric: tracked.job-minutes-per-merged-pr
  baseline: 74
  baseline_source: "@ci-steward's Nov 15 read: 74 job-hours of cancelled pull_request runs in test.yml + browser-test.yml from 2026-11-12T00Z to 2026-11-15T16Z (88 hours, about 141 h/week). ci/metrics.yaml has no cancelled-job-hours metric, so the id is the closest computed one (cancelled PR runs are inside a merged PR's runner minutes); the baseline and target are cancelled job-hours, read by hand the same way."
  target: 25
  after_days: 7
ratchet-release: []
field-changes: []
---

`test` and `browser-test` cancel a PR's in-flight runs when a new head arrives
(`cancel-in-progress` on `pull_request`). Most of the 74 cancelled job-hours
were a fix commit pushed minutes after the previous one. The new pre-push
command `ci-midrun` (`scripts/pre-push-midrun-check.mjs`) asks `gh run list`
for both workflows on the current branch and refuses the push while one is
queued or in progress and under ten minutes old. `CI_PUSH_ANYWAY=1` skips it.
Anything that fails (no gh, no auth, no network, a 4 s timeout, detached HEAD,
unreadable output) prints one line and lets the push through. It skips `main`
and a push where HEAD already equals the remote-tracking ref. It tests nothing,
so DOR-2160 stays true.

Hypothesis: cancelled PR job-hours for those two workflows fall from about
141 h/week (74 h over the 88-hour window) to under 25 h/week within 7 days.
Re-read them the same way as the baseline. Watch `hook.pre-push.duration_p90`
beside it: the gh calls run in parallel under a 4 s limit, so the hook should
not grow by more than that.

Revert if cancelled hours do not move, if people answer it with `--no-verify`
(losing the other pre-push checks), or if it refuses pushes it should not.
Pushes from agents that never use lefthook are untouched by this change.
