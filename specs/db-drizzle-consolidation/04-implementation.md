# Implementation Summary: Database Consolidation — Single DB, packages/db, Drizzle ORM

**Created:** 2026-02-26
**Last Updated:** 2026-02-26
**Spec:** specs/db-drizzle-consolidation/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 18 / 18

## Tasks Completed

### Session 1 - 2026-02-26

- Task #1: [P1] Scaffold packages/db workspace package
- Task #12: [P4] Extract computeHealthStatus to portable TypeScript helper
- Task #2: [P1] Define Drizzle schema files for all tables
- Task #3: [P1] Implement createDb, runMigrations, and generate initial migration
- Task #4: [P1] Write migration smoke tests and createTestDb helper
- Task #5: [P1] Install lefthook and configure pre-commit migration enforcement
- Task #6: [P2] Wire createDb and runMigrations into server startup

## Files Modified/Created

**Source files:**

- `packages/db/package.json` — New workspace package (@dorkos/db)
- `packages/db/tsconfig.json` — TypeScript config (bundler resolution for drizzle-kit compat)
- `packages/db/drizzle.config.ts` — Drizzle kit config (explicit schema file array, sqlite dialect)
- `packages/db/vitest.config.ts` — Vitest config for db package
- `packages/db/src/index.ts` — createDb(), runMigrations(), Db type, schema re-exports
- `packages/db/src/schema/index.ts` — Schema barrel re-exports
- `packages/db/src/schema/pulse.ts` — pulseSchedules and pulseRuns tables
- `packages/db/src/schema/relay.ts` — relayIndex and relayTraces tables
- `packages/db/src/schema/mesh.ts` — agents, agentDenials, rateLimitBuckets tables
- `packages/db/drizzle/0000_magenta_gladiator.sql` — Initial migration (7 CREATE TABLE)
- `packages/db/drizzle/meta/_journal.json` — Migration journal
- `packages/mesh/src/health.ts` — computeHealthStatus() TypeScript helper
- `packages/mesh/src/index.ts` — Added health export
- `packages/test-utils/src/db.ts` — createTestDb() helper
- `packages/test-utils/src/index.ts` — Added db re-export
- `packages/test-utils/package.json` — Added @dorkos/db dependency
- `package.json` (root) — Added drizzle-orm, lefthook dependencies + prepare script
- `lefthook.yml` — Pre-commit hook for db migration enforcement
- `turbo.json` — Added db:generate and db:check tasks
- `vitest.workspace.ts` — Added packages/db
- `apps/server/src/index.ts` — Wired createDb/runMigrations before service init
- `apps/server/package.json` — Added @dorkos/db dependency

**Test files:**

- `packages/mesh/src/__tests__/health.test.ts` — 7 tests for computeHealthStatus
- `packages/db/src/__tests__/migrations.test.ts` — 8 migration smoke tests

## Known Issues

