---
id: 261124-151529
title: Shell fixture suites are found by glob, so adding one touches no shared list
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.scripts-test.fixtures
  - wf.scripts-test.harness
prs: []
ratchet-release: []
field-changes: []
---

Adding a `scripts/test-*.sh` suite meant a step in `scripts-test.yml` and a line in
`scripts/run-scripts-suites.sh` (ledger `261124-003000`), both at the end of the list. Two PRs
adding suites at once conflicted there, the queue ejected them, and each needed a manual merge of
main (#4206 vs #4258 on Nov 24, and others). In the 7 days to Nov 24, 23 commits on main touched
`scripts-test.yml` and 36 touched the runner or the root package.json.

Now `run-scripts-suites.sh` globs `scripts/test-*.sh` and `.agents/skills/*/scripts/test-*.sh`
(68 suites before and after, the same set). `fixtures` runs `--suites fixtures` in one step and
`harness` runs `--suites harness` for the six suites that declare `# scripts-suite-lane: harness`.
Each suite gets its own `::group::`, a failure gets an error annotation naming it, and the step
fails at the end listing every failing suite, or when the glob finds none. The parity test now
fails on any step or line that names a suite by hand. The suites still run one after another, so
`fixtures` takes the same time (about 4 minutes on main, nearly 2 of them the heavy-run-lock suite).

Baseline: every PR adding a suite edits both lists; at least one conflict ejection a day on Nov 23
and 24. Target: a PR adding a suite edits neither file, and no queue ejection is caused by a
conflict in either file. `fixtures` p95 stays within 10% of today's.
Evaluate: Dec 1.

Revert if a suite on disk stops running in CI, or if a failing suite is harder to find in the log
than it was as its own step.
