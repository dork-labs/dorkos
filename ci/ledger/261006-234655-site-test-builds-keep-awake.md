---
id: 261006-234655
title: Build keep-awake before the site's tests that import the server
kind: hygiene
status: proposed
actor: agent
gates: []
prs: [2621]
ratchet-release: []
field-changes: []
---

The site's `managed-mounted-isolation.integration.test.ts` imports server source, which since #2592 (DOR-2718) imports `@dorkos/keep-awake`. That package resolves to `dist/` at runtime, and `@dorkos/site#test` did not depend on its build. A full run builds everything, so the merge queue and `main` stayed green, but any PR whose affected set includes the site failed this test every time with "Failed to resolve entry for package @dorkos/keep-awake" (PR #2621, run 37547213158, failed twice on the same head).

The change adds `@dorkos/keep-awake#build` to `@dorkos/site#test`'s `dependsOn`, beside the `@dorkos/relay` and `@dorkos/extension-api` builds already there for the same reason. No gate, retry, timeout or required check changes. Revert if the site's affected test leg gets slower by more than the package's few-second `tsc` build.
