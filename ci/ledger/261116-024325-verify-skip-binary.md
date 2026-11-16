---
id: 261116-024325
title: pnpm verify leaves host-binary tests to CI
kind: experiment
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: tracked.verify-proof-share
  baseline: 0.21
  baseline_source: 'coordinator count in the DOR-4501 brief for 2026-11-15, the first day of verify proofs (DOR-4456): 3 of about 14 PRs earned a recorded pnpm verify pass'
  target: 0.8
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-4501. `pnpm verify` ran the real-CLI suites (`*.binary.test.ts`), which spawn
whatever Codex binary this computer has installed. On Nov 15 three
app-server.binary.test.ts tests failed only on the operator machine and blocked a
proof for a branch that never touched Codex. CI runs those suites in codex-sandbox,
so the local result said nothing about the branch.

The change: the verify wrapper reads `scripts/ci/binary-test-glob.txt` and passes
each glob to vitest as `--exclude`, and the proof records the list as `excluded`.
Typecheck and lint still cover the files. A drift test holds the file equal to the
binary-test `--exclude` on every shard line of test.yml, so the local gate skips
exactly what CI runs elsewhere. No workflow, required check or CI retry changes.

Hypothesis: with no host-only failure in the way, most armed PRs carry a proof:
`tracked.verify-proof-share` from 0.21 to 0.8 within 7 days. Hand-audited.

Revert if a binary-suite regression reaches main that a local run would have
caught, or if the share does not move (then local failures were not the cause).
