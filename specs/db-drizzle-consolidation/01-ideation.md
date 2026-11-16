---
slug: db-drizzle-consolidation
number: 63
created: 2026-02-25
status: ideation
---

# Database Consolidation — Single DB, `packages/db`, Drizzle ORM

**Slug:** db-drizzle-consolidation
**Author:** Claude Code
**Date:** 2026-02-25
**Branch:** preflight/db-drizzle-consolidation
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Replace three hand-rolled SQLite databases and their bespoke
  migration systems with a single `~/.dork/dork.db`, managed by Drizzle ORM,
  housed in a new `packages/db` workspace package. All database queries across
  `apps/server`, `packages/relay`, and `packages/mesh` migrate to Drizzle.
  Migrations are auto-applied at startup and enforced at commit time via
  lefthook.

- **Assumptions:**
  - Driver stays `better-sqlite3` (no switch to PGlite or libsql)
  - Obsidian plugin does **not** directly instantiate DB services — server
    initialization handles all DB creation; plugin is unaffected
  - All tables land in one file (`~/.dork/dork.db`); no per-domain database
    files
  - Schema renames and restructuring from earlier analysis are included in this
    spec (see Section 5)
  - ULIDs replace UUIDs in Pulse tables for consistency with Relay and Mesh
  - Timestamp format standardized to ISO 8601 TEXT strings everywhere

- **Out of scope:**
  - Switching SQLite drivers (PGlite, libsql, embedded Postgres)
  - Changes to client-side code, API routes, or SSE protocol
  - Roadmap app (uses its own lowdb, independent)
  - Any changes to the JSONL transcript storage (SDK-managed, separate concern)

---

## 2) Pre-reading Log

- `apps/server/src/services/pulse/pulse-store.ts`: Two storage backends —
  SQLite `runs` table + JSON `schedules.json`. Custom `PRAGMA user_version`
  migrations. 9 prepared statements.
- `apps/server/src/services/relay/trace-store.ts`: `message_traces` table
  sharing `relay/index.db` with SqliteIndex. Table-existence migration guard
  (no version tracking). 3 prepared statements + dynamic metric queries.
- `packages/relay/src/sqlite-index.ts`: Derived index over Maildir files.
  `messages` table with 13 prepared statements + cursor-based queryMessages().
  2-version migration history.
- `packages/mesh/src/agent-registry.ts`: `agents` + `budget_counters` tables.
  4-version migration chain. `julianday()` health computation in SQL.
  11 prepared statements. Exposes raw `database` getter for DenialList sharing.
- `packages/mesh/src/denial-list.ts`: `denials` table sharing AgentRegistry's
  DB connection. No version tracking — idempotent `CREATE TABLE IF NOT EXISTS`.
- `packages/mesh/src/budget-mapper.ts`: Uses `budget_counters` created by
  AgentRegistry v3. No migrations of its own. Sliding window rate limiter.
- `apps/server/src/index.ts`: Service wiring — all stores instantiated in
  `start()`. Pulse/Relay/Mesh are feature-flag-gated. All receive `dorkHome`
  derived from `DORK_HOME` env var or `~/.dork`.
- `packages/cli/scripts/build.ts`: esbuild bundles server + client. No static
  asset copy steps today — migrations will need one added.
- `packages/relay/package.json`, `packages/mesh/package.json`: Both have
  `better-sqlite3` as a direct dependency; this moves to `packages/db`.

---

## 3) Codebase Map

**Primary Components/Modules:**

