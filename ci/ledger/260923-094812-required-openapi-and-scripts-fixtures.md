---
id: 260923-094812
title: openapi-fresh and scripts-test fixtures become required, so a red on either stops merging
kind: experiment
status: active
actor: agent
gates:
  - wf.docs-openapi-check.openapi-fresh
  - wf.scripts-test.fixtures
  - wf.scripts-test.harness
  - ruleset.required_status_checks
prs: []
hypothesis:
  metric: main-green
  baseline: 6
  baseline_source: 'origin/ci-steward-data latest.json (collected 2026-09-22, data to 2026-09-21), SLO main-green: red_episodes 6, restore_p90 73.2 min, n=289, window 2026-08-25..09-21 (09-02..09-11 not collected yet, so 6 is a floor, not a count).'
  target: 1
  after_days: 28
ratchet-release: []
field-changes:
  - gate: wf.docs-openapi-check.openapi-fresh
    field: required
    from: 'advisory'
    to: 'ruleset 19893973'
  - gate: wf.scripts-test.fixtures
    field: required
    from: 'advisory, pull_request and push only, path-filtered'
    to: 'ruleset 19893973, pull_request + merge_group + push, unfiltered'
---

## Why

Every red episode on `main` since 2026-08-25 came from a workflow the queue did
not require. 8 of 13 were real breaks whose own PR was red on that check and
merged anyway, because only required checks bind once a PR is armed. Two
checks carry most of it, and both are cheap and deterministic:

- `openapi-fresh` (docs-openapi-check.yml). #1655 already gave it a
  `merge_group` trigger and no path filter, so the queue ran it and still
  merged its reds (queue builds 3737ba7, d439bdf, 7927d6e). 2026-09-16..23: 0
  failures in 226 queue runs, 1 in 215 PR runs.
- `fixtures` (scripts-test.yml), home of the docs-coverage-map drift check.
  #1657 was red on it and merged. 2026-09-09..23: 1 failure in ~240 completed
  PR runs (the drift check), 0 of 114 push runs.

## What changed

- Both contexts are in `ci/required-checks.json`. The ruleset edit comes after
  this merges.
- `fixtures` runs on `pull_request`, `merge_group` and `push`, with no path
  filter and no scope: about a minute of bash and Node, no install. Scoping it
  inside the job would have put an `if:` and a census exception on each of its
  ~27 steps to save ~40 seconds of a runner the job holds anyway.
- `harness` (about four minutes, pnpm install + build) is **not** required and
  does not run in the queue. It went red on 3 PRs in two weeks and on 0 pushes
  to `main`, so no harness break on record reached `main`. It keeps its old
  scope, now one list in `scripts/scripts-test-scope.sh`, decided by the first
  step of `fixtures` (so no extra job per PR). That step fails open to running
  `harness`, and never fails `fixtures`.
- `push` to `main` stays on scripts-test, now unfiltered, because `main-green`
  is computed from push-to-main runs. Retiring it would cut red episodes by
  removing a sensor. Retiring push legs is 260919-175509, still proposed.

## Reading the verdict honestly

- **Do not credit the window rolling.** The pre-#1655 openapi push-leg episodes
  leave the 28-day window from 2026-09-25 whatever this change does. A drop
  that comes only from episodes aging out is not this change.
- **openapi-fresh is invisible to this metric.** It has had no push leg since
  #1655, so an openapi break that merges no longer shows up in `main-green` at
  all. Its half is judged by what the queue does instead: with the context
  required, a red `openapi-fresh` ejects a build instead of merging it, so
  `gate.wf.docs-openapi-check.openapi-fresh.real_catches` should be above 0
  and no stale-docs fix PR should follow a merged one.
- **The sensor got wider, not narrower.** `fixtures` now runs on every push to
  `main`, not only path-matched ones. That can only surface more red episodes,
  so it biases against the target, never for it.

## Cost, and what would make us revert

Queue: `openapi-fresh` already ran in every queue build, so requiring it adds
no runner minutes. `fixtures` adds one job and ~1.1 min (p95 1.12, max 1.30) per
build, about 36 runner-minutes a day at ~33 builds a day. Neither is on the
critical path: `openapi-fresh` p95 is 3.1 min and `fixtures` 1.1 min, against a
`queue-build` p50 of 30.3 min set by the test and browser shards. Pull requests
and pushes add about 40 more runner-minutes a day (`fixtures` on PR pushes and
main commits that the old filter skipped); `harness` minutes are unchanged.

Revert a context (ledger entry, then ruleset edit) if, in any 7-day window,
it causes more than one queue ejection that re-passes unchanged on the same
tree (`ejections_caused` minus `real_catches` above 1): at that point it is
lowering `queue-green`, the constraint, instead of stopping breaks. Also revert
`fixtures` if its queue p90 passes 3 minutes, three times today's.
