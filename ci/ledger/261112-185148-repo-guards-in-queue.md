---
id: 261112-185148
title: Repo-wide guard tests run in the merge queue
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
  baseline_source: 'origin/ci-steward-data snapshots/2026-11-05..2026-11-11.json, gate wf.scripts-test.harness: push 9 failed / 55 completed, pull_request 35 / 197 (44 / 252); merge_group 167 skipped. QA report evidence/ci-shared-cause-nov13 (cluster C3: 31 failed jobs, 3 red-main spells).'
  target: 0.05
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4222. The `scripts` vitest project runs only in `scripts-test / harness`. That job is
scoped to `scripts/**` and friends on a pull request and skipped in the merge
queue. 26 of its suites also read state anywhere in the tree (censuses,
allowlists, workflow pins, `git ls-files` sweeps). So a PR outside the scope
broke one, merged, and every later `scripts/` PR failed until a follow-up
landed: #3528 (fixed by #3545), #3568 (#3586), #3564/#3569 (#3603).

Change: `scripts/vitest.repo.config.ts` lists those 26 suites, and a new step
in the required `typecheck` job runs them on every pull request and queue
build. A break now ejects the PR that caused it. Every scripts suite must sit
on exactly one of the repo-wide or hermetic lists
(`scripts/__tests__/repo-wide-suites.test.ts`). `typecheck.yml` joins the
harness scope so a PR that drops the step runs that pin. No required context,
trigger, timeout or retry changes.

Proof: run on today's tree, the pre-fix copies of the three guards go red the
way main did: `code-only.test.ts` before #3586 names
`overlay-no-drag.test.tsx`; today's `code-only.test.ts` names a planted copy of
`turn-context-privacy.test.ts` from before #3603; `credential-free-workflow`
before #3545 fails its pnpm-store pin on `browser-test.yml`.

Metric caveat: harness failure_rate also counts real `scripts/` defects on PRs,
so read the push leg beside it; target there is 0 red pushes. Also watch
`gate.wf.typecheck.typecheck.duration_p90`: the step should add about a minute.
On the first CI run it took 41 s with one worker per core, and two whole-repo
scans timed out (26.6 s and 34 s against 20 s and 30 s limits; 3.7 s and 5.6 s
locally). The config now runs two workers with a 120 s test limit, and those
two scans raised their own in-file limits to 120 s. Cost stays about a minute.
Revert if typecheck's p90 grows by more than 2 minutes, or if a repo-wide suite
proves flaky in the queue (fix it or move it to harness, do not retry).