| File                                            | Role                                                |
| ----------------------------------------------- | --------------------------------------------------- |
| `apps/server/src/index.ts`                      | Service wiring — instantiates all stores at startup |
| `apps/server/src/services/pulse/pulse-store.ts` | Pulse persistence (replace with Drizzle queries)    |
| `apps/server/src/services/relay/trace-store.ts` | Relay trace persistence (replace)                   |
| `packages/relay/src/sqlite-index.ts`            | Relay message index (replace)                       |
| `packages/mesh/src/agent-registry.ts`           | Mesh agent registry (replace)                       |
| `packages/mesh/src/denial-list.ts`              | Denied paths list (replace)                         |
| `packages/mesh/src/budget-mapper.ts`            | Rate-limit buckets (replace)                        |
| `packages/relay/src/relay-core.ts`              | Instantiates SqliteIndex — update injection         |
| `packages/mesh/src/mesh-core.ts`                | Instantiates AgentRegistry — update injection       |
| `apps/server/src/services/mcp-tool-server.ts`   | Receives McpToolDeps — update interface             |
| `packages/cli/scripts/build.ts`                 | Add migration file copy step                        |
| `lefthook.yml`                                  | Add pre-commit schema-check hook                    |
| `turbo.json`                                    | Add `db:generate` task                              |
| `packages/db/`                                  | **New package** — all of the above                  |

**Shared Dependencies:**

- `better-sqlite3` moves from `packages/relay` + `packages/mesh` + `apps/server`
  to `packages/db` only
- `drizzle-orm` new dep in `packages/db` and root (for deduplication)
- `drizzle-kit` dev dep in `packages/db` only
- `ulidx` already in relay/mesh; stays where it is for ID generation

**Data Flow (current → future):**

```
Current:
  server/index.ts
    → new PulseStore(dorkHome)           // opens ~/.dork/pulse.db
    → new RelayCore(...)                  // opens ~/.dork/relay/index.db
    → new TraceStore({ dbPath })          // opens same relay/index.db
    → new MeshCore(...)                   // opens ~/.dork/mesh/mesh.db
      → new AgentRegistry(dbPath)
      → new DenialList(registry.database)
      → new BudgetMapper(registry.database)

Future:
  server/index.ts
    → createDb(path.join(dorkHome, 'dork.db'))   // ONE connection
    → runMigrations(db)                           // auto-applied at startup
    → new PulseStore(db)                          // Drizzle queries
    → new RelayCore({ db, ... })                  // passes db through
    → new TraceStore(db)
    → new MeshCore({ db, ... })
      → new AgentRegistry(db)
      → new DenialList(db)
      → new BudgetMapper(db)
```

**Feature Flags/Config:** `DORKOS_PULSE_ENABLED`, `DORKOS_RELAY_ENABLED`,
`DORKOS_MESH_ENABLED` — all still respected; stores only instantiated when
feature is enabled. DB connection is always opened (needed for startup
migration run regardless of feature flags).

**Potential Blast Radius:**

- Direct: 8 source files (all stores + relay-core + mesh-core + server/index)
- Indirect: `mcp-tool-server.ts` (McpToolDeps interface), `scheduler-service.ts`
  (holds PulseStore reference), `message-receiver.ts` (holds store references)
- Tests: ~10 test files that instantiate stores with tmpdir databases
- Build: `packages/cli/scripts/build.ts` (migration copy step)
- Config: `lefthook.yml`, `turbo.json`, root `package.json`

---

## 4) Root Cause Analysis

_Not a bug fix — not applicable._

---

## 5) Research

### Schema Design for `packages/db`

**Table renames (from earlier analysis):**

| Old               | New                  | Reason                                        |
| ----------------- | -------------------- | --------------------------------------------- |
| `runs`            | `pulse_runs`         | Namespaced for clarity in shared DB           |
| _(JSON file)_     | `pulse_schedules`    | Moved from JSON into SQLite                   |
| `messages`        | `relay_index`        | It's a derived index, not messages themselves |
| `message_traces`  | `relay_traces`       | Namespaced; shorter                           |
| `denials`         | `agent_denials`      | Namespaced                                    |
| `budget_counters` | `rate_limit_buckets` | Describes purpose, not contents               |

**Column renames:**

| Table         | Old                    | New                       | Reason                                                  |
| ------------- | ---------------------- | ------------------------- | ------------------------------------------------------- |
| `relay_index` | `ttl`                  | `expires_at`              | TTL is a duration; this is an expiry timestamp          |
| `relay_index` | status `'new'`/`'cur'` | `'pending'`/`'delivered'` | Maildir terms leaking into SQL                          |
| `pulse_runs`  | `output_summary`       | `output`                  | "Summary" implies always truncated                      |
| `agents`      | `manifest_json`        | _(drop)_                  | Redundant — individual columns already store all fields |

