---
id: 260929-131703
title: The changelog fragment check keeps full history so an old branch's range is its own
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.changelog-fragment-check.fragment-present
  - wf.changelog-fragment-check.no-fragment-under-skip-label
prs: [2343]
hypothesis:
  metric: 'gate.wf.changelog-fragment-check.fragment-present.failure_rate@pull_request'
  baseline: 0.06
  baseline_source: 'measured 2026-09-29 with `gh run list --workflow changelog-fragment-check.yml -L 300` (2026-09-28T08:30Z to 09-29T13:10Z): 200 pull_request runs, 12 failed. Three of the 12 were this defect, all on #2064 (feat/launcher-provenance-markers), whose logs report 2227 and 2278 user-facing commits since the merge base; the other nine report 0 to 5, real missing fragments or the analyzer tests'
  target: 0.045
  after_days: 14
ratchet-release: []
field-changes: []
---

The checkout in both jobs is full history (`fetch-depth: 0`), and the next step then ran
`git fetch --no-tags --depth=200 origin <base>`. A depth-limited fetch into a full clone writes
`.git/shallow` and cuts the base branch's history 200 commits back. A pull request that branched
from further back than that (#2064 branched from `5d17a07d9`, 271 commits behind main) walks past the
cut, so `changelog_backfill.py --since <merge-base>` counted every commit behind it as the pull
request's own. #2064 was charged 2278 commits, and merging main into it cannot help, because the
branch point stays old.

The change drops `--depth` from every fetch in both jobs, since the checkout already holds full
history. `fragment-present` also fails loudly if the history is ever shallow again, instead of
counting a wrong range. The triggers, job names, `if:` and timeouts are unchanged, so the required
check still reports on `pull_request` and `merge_group`.

Reproduced from a full clone of #2064's head `7b716739b` against main `076d6fc67`. With the old
step, the clone becomes shallow, the range is 3424 commits and the gate reports 2278 user-facing, 2274
uncovered, exit 1, which is CI's exact number. With the new step, the clone stays full, the range is 5,
and the gate reports 2 user-facing, 2 covered, exit 0.

Target: the three false reds out of 200 go away, so 0.06 becomes about 0.045. That is a rough number,
because how often a branch this old is open varies week to week. Revert if the step's fetch time
makes the job exceed its 10-minute ceiling (a full fetch of `main` into a full clone is incremental,
so this is not expected), or if a fragment check on an old branch still reports thousands of commits.
