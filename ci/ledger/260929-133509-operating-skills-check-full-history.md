---
id: 260929-133509
title: The operating-skills version check keeps full history so an old branch finds its fork point
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.operating-skills-version-check.version-outranks-base
prs: [2346]
hypothesis:
  metric: 'gate.wf.operating-skills-version-check.version-outranks-base.failure_rate@pull_request'
  baseline: 0
  baseline_source: 'measured 2026-09-29 with `gh run list --workflow operating-skills-version-check.yml -L 300` (2026-09-28T05:13Z to 09-29T13:32Z): 164 completed pull_request runs, none failed. The defect needs a branch forked more than 200 commits behind main that has not merged main since, which none of those runs had; it was found by review (DOR-2560) and reproduced by hand'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-2560, the same defect #2343 fixed in the changelog fragment check. The job checks out full
history (`fetch-depth: 0`), then ran `git fetch --no-tags --depth=200 origin <base>`. A
depth-limited fetch into a full clone writes `.git/shallow` and cuts the base branch 200 commits
back. For a branch that forked from further back, `git merge-base` then finds nothing and exits 1,
and under the runner's `bash -e` the required `version-outranks-base` step fails with no message.

The change drops `--depth` from both fetches in "Resolve the fork point and the base branch tip".
The checkout already holds full history, so the fetch only brings the base ref up to date. The
`pull_request` leg also fails with a clear `::error::` if the history is ever shallow, and names the
refs if `git merge-base` still finds nothing. Triggers, the job name, `if:` and the timeout are
unchanged, so the required check still reports on `pull_request` and `merge_group`.

Reproduced from a full bare clone of GitHub, with `main` at `5b683d964` and HEAD at `0eb831a9f`
(forked from `5d17a07d9`, 274 commits behind). The old step leaves the clone shallow and exits 1
with no output beyond the fetch. The new step keeps the clone full, exits 0, and finds fork point
`5d17a07d9`. On a deliberately shallow clone, the new step fails with the shallow-history error.

Why this metric: the defect has no occurrence in the measured window, so the honest number is the
one the change must not make worse. It stays at 0 while branches are recent, and a failure now says
why. Revert if the step's full fetch pushes the job past its 10-minute ceiling (not expected: the
fetch into a full clone is incremental).
