---
id: 261124-012610
title: The queue skips lint, credential-free-build, openapi-fresh and fixtures when the PR head already passed them
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.lint.lint
  - wf.lint.attest
  - wf.credential-free-build.credential-free-build
  - wf.credential-free-build.attest
  - wf.docs-openapi-check.openapi-fresh
  - wf.docs-openapi-check.attest
  - wf.scripts-test.fixtures
  - wf.scripts-test.attest
prs: []
ratchet-release: []
field-changes: []
---

DOR-5130 step 1, agreed between ci-steward and an adversarial reviewer (plan:
docs/plan-ci-efficiency.md in ci-steward's folder; Dorian approved the affected-only queue on Nov 24).
In the week of Nov 16-22 these four required checks caught no real failure in 457 queue builds, yet
ran a full job per queue entry (lint 4,251, credential-free-build 4,389, openapi-fresh 1,969,
fixtures 979 runner-minutes) and credential-free-build alone ejected 10 queue builds on flakes.

In a merge group each workflow now runs a small `attest` job (scripts/attest-pr-check.sh, from
main): when the same context succeeded, from GitHub Actions, on the entry PR's current head, the
heavy job is skipped and reports success. Any doubt runs the real check; a failed attest job fails
the check closed. typecheck and db-check stay in the queue. Backstop: lint, credential-free-build and
docs-openapi-check now also run on push to main (scripts-test already did), and after-merge-alert
and auto-revert watch them.

Baseline: ~11,600 queue runner-minutes a week on these four; 10 credential-free-build-only red
queue builds a week.
Target: under 1,000 queue runner-minutes a week on them, and no queue build ejected by them.
Evaluate: Dec 1.

Revert if a break these checks would have caught in the queue reaches main more than once a week.
