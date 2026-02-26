# Database Consolidation — Task Breakdown

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-02-26
**Mode:** Full decomposition

---

## Summary

| Phase | Name | Tasks | Sizes |
|-------|------|-------|-------|
| 1 | Foundation — packages/db | 5 | 2S, 3M |
| 2 | Migrate Pulse | 3 | 1S, 1M, 1L |
| 3 | Migrate Relay | 3 | 1M, 1L, 1M |
| 4 | Migrate Mesh | 4 | 1S, 1L, 2M |
| 5 | CLI Bundle and Cleanup | 3 | 2S, 1M |
| **Total** | | **18** | **5S, 8M, 3L** |

---

## Phase 1 — Foundation (`packages/db`)

### 1.1 Scaffold packages/db workspace package (S)
- Create `package.json` with `@dorkos/db` name, JIT exports, scripts (`db:generate`, `db:check`, `typecheck`)
- Create `tsconfig.json` extending `@dorkos/typescript-config/base`
- Create `drizzle.config.ts` with sqlite dialect and better-sqlite3 driver
- Add `drizzle-orm` to root `package.json` for monorepo deduplication
- Run `pnpm install` to link the new workspace

### 1.2 Define Drizzle schema files for all tables (M)
**Depends on:** 1.1

- Create `schema/pulse.ts` — `pulse_schedules` and `pulse_runs` tables
- Create `schema/relay.ts` — `relay_index` and `relay_traces` tables
- Create `schema/mesh.ts` — `agents`, `agent_denials`, and `rate_limit_buckets` tables
- Create `schema/index.ts` — barrel re-export
- Key changes from old schemas:
  - All IDs → ULID (was UUID in Pulse)
  - All timestamps → ISO 8601 TEXT (was INTEGER Unix ms in relay_traces)
  - relay_index status → `pending`/`delivered`/`failed` (was `new`/`cur`/`failed`)
  - relay_index `expires_at` TEXT replaces `ttl` INTEGER
  - agents drops `manifest_json` (redundant)
  - pulse_runs renames `output_summary` to `output`

### 1.3 Implement createDb, runMigrations, and generate initial migration (M)
**Depends on:** 1.2

- Create `src/index.ts` with `createDb()` (WAL, FK ON, 5s busy timeout) and `runMigrations()`
- Export `Db` type and all schema re-exports
- Run `drizzle-kit generate` to produce `0000_initial.sql`
- Commit `drizzle/` directory to git

### 1.4 Write migration smoke tests and createTestDb helper (M)
**Depends on:** 1.3

- Create `packages/db/src/__tests__/migrations.test.ts` (all 7 tables created, idempotent, FK enforced)
- Create `packages/test-utils/src/db.ts` with `createTestDb()` helper (`:memory:` + migrations)
- Re-export from `packages/test-utils/src/index.ts`

### 1.5 Install lefthook and configure pre-commit migration enforcement (S)
**Depends on:** 1.3 | **Parallel with:** 1.4

- Install `lefthook` as root devDependency
- Add `prepare: lefthook install` to root `package.json`
- Create `lefthook.yml` with `db-migrations` pre-commit command (glob: `packages/db/src/schema/*.ts`)
- Add `db:generate` and `db:check` Turbo tasks to `turbo.json`

---

## Phase 2 — Migrate Pulse

### 2.1 Wire createDb and runMigrations into server startup (S)
**Depends on:** 1.3

- Add `@dorkos/db` dependency to `apps/server/package.json`
- In `start()`, call `createDb(path.join(dorkHome, 'dork.db'))` and `runMigrations(db)` before service instantiation
- Log migration status and legacy database preservation messages
- Verify `~/.dork/dork.db` is created on first server start

### 2.2 Rewrite PulseStore to use Drizzle ORM (L)
**Depends on:** 2.1

- Change constructor: `PulseStore(dorkHome: string)` → `PulseStore(db: Db)`
- Remove `better-sqlite3` import, `crypto.randomUUID()`, `schedules.json` I/O
- Replace all 9 prepared statements with Drizzle query builders
- Use `ulid()` for ID generation, ISO 8601 for timestamps
- Update server `index.ts` to pass `db` to `new PulseStore(db)`

### 2.3 Update Pulse tests to use createTestDb (M)
**Depends on:** 2.2, 1.4

- Replace tmpdir-based test setup with `createTestDb()`
- Add anti-regression: ULID pattern test (no UUID hyphens)
- Add anti-regression: `crypto.randomUUID` spy test
- Add anti-regression: ISO 8601 timestamp format test

---

## Phase 3 — Migrate Relay

### 3.1 Rewrite SqliteIndex to use Drizzle ORM (L)
**Depends on:** 2.1

- Add `@dorkos/db` dependency to `packages/relay/package.json`
- Change constructor: `SqliteIndex(options)` → `SqliteIndex(db: Db)`
- Replace 13 prepared statements with Drizzle queries
- Map status: `'new'` → `'pending'`, `'cur'` → `'delivered'`
- Replace `ttl` INTEGER with `expiresAt` TEXT
- Remove PRAGMA user_version migration chain
- Update `RelayCore` to pass `db` to SqliteIndex

### 3.2 Rewrite TraceStore to use Drizzle ORM (M)
**Depends on:** 2.1 | **Parallel with:** 3.1

