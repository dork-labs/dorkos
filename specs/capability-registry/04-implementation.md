# Implementation: Capability Registry (program phase 2)

- **Completed:** 2026-07-23
- **Tasks:** 6/6 (DOR-440..445), all merged
- **PRs:** #436 (registry core + shared catalog types), #437 (operator + marketplace migration, hand tables deleted, derived carve-out), #438 (self-description: `/api/capabilities/catalog`, `list_capabilities`, `dorkos capabilities`, MCP resource; single boot registry), #439 (OpenAPI projection with collision guard), #440 (`POST /api/capabilities/:id/invoke` + `dorkos call`), #441 (capabilityConformance suite + discovery eval + docs rewrite)
- **ADRs:** 260723-050219 (one boot-composed registry), 260723-050220 (invoke endpoint auth posture); discharges the interim in 260723-013233

## Deltas from the spec

- Catalog route is `/api/capabilities/catalog` (errata in 02-specification: bare path was a live client contract).
- CLI verbs largely stay on their curated routes (frozen `--json` contracts vs capability shapes); `dorkos call` is the capability-shaped path. `operator.activity_list` is capability-bound via its http surface.
- Output schemas mostly remain `z.unknown()` (tightening tracked per-capability; `capabilities.list` sets the precedent with a full catalog schema).
- OpenAPI projects 2 paths now (activity, catalog); 5 operator capabilities skipped for documented capability-vs-route shape mismatches (domain-by-domain migration follow-up).

## Verification

Conformance suite runs per-PR against the real registry (23 assertions; falsifiability proven by 8 seeded-drift tests). Full server suite verified green (5,294 tests) during DOR-442 review. Discovery eval (`capability-discovery`) quarantined pending a credentialed claude-code-cheap run, alongside the four phase-1 operate-DorkOS cases.

## Open follow-ups (tracked)

- Promote the 5 quarantined evals after a credentialed run.
- Legacy OpenAPI hand-registrations migrate domain-by-domain; reverse-direction collision assertion.
- `CLI_VERBS` conformance fixture becomes derived once capabilities declare `cli` surfaces.
- Fragment-gate vs curation reconciliation (workflow hygiene, hit 5+ times across the program).
