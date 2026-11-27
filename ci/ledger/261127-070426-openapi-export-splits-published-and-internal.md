---
id: 261127-070426
title: The API export writes a published document and an internal one
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4983 (A6). `scripts/export-openapi.ts` now writes two files: the published
`docs/api/openapi.json` (no `internal` operations) and
`docs/api/openapi-internal.json` (the internal operations and the components
only they use). The generated client and api-lint read both together.
`openapi-fresh` already diffs all of `docs/api`, so it checks both without a
workflow change. No job, step, trigger or timing changes, so nothing
measurable should move. Revert if `openapi-fresh` starts passing while a
committed file is stale.
