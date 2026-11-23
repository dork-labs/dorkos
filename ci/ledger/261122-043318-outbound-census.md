---
id: 261122-043318
title: The outbound-destination census runs in the merge queue
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
prs: []
hypothesis:
  metric: gate.wf.typecheck.typecheck.duration_p90
  baseline: 625
  baseline_source: 'origin/ci-steward-data snapshots/2026-11-20.json, gate wf.typecheck.typecheck@pull_request: p90 of 100 completed runs = 625 s (merge_group: 620 s over 69).'
  target: 645
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4990. `scripts/__tests__/outbound-census.test.ts` fails when a file in the
shipped product reaches the network without an entry in
`scripts/outbound-census/census.json`, so the `DO_NOT_TRACK` promise in the docs
stays checkable. As a plain `scripts` suite it ran only in `scripts-test /
harness`, which is scoped to `scripts/**` on a pull request and skipped in the
queue. So a PR adding a `fetch` under `apps/server` would merge green.

Change: the census joins `REPO_WIDE_SUITES` in `scripts/vitest.repo.config.ts`.
The required `typecheck` job already runs that config on every pull request and
queue build ("Repo-wide scripts suites"), so an unlisted sender now ejects the
PR that adds it. No workflow, required context, trigger, timeout or retry
changes.

Proof: a scratch sender planted under `packages/relay/src/` fails the suite
run through `scripts/vitest.repo.config.ts`, naming the file.

The hypothesis guards cost, not effect: the scan parses about 4,000 files in
roughly 4 s locally, so typecheck's p90 should stay within 20 s of today's.
Revert (move the suite to `HERMETIC_SUITES`) if typecheck's p90 grows by more
than a minute, or if the suite proves flaky in the queue.
