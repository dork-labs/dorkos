---
id: 261112-220224
title: The scripts list guard runs in the merge queue
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
  - wf.scripts-test.harness
prs: []
hypothesis:
  metric: gate.wf.scripts-test.harness.failure_rate
  slo: main-green
  baseline: 0.1746
  baseline_source: 'Same baseline as ledger 261112-185148 (snapshots 2026-11-05..11-11, 44 / 252); that entry has not reached its after-window, and this closes a hole in it.'
  target: 0.05
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4224. Ledger 261112-185148 (#3659) put the repo-wide `scripts/` suites
into the required `typecheck` job. But it filed the guard that makes every
suite pick a list, `repo-wide-suites.test.ts`, as hermetic, so it ran only in
`harness`, which the queue skips. #3640 and #3660 then merged new suites that
were on neither list, and main's `harness` went red (fixed by #3664).

Change: the guard moves to `REPO_WIDE_SUITES`, so `typecheck` runs it on every
PR and queue build. It reads only `scripts/` and `typecheck.yml`. A new case
asserts the guard is on that list; moving it back edits `scripts/`, which runs
`harness`, so that PR goes red.

Proof: with a planted unlisted suite, the queue config was green before (28
files) and red after, naming the plant. With #3664's two entries removed (main
before #3664), the queue run goes red naming `check-own-mocks.test.ts` and
`playwright-apt-debs.test.ts`. With them in, 29 files pass. One more file adds
well under a second. No trigger, timeout, retry or required context changes.
Revert if the guard proves flaky in the queue.
