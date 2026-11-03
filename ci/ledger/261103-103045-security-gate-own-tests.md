---
id: 261103-103045
title: A gate PR's own tests run in the required fixtures job, and the gate doc says how to recover from a bad gate
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.scripts-test.fixtures
  - wf.security-gate.security-gate
prs: []
ratchet-release: []
field-changes: []
---

## Why

`security-gate.yml` checks out the base, so a gate PR's own tests ran in no CI job. A bad gate could merge green, and the PR that fixes it is judged by the bad script. Both have to be settled before `security-gate` is required.

## What changes

- `fixtures`, already required, runs `node --test .github/scripts/security-*.test.mjs` on the PR's own code.
- `ci/security-gate-promotion.md` says who can clear a wedged gate, what it takes, and how it's recorded.

## Hypothesis

Nothing measurable moves. Revert the step if it adds real time to `fixtures` or fails on the runner's checkout for reasons unrelated to the gate.