**Structural changes:**

- `julianday()` health computation removed from SQL → moved to TypeScript
  helper function in AgentRegistry (portable, testable, not SQLite-specific)
- All timestamps standardized to ISO 8601 TEXT (was: `relay_traces` used
  INTEGER Unix ms — these become TEXT)
- All surrogate IDs standardized to ULID (was: `pulse_schedules` and
  `pulse_runs` used UUID from `crypto.randomUUID()`)

### Drizzle Setup Pattern

**`packages/db` package.json** — JIT exports matching `packages/shared` pattern:

```json
{
  "name": "@dorkos/db",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  },
  "dependencies": {
    "better-sqlite3": "^12.6.2",
    "drizzle-orm": "^0.39.x"
  },
  "devDependencies": {
    "drizzle-kit": "^0.30.x"
  }
}
```

`drizzle-orm` also installed at monorepo root to force deduplication and prevent
`instanceof` check failures.

**`packages/db/drizzle.config.ts`:**

```typescript
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'sqlite',
  driver: 'better-sqlite3',
});
```

**`packages/db/src/index.ts`** — factory function:

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

export function runMigrations(db: ReturnType<typeof createDb>) {
  // migrationsFolder is resolved relative to this file at runtime
  // CLI bundle copies drizzle/ alongside dist/server/index.js
  const migrationsFolder = path.join(__dirname, '../../drizzle');
  migrate(db, { migrationsFolder });
}

export type Db = ReturnType<typeof createDb>;
export * from './schema/index.js';
```

### Auto-Migration on Startup

`migrate()` from `drizzle-orm/better-sqlite3/migrator` is synchronous (matches
better-sqlite3's synchronous API). It:

1. Creates `__drizzle_migrations` table automatically on first run
2. Reads `drizzle/meta/_journal.json` for migration ordering
3. Applies each pending `.sql` file in sequence
4. Records applied migrations by content hash (not just filename)

Called once at server startup before any routes are registered:

```typescript
// apps/server/src/index.ts
import { createDb, runMigrations } from '@dorkos/db';
const db = createDb(path.join(dorkHome, 'dork.db'));
runMigrations(db); // synchronous, safe to call before listen()
```

### CLI Bundle — Migration File Copy

esbuild does not include static files. The build script must copy the
`drizzle/` directory alongside the bundled server output:

```typescript
// packages/cli/scripts/build.ts — add after Step 2 (server bundle)
import { cpSync } from 'fs';
cpSync(path.join(rootDir, 'packages/db/drizzle'), path.join(outDir, 'drizzle'), {
  recursive: true,
});
```

At runtime in the bundled CLI, `__dirname` resolves to `dist/server/`, and
`../../drizzle` resolves to `dist/drizzle/` — the copied folder.

### Migration Generation Enforcement

Drizzle has no native `--check` or `--dry-run` flag (open issue #5059 as of
Feb 2026). The community workaround:

```bash
npx drizzle-kit generate --config packages/db/drizzle.config.ts
git diff --exit-code packages/db/drizzle/
```

This is implemented as a lefthook pre-commit hook so it runs automatically:

```yaml
# lefthook.yml addition
pre-commit:
  commands:
    db-migrations:
      glob: 'packages/db/src/schema/*.ts'
      run: |
        npx drizzle-kit generate --config packages/db/drizzle.config.ts
        git add packages/db/drizzle/
      fail_text: 'DB schema changed — migrations generated and staged. Review and re-commit.'