- **`.js` extension tension**: drizzle-kit uses CJS require() (can't resolve .js → .ts), while server uses NodeNext (requires .js). Resolved by using explicit schema file array in drizzle.config.ts and .js extensions in source for NodeNext compat.

## Implementation Notes

### Session 1

- Batch 1 (Tasks #1, #12): Foundation scaffold + health helper
- Batch 2 (Task #2): Drizzle schema definitions for all 7 tables
- Batch 3 (Task #3): createDb/runMigrations factory, initial migration SQL generated
- Batch 4 (Tasks #4, #5, #6): Smoke tests, lefthook pre-commit, server wiring
  - Reconciled .js extension conflict between parallel agents (drizzle.config.ts now uses explicit file array)
- Batch 5 (Tasks #7, #9, #10, #13): Full store rewrites — PulseStore, SqliteIndex, TraceStore, AgentRegistry
  - PulseStore: Added 3 schema columns (enabled, maxRuntime, permissionMode), generated migration 0001
  - SqliteIndex: Status mapping new→pending, cur→delivered; ttl→expiresAt
  - TraceStore: INTEGER Unix ms → ISO 8601 TEXT timestamps; added drizzle-orm re-exports from @dorkos/db
  - AgentRegistry: Removed manifest_json, PRAGMA migrations, julianday(); uses computeHealthStatus()
- Batch 6 (Tasks #8, #11, #14): Test updates + DenialList/BudgetMapper Drizzle rewrite
  - Fixed FK violations in scheduler tests (hardcoded schedule IDs)
  - Added 9 anti-regression tests for semantic status values and ISO timestamps
  - DenialList/BudgetMapper fully converted to Drizzle; composite unique index migration 0002
- Batch 7 (Tasks #15, #16, #17): Anti-regression tests, CLI build, dependency cleanup
  - 4 mesh anti-regression tests (no manifest_json, TypeScript health, ULIDs, ISO timestamps)
  - CLI build copies drizzle/ to dist/drizzle/
  - Fixed cyclic dependency: relay ↔ test-utils (moved relay type import to peerDep)
  - Removed stale better-sqlite3 from relay/mesh; pnpm typecheck passes (14/14)
- Batch 8 (Task #18): Full verification
  - Typecheck: 14/14 pass
  - Tests: all pass (631 server + 268 relay + 92 mesh + 8 db + client cached)
  - Lint: 0 errors
  - Fixed 3 stale test files (pulse routes, env defaults, mcp-tool-server port)
  - Zero PRAGMA user_version, zero better-sqlite3 in relay/mesh source
  - 3 migrations present: 0000 (initial), 0001 (pulse columns), 0002 (rate limit index)

## Files Modified/Created (Sessions 1-2)

**Source files (additional):**

- `apps/server/src/services/pulse/pulse-store.ts` — Full Drizzle rewrite (Db constructor, ULID IDs, ISO timestamps)
- `packages/relay/src/sqlite-index.ts` — Full Drizzle rewrite (pending/delivered status, expiresAt)
- `apps/server/src/services/relay/trace-store.ts` — Full Drizzle rewrite (ISO timestamps)
- `packages/mesh/src/agent-registry.ts` — Full Drizzle rewrite (no manifest_json, TypeScript health)
- `packages/mesh/src/denial-list.ts` — Full Drizzle rewrite (Db constructor, ULID IDs)
- `packages/mesh/src/budget-mapper.ts` — Full Drizzle rewrite (Db constructor, onConflictDoUpdate)
- `packages/mesh/src/mesh-core.ts` — Accepts Db instead of dataDir
- `packages/relay/src/relay-core.ts` — Optional Db parameter with backward compat
- `packages/db/drizzle/0001_messy_vin_gonzales.sql` — Pulse schema additions
- `packages/db/drizzle/0002_cloudy_trish_tilby.sql` — Rate limit composite unique index
- `packages/cli/scripts/build.ts` — Migration copy step (cpSync to dist/drizzle/)
- `packages/relay/package.json` — Removed better-sqlite3, added @dorkos/db
- `packages/mesh/package.json` — Removed better-sqlite3, added @dorkos/db
- `packages/test-utils/package.json` — Moved @dorkos/relay to peerDependencies

**Test files (additional):**

- `apps/server/src/services/pulse/__tests__/pulse-store.test.ts` — Uses createTestDb, ULID+ISO anti-regression
- `apps/server/src/services/pulse/__tests__/scheduler-service.test.ts` — Uses createTestDb, fixed FK constraint
- `apps/server/src/routes/__tests__/pulse.test.ts` — Uses createTestDb, fixed FK constraint
- `packages/relay/src/__tests__/sqlite-index.test.ts` — 6 anti-regression tests (status values, expiresAt)
- `apps/server/src/services/relay/__tests__/trace-store.test.ts` — 3 anti-regression tests (ISO timestamps)
- `packages/mesh/src/__tests__/agent-registry.test.ts` — 4 anti-regression tests (no manifest_json, health, ULID, ISO)
- `packages/mesh/src/__tests__/denial-list.test.ts` — Uses createTestDb
- `packages/mesh/src/__tests__/budget-mapper.test.ts` — Uses createTestDb
- `packages/mesh/src/__tests__/mesh-core.test.ts` — Uses createTestDb
- `packages/mesh/src/__tests__/relay-integration.test.ts` — Uses createTestDb
