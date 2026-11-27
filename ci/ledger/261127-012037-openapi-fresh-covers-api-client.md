---
id: 261127-012037
title: openapi-fresh also fails when the generated API client is stale
kind: experiment
status: proposed
actor: agent
gates: [wf.docs-openapi-check.openapi-fresh]
prs: []
hypothesis:
  metric: 'gate.wf.docs-openapi-check.openapi-fresh.duration_p90@pull_request'
  baseline: 5.1
  baseline_source: 'GitHub API, the newest 100 successful pull_request runs of docs-openapi-check.yml (2026-11-26T03:14Z to 2026-11-27T01:12Z), run wall time: p50 4.1 min, p90 5.1 min. The newest 40 push-to-main runs, which always regenerate, read p50 4.6, p90 5.2.'
  target: 5.4
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4981. `packages/api-client` (`@dorkos/api-client`) is generated from
`docs/api/openapi.json`: `src/generated/openapi.ts` (types, from
openapi-typescript) and `src/generated/operation-routes.ts` (each operationId's
method and path). Both are committed. `pnpm docs:export-api` now runs
`pnpm api-client:generate` after it writes the spec, so the existing
"Regenerate OpenAPI spec" step writes the client too, and the existing
"Fail if generated API docs are out of date" step now adds and diffs
`packages/api-client/src/generated` beside `docs/api`. The pull-request scope
step also runs the regeneration when the generator
(`packages/api-client/scripts/`) or its output changes. No step, job, trigger
or required check is added or renamed, so the census allowlist is unchanged.

Measured locally on 2026-11-27: `pnpm api-client:generate` takes about 2 s.

Hypothesis, as a guard: the job's pull-request p90 should not move past noise
and must stay at or under 5.4 min. Revert or rework if it passes that, or if
the check goes red on a tree whose client was regenerated and committed (the
generator would then not be deterministic across machines).