```

**How lefthook works for all developers:** `lefthook.yml` is committed to git.
Running `npm install` (via the `prepare` script or explicit `lefthook install`)
installs the hooks into each developer's `.git/hooks/`. Any developer who
clones the repo gets the hooks automatically — no per-machine manual setup.
This is identical to Husky's model.

**Turbo task for manual generation:**

```json
// turbo.json addition
"db:generate": {
  "inputs": ["packages/db/src/schema/**/*.ts", "packages/db/drizzle.config.ts"],
  "outputs": ["packages/db/drizzle/**"],
  "cache": true
}
```

Run manually: `turbo run db:generate --filter=@dorkos/db`
Run in CI (check only — fail if stale): `turbo run db:check --filter=@dorkos/db`

### Existing Data Handling

Old databases (`pulse.db`, `relay/index.db`, `mesh/mesh.db`) are left in place
on disk but ignored by the new server. No data migration is performed. All data
in these databases is ephemeral or rebuildable:

- `pulse_runs` — run history (nice-to-have, not critical)
- `relay_index` — derived index, fully rebuildable from Maildir
- `relay_traces` — delivery telemetry
- `agents` / `denials` / `rate_limit_buckets` — re-populated via discovery

A one-time startup log message can inform users: "Database migrated to
~/.dork/dork.db. Previous databases preserved at their old paths."

---

## 6) Decisions

| #   | Decision                          | Choice                                         | Rationale                                                                                                                                                                                                |
| --- | --------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Existing user data during upgrade | Fresh start — old DBs ignored                  | All data is ephemeral or rebuildable. No migration code to write or test. Old files preserved (not deleted) for safety.                                                                                  |
| 2   | Migration generation enforcement  | Lefthook pre-commit hook                       | `lefthook.yml` is committed to git, so all developers get the hook on `npm install`. Catches stale migrations at commit time, not after push. DorkOS already uses lefthook — no new tooling needed.      |
| 3   | `relay_index` table location      | In `packages/db`                               | Single database, single schema package, single Drizzle instance. Derived nature documented with a comment in schema. `rebuild()` method in SqliteIndex still works by calling Drizzle insert operations. |
| 4   | Driver                            | `better-sqlite3` (unchanged)                   | No Electron app today; native module rebuild is a solved problem. Drizzle + better-sqlite3 keeps sync API, no constructor refactor needed.                                                               |
| 5   | Schema location                   | `packages/db/src/schema/{pulse,relay,mesh}.ts` | Domain-organized files, one Drizzle config, one migrations folder. Obsidian plugin can import `@dorkos/db` directly if it ever needs DB access.                                                          |

---

## 7) Implementation Plan (High-Level)

This is a significant refactor touching 8+ source files. Suggested sequence to
minimize risk:

**Phase 1 — Create `packages/db`**

1. Scaffold the package (`package.json`, `tsconfig.json`, `drizzle.config.ts`)
2. Write Drizzle schema files (`pulse.ts`, `relay.ts`, `mesh.ts`) with all
   renamed tables/columns from Section 5
3. Run `drizzle-kit generate` to produce the initial migration SQL
4. Implement `createDb()` + `runMigrations()` in `src/index.ts`
5. Wire up lefthook + turbo tasks

**Phase 2 — Migrate Pulse**

1. Rewrite `PulseStore` to use injected `Db` (Drizzle queries replace all
   prepared statements)
2. Move `pulse_schedules` from JSON → SQLite (remove `schedules.json` read/write)
3. Update `apps/server/src/index.ts` to create/inject `db`
4. Update Pulse tests to use `createDb(':memory:')` or tmpfile

**Phase 3 — Migrate Relay**

1. Rewrite `SqliteIndex` to use Drizzle queries
2. Rewrite `TraceStore` to use Drizzle queries
3. Update `RelayCore` to receive `db` injection instead of `dbPath`
4. Update Relay tests

**Phase 4 — Migrate Mesh**

1. Move `julianday()` health computation to TypeScript helper
2. Rewrite `AgentRegistry`, `DenialList`, `BudgetMapper` to use Drizzle queries
3. Update `MeshCore` to receive `db` injection
4. Update Mesh tests

**Phase 5 — CLI Bundle**

1. Add migration copy step to `packages/cli/scripts/build.ts`
2. Verify path resolution in bundled output
3. Remove `better-sqlite3` from `packages/relay` and `packages/mesh`
   `package.json` (now a dep of `packages/db` only)

---

_Next step: run `/ideate-to-spec` to convert this to a formal specification._
