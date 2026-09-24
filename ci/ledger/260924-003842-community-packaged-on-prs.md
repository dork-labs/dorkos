---
id: 260924-003842
title: The packaged Community proof runs on pull requests that touch the community slice
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.community-packaged
  - wf.scripts-test.fixtures
prs: []
hypothesis:
  metric: gate.wf.test.community-packaged.ejections_caused
  slo: queue-green
  baseline: 22
  baseline_source: 'origin/ci-steward-data snapshots/2026-09-17..2026-09-22.json (latest.json collected 2026-09-23T09:51Z), ejections_caused["wf.test.community-packaged"] per day 1, 0, 3, 11, 7, 0 = 22 over 6 whole days; real_catches 2 of them (09-17, 09-21). merge_group leg 180 runs, 37 failures; pull_request leg 167 runs, all green, all 2-7 s (it ran nothing).'
  target: 3
  after_days: 7
ratchet-release: []
field-changes: []
---

## Why

`community-packaged` is a required check, and on `pull_request` it reported green
having run nothing: the sealed packaged proof (`apps/community/acceptance/run.sh`)
ran only on `merge_group` and the main canary. So a change that broke the driver
was first seen in the queue, as an ejection (#1987: the browser spec gained an
"Open community" step, the driver did not). Every one of the seven PRs that
changed the driver since 2026-09-17 also touched a path in the new scope list
(#1916, #1958, #1974, #1981, #1987, #1992, #2021).

## What changed

- The job checks out on every event (depth 2) and its new first real step,
  `Decide whether this change can reach the packaged proof`, writes `run=true|false`.
  `merge_group`, `schedule` and `workflow_dispatch` always answer true, so the
  queue and the canary are unchanged. `pull_request` diffs the test-merge commit
  against its first parent and asks `scripts/community-packaged-scope.sh`, the one
  list of what can reach the proof. Every way that path can fail to decide runs
  the proof; none skips it or reds the check.
- The list is the community slice, not the whole Docker context: `apps/community/`,
  community-named files under `apps/{client,server}/src` and `packages/shared/src`,
  `packages/cloud-api/`, `packages/cli/scripts/build.ts`, the lockfile and
  workspace file, `scripts/sweep-ephemeral-docker.sh`, the list itself and
  `test.yml`. Over the 200 merges before 2026-09-23 that is 65 PRs (32%); the
  whole context would be 153 (77%). Breaks from outside the slice are still
  caught by the queue and the canary, just not at PR time.
- Pinned twice: `scripts/test-community-packaged-scope.sh` (the list, in
  scripts-test `fixtures` and `test:scripts`) and
  `scripts/__tests__/community-packaged-scope-step.test.ts` (the shipped step,
  extracted from the YAML and run in a throwaway repo per event).

## Cost

About 6.3 runner-minutes (merge_group p50, 2026-09-17..22, n=180) per push of a
PR in scope, on one extra concurrent job, and the PR leg now sees the proof's
flakes (DOR-2164). At ~20 merges a day, ~6.5 in scope, 2-3 pushes each: roughly
80-125 runner-minutes a day.

## What would make us revert

`gate.wf.test.community-packaged.failure_rate@pull_request` above the
merge_group leg's for two weeks (the PR leg is paying for flakes without
catching defects), or ejections_caused not falling while the PR leg catches
nothing. Confounder: #1958 (2026-09-21) made the proof's retry path
deterministic, so part of any drop from the 09-20/21 peak is that fix; the
before-window's own days after 09-21 are the fairer comparison.
