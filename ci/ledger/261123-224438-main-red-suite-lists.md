---
id: 261123-224438
title: Fix main's red fixtures and harness checks by listing not-held and build-cache-workflow
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Two required checks went red on main at 22:29 (first at `79c234fdb0`), and every PR and queue
entry after it inherited the red.

- `fixtures`: #4172 made `not-held` required. It re-runs on label events, so it cannot date a
  Security label, but it was missing from `LABEL_RERUN_CONTEXTS` in
  `.github/scripts/security-required-checks.mjs`. That file's own drift test caught it.
- `harness`: #4168 added `scripts/__tests__/build-cache-workflow.test.ts` without listing it in
  `scripts/vitest.repo.config.ts`. It reads `.github/workflows/`, so it is repo-wide.

Two list entries, no behavior change beyond the gate reading `not-held` the way it already reads
the other label re-runs. Nothing measurable should move, so this is hygiene. Revert if either drift
test turns out to be wrong about the list it guards.
