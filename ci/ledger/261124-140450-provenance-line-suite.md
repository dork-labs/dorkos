---
id: 261124-140450
title: The provenance CLI and its repo-wide suite
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
prs: []
ratchet-release: []
field-changes: []
---

DOR-5047: `scripts/provenance/provenance-line.ts` builds and reads the provenance v2 line for
shell callers through `@dorkos/shared/provenance`. No workflow or hook runs it yet; a later PR
switches `scripts/open-pr.sh` to it.

Its suite imports `packages/shared/src/provenance.ts`, so it goes on `REPO_WIDE_SUITES` in
`scripts/vitest.repo.config.ts` (a change in `packages/shared` can turn it red from outside
`scripts/`). `scripts/tsconfig.json` now typechecks `scripts/provenance`. No gate's retries,
shards, timeout or required status changes, and no metric should move, so this is hygiene.
Revert the list entry if it makes `typecheck` slow or flaky; the suite runs in well under a
second.