- Change constructor: `TraceStore(options)` → `TraceStore(db: Db)`
- Replace prepared statements with Drizzle queries
- Convert timestamps: INTEGER Unix ms → ISO 8601 TEXT
- Remove `CREATE TABLE IF NOT EXISTS` migration
- Update server `index.ts` to pass `db` to TraceStore

### 3.3 Update Relay tests and add anti-regression tests (M)
**Depends on:** 3.1, 3.2, 1.4

- Replace tmpdir-based test setup with `createTestDb()`
- Update assertions: `'new'` → `'pending'`, `'cur'` → `'delivered'`, `ttl` → `expiresAt`
- Add anti-regression: ISO 8601 timestamp in relay_traces
- Add anti-regression: semantic status values in relay_index

---

## Phase 4 — Migrate Mesh

### 4.1 Extract computeHealthStatus to portable TypeScript helper (S)
**Depends on:** none | **Parallel with:** 3.1, 3.2, 2.2

- Create `packages/mesh/src/health.ts` with pure TypeScript health computation
- Thresholds: < 5min = active, 5-30min = inactive, > 30min or null = stale
- Export from `packages/mesh/src/index.ts`
- Full boundary condition tests with `vi.useFakeTimers()`

### 4.2 Rewrite AgentRegistry to use Drizzle ORM (L)
**Depends on:** 4.1, 2.1

- Add `@dorkos/db` dependency to `packages/mesh/package.json`
- Change constructor: `AgentRegistry(dbPath)` → `AgentRegistry(db: Db)`
- Remove 4-version PRAGMA user_version migration chain
- Remove `manifest_json` column usage (dropped)
- Remove `.database` getter
- Replace 11 prepared statements with Drizzle queries
- Use `computeHealthStatus()` instead of `julianday()` SQL

### 4.3 Rewrite DenialList and BudgetMapper to use Drizzle ORM (M)
**Depends on:** 4.2

- DenialList: `Database.Database` → `Db`, remove migration, Drizzle queries
- BudgetMapper: `Database.Database` → `Db`, upsert via `onConflictDoUpdate`
- MeshCore: accept `db: Db` in options, pass to all sub-components
- Update server `index.ts` MeshCore instantiation

### 4.4 Update Mesh tests and add anti-regression tests (M)
**Depends on:** 4.3, 1.4

- Replace tmpdir/raw DB test setup with `createTestDb()`
- Anti-regression: health uses TypeScript (not julianday SQL)
- Anti-regression: `manifest_json` column does not exist in schema
- Update DenialList and BudgetMapper tests

---

## Phase 5 — CLI Bundle and Cleanup

### 5.1 Add Drizzle migration copy step to CLI build script (S)
**Depends on:** 2.2, 3.1, 3.2, 4.3 | **Parallel with:** 5.2

- Add `cpSync` to copy `packages/db/drizzle/` → `dist/drizzle/` after server bundle
- Verify path resolution: bundled `__dirname` + `../../drizzle` → `dist/drizzle/`
- Build CLI and verify `dist/drizzle/0000_initial.sql` exists
- Test CLI locally: verify `~/.dork/dork.db` created on first run

### 5.2 Clean up dependency tree (S)
**Depends on:** 3.1, 3.2, 4.3 | **Parallel with:** 5.1

- Remove `better-sqlite3` and `@types/better-sqlite3` from `packages/relay` and `packages/mesh`
- Verify `@dorkos/db` in: server, relay, mesh, test-utils
- Verify `drizzle-orm` in root `package.json`
- Grep for zero remaining `import Database from 'better-sqlite3'` in relay/mesh
- Grep for zero remaining `PRAGMA user_version` in relay/mesh/pulse

### 5.3 Run full test suite and verify end-to-end (M)
**Depends on:** 5.1, 5.2, 2.3, 3.3, 4.4

- `pnpm test -- --run` — all tests pass
- `pnpm typecheck` — zero errors
- `pnpm lint` — no errors
- `pnpm build` — all apps build
- `pnpm --filter=dorkos run build` — CLI builds with drizzle migrations
- Dev server creates `~/.dork/dork.db`, logs migration messages
- Pulse/Relay/Mesh routes function correctly
- No references to old database paths in production code

---

## Dependency Graph

```
1.1 → 1.2 → 1.3 → 1.4
                 ↘ 1.5 (parallel with 1.4)
                 ↘ 2.1 → 2.2 → 2.3
                        ↘ 3.1 ──→ 3.3
                        ↘ 3.2 ──↗  (parallel with 3.1)
4.1 ─────────────────────→ 4.2 → 4.3 → 4.4
                                      ↘ 5.1 ──→ 5.3
                                      ↘ 5.2 ──↗  (parallel with 5.1)
```

## Checkpoints

| After Phase | Verification |
|-------------|-------------|
| 1 | `pnpm --filter=@dorkos/db run typecheck` passes. Migration SQL exists. Smoke tests pass. |
| 2 | `pnpm test` passes for server. Pulse schedules stored in `dork.db`. |
| 3 | `pnpm test` passes for relay. Relay SSE stream works in dev. |
| 4 | `pnpm test` passes for mesh. Agent registration/discovery works in dev. |
| 5 | CLI builds and starts. Full test suite passes. Single `dork.db` with no old DB references. |
