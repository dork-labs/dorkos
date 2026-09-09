# Implementation Summary: Bound hosted notification intake and backlog

**Created:** 2026-09-08
**Last Updated:** 2026-09-08
**Spec:** specs/hosted-notification-intake-bounds/02-specification.md

## Progress

**Status:** Verification
**Tasks Completed:** 4 / 5

The implementation and focused adversarial review are complete. Final completion remains gated on verification against the merged prerequisite, the normal repository and site build gates, publication review, and merge.

## Work Completed So Far

### Session 1 - 2026-09-08

**Workers:** `/root/connections_local_ui_impl` (sole implementation author)

- Added the tenant capacity schema, append-only migration/backfill, controlled cutover verifier, fixed limits, and tenant-creation ledger write.
- Added capacity-first locking to subscription authority, event discovery, webhook intake, pull, acknowledgement, retention, and physical-trigger cleanup paths.
- Added duplicate-before-charge admission, complete fan-out enforcement, row/byte/rate ceilings, generic overload responses, atomic ledger updates, and exact-byte release.
- Replaced per-row global retention with bounded set-based tenant pages, fair scheduling, monotonic request budgets, transaction-local timeouts, hourly cron execution, and exact-tenant opportunistic maintenance.
- Added source, migration, production-driver, concurrency-model, route, rollback, fairness, and operations evidence. The deterministic lock model and emitted production SQL are intentionally separate from PGlite behavior.

## Files Modified/Created

The candidate changes site schema/migration files, managed connection authority and event services/routes, focused tests, the shared rejection schema, the hourly schedule, operations guidance, one ADR, one changelog fragment, and this specification package. The frozen source manifest is authoritative for the exact path list and hashes.

## Verification Status

- Drizzle generation completed, and the generated migration includes the reviewed fail-closed data backfill.
- The author focused cohort passed 153 tests. Independent review passed 71 focused migration, capacity, production transaction, service, and public-route tests.
- Five targeted mutants failed the intended terminal settlement, ownership, scope, recovery, and final-byte assertions; the exact source was restored and the controls passed.
- The shared build, site and shared typechecks, and scoped lint passed. PGlite remains serialized fixture evidence; the deterministic interleaving model and emitted Neon Pool SQL cover the production locking contract without claiming a real PostgreSQL contention run.
- Verification against merged prerequisite `1b2829d680193c1c86b49f29b060e7e027fe48f5`, the normal repository gate, the site build, publication review, and merge remain pending.

## Known Limits

- A local real PostgreSQL contention service is unavailable: `initdb`, `pg_ctl`, and `psql` are absent, and the Docker daemon is unavailable. PGlite is labeled as serialized SQL/transaction evidence. The candidate instead combines a deterministic two-transaction lock model that fails when `FOR UPDATE` is removed with a production Neon Pool SQL/transaction assertion. It does not claim real Postgres lock-contention proof.
- Managed-event readiness and live provider delivery remain outside this work item. No live load test or real provider action is part of DOR-1909.

## Implementation Notes

- Worktree: `/Users/doriancollier/.dork/workspaces/dorkos/codex-hosted-notification-bounds-design`
- Branch: `codex/hosted-notification-bounds-design`
- Original implementation base: `f3af957b258a356148e81b5c533cf45943c2a7eb`
- Integrated prerequisite base: `1b2829d680193c1c86b49f29b060e7e027fe48f5`
- Design checkpoint 3 passed independent review before execution.
- Source and focused fixture review passed at checkpoint 6. The prerequisite integration and final publication gates remain under review.
- DOR-1909 will hand its frozen proof to DOR-1905 after merge; it does not close the still-pending deployment, live provider event, DOR-1905 security verification, or P7 acceptance gates.
