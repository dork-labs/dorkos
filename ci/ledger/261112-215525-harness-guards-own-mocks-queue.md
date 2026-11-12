---
id: 261112-215525
title: check-own-mocks and playwright-apt-debs run in the merge queue
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
  - wf.scripts-test.harness
prs: []
ratchet-release: []
field-changes: []
---

Follow-up to `261112-185148`. Two suites landed just after it and were on neither of its lists, so only `scripts-test / harness` ran them, and harness does not run in the merge queue. `main` went red on harness from 4485b06f (#3640) on: the own-mocks ratchet's own test (`check-own-mocks.test.ts`, which its ledger `261111-184639` said ran on every queue build) found `apps/server` 5 over its baseline (#3623 +2, #3624 +2, #3652 +1, merged between #3640's base and its merge) and `apps/client` 1 under (#3638), and `pre-push-format-gate.test.ts` still pinned four pre-push commands after #3640 added `own-mocks`. #3640's own PR run of harness was red; it was not required.

Both suites now go on `REPO_WIDE_SUITES` (each reads files outside `scripts/`: the whole tree, `.github/workflows/browser-test.yml`), so required `typecheck` runs them on `merge_group`. The baseline matches the tree (client 1519, server 2617), and the pre-push test pins five commands. Nothing measurable should move beyond `typecheck`'s scripts step taking a second or two longer.

Revert the list change if it pushes `typecheck` over its timeout; the baseline raise is a one-off for mocks that merged before the ratchet ever ran in CI, not a precedent.
