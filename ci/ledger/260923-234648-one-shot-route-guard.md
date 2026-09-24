---
id: 260923-234648
title: Refuse Playwright one-shot routes in the required typecheck job
kind: experiment
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
prs: [2057]
hypothesis:
  metric: gate.wf.browser-test.browser-shard.failure_rate@merge_group
  slo: queue-green
  baseline: 0.057
  baseline_source: 'origin/ci-steward-data snapshots 2026-09-12..2026-09-22 (the collected days in the 14 before latest.json of 2026-09-23T09:51Z), wf.browser-test.browser-shard@merge_group: 56 failures of 980 completed, non-cancelled runs.'
  target: 0.05
  after_days: 28
ratchet-release: []
field-changes: []
---

## Why

PR #1999 found that after a Playwright `page.route(url, handler, { times: 1 })`
failure route had run, the page's retry against the same URL could hang
without ever reaching the server, and the test sat out its timeout. DOR-2228
audited every `times:` site in `apps/e2e` and `apps/community/browser-tests`.
All seven had the same shape (a failure route, then a retry against the same
URL), and a probe showed a later matching request at every one. They now use
`interceptNext` from `@dorkos/test-utils/playwright-routes`, which never
retires its route.

## What changed

`pnpm run check:one-shot-routes` (`scripts/check-one-shot-routes.ts`) is a new
step in the required `typecheck` job. It fails on any unmarked `times:` line
under `apps/e2e`, `apps/community/browser-tests` and
`apps/community/acceptance`. It lives in `typecheck` for the reason the vocab
gate moved there in DOR-1814: its pin suite runs only in scripts-test.yml's
`harness` job, which is scoped away from these folders and never runs in the
queue, so it would never run on the PRs it exists for.

## Reading the verdict honestly

This is a guard against a regression coming back, so most of its value is a
hang that never lands. The replacements, not the guard, removed the existing
exposure, and they land in the same PR, so any drop in the after-window
belongs to both. The browser-shard failure rate is noisy: 2026-09-04/05 alone
had 71 failures from unrelated causes. A `verified` here is weak evidence, and
a `failed` says only that other failures dominate, not that the guard failed.
The guard's own signal is `gate.wf.typecheck.typecheck.real_catches`: a queue
ejection it causes should only ever be a real `times:` line.

## Cost, and what would make us revert

One `git ls-files` and a line scan of about 200 files: under two seconds in a
job whose merge-queue p50 is about 5.4 minutes (snapshot 2026-09-22). Revert,
or move the check, if it causes a queue ejection on a line that was not a
route option, or if a `times:` hang reaches `main` anyway through a form the
line scan cannot see (`{ times }` shorthand, options built elsewhere).
