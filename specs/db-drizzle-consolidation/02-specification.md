---
slug: db-drizzle-consolidation
number: 63
created: 2026-02-25
status: specified
---

# Database Consolidation — Single DB, `packages/db`, Drizzle ORM

**Slug:** db-drizzle-consolidation
**Authors:** Claude Code
**Date:** 2026-02-25
**Branch:** feat/db-drizzle-consolidation
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## 1. Overview

Replace three hand-rolled SQLite databases and their bespoke migration systems with a single `~/.dork/dork.db`, managed by Drizzle ORM, housed in a new `packages/db` workspace package. All database queries across `apps/server`, `packages/relay`, and `packages/mesh` migrate to Drizzle. Migrations are generated with `drizzle-kit` and auto-applied at server startup. Schema changes are enforced at commit time via a lefthook pre-commit hook.

---

## 2. Background / Problem Statement

DorkOS currently maintains three separate SQLite databases:

| Database         | Location                 | Owner                                                                                                                          |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `pulse.db`       | `~/.dork/pulse.db`       | `PulseStore` (9 prepared statements + `schedules.json` sidecar)                                                                |
| `relay/index.db` | `~/.dork/relay/index.db` | `SqliteIndex` (13 prepared statements) + `TraceStore` (3 prepared statements) — shared file, incompatible migration strategies |
| `mesh/mesh.db`   | `~/.dork/mesh/mesh.db`   | `AgentRegistry` (11 prepared statements) + `DenialList` + `BudgetMapper` — shared connection via raw `.database` getter        |

**Problems this creates:**

1. **Fragile migrations**: Three separate `PRAGMA user_version` migration chains. `TraceStore` can't use `user_version` because `SqliteIndex` already owns it, so it falls back to `CREATE TABLE IF NOT EXISTS` with no version tracking.

2. **No commit-time enforcement**: Schema changes can be committed without a corresponding migration file. This causes silent data loss or startup crashes in production.

3. **Inconsistent data types**: `relay_traces` stores timestamps as `INTEGER` Unix milliseconds; all other tables use `ISO 8601 TEXT`. `pulse_schedules` uses `crypto.randomUUID()` for IDs while Relay and Mesh use ULIDs.

4. **SQLite-specific code bleeding into TypeScript**: `julianday()` is used for health computation in `AgentRegistry` — not portable to any other SQL dialect.

5. **Redundant data**: `agents.manifest_json` stores the full manifest as a JSON blob alongside the individual structured columns that already contain all the same data.

6. **Maildir domain terms in SQL**: `relay_index` status values `'new'`/`'cur'` are Maildir conventions (from the filesystem layer) leaking into the SQL schema, breaking semantic clarity.

---

## 3. Goals

- Consolidate to a single `~/.dork/dork.db` file with a unified Drizzle ORM schema
- Create `packages/db` as the single source of database truth for the entire monorepo
- Replace all hand-written prepared statements with type-safe Drizzle query builders
- Auto-apply migrations at server startup — zero manual steps for users upgrading
- Enforce migration generation at commit time — schema change without SQL file = blocked commit
- Standardize timestamps to ISO 8601 TEXT and IDs to ULID everywhere
- Move SQLite-specific logic (`julianday()`) to portable TypeScript

---

## 4. Non-Goals

- Switching SQLite drivers (PGlite, libsql, embedded Postgres)
- Changes to client-side code, API routes, or SSE protocol
- Roadmap app (uses its own lowdb — independent)
- Any changes to the JSONL transcript storage (SDK-managed, separate concern)
- Migrating existing data from old databases (all data is ephemeral or rebuildable)
- Adding row-level security or multi-tenant isolation

---

## 5. Technical Dependencies

| Package                 | Version   | Role                                                   |
| ----------------------- | --------- | ------------------------------------------------------ |
| `drizzle-orm`           | `^0.39.0` | Query builder and type inference                       |
| `drizzle-kit`           | `^0.30.0` | Schema diffing, SQL generation, `drizzle-kit generate` |
| `better-sqlite3`        | `^11.0.0` | SQLite driver (unchanged, sync API)                    |
| `@types/better-sqlite3` | `^7.6.0`  | TypeScript declarations                                |
| `lefthook`              | `^1.10.0` | Git hooks manager for migration enforcement            |
| `ulidx`                 | `^2.4.0`  | ULID generation (already in relay + mesh)              |

**Drizzle documentation**: https://orm.drizzle.team/docs/overview
**better-sqlite3 Drizzle adapter**: https://orm.drizzle.team/docs/connect-better-sqlite3

---

## 6. Detailed Design

### 6.1 Package Structure

```
packages/db/
├── package.json              # @dorkos/db, JIT exports (.ts source)
├── tsconfig.json             # extends @dorkos/typescript-config/base
├── drizzle.config.ts         # dialect: sqlite, out: ./drizzle
├── drizzle/                  # generated SQL files — committed to git
│   ├── meta/
│   │   └── _journal.json     # migration ordering by content hash
│   └── 0000_initial.sql      # first migration (all tables)
└── src/
    ├── index.ts              # createDb(), runMigrations(), Db type, schema re-exports
    └── schema/
        ├── index.ts          # re-exports pulse + relay + mesh
        ├── pulse.ts          # pulse_schedules, pulse_runs
        ├── relay.ts          # relay_index, relay_traces
        └── mesh.ts           # agents, agent_denials, rate_limit_buckets
```

**`packages/db/package.json`:**

```json
{
  "name": "@dorkos/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "db:generate": "drizzle-kit generate --config drizzle.config.ts",
    "db:check": "drizzle-kit generate --config drizzle.config.ts && git diff --exit-code drizzle/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "drizzle-orm": "^0.39.0",
    "ulidx": "^2.4.0"
  },
  "devDependencies": {
    "@dorkos/typescript-config": "workspace:*",
    "@types/better-sqlite3": "^7.6.0",
    "drizzle-kit": "^0.30.0",
    "typescript": "^5.7.0"
  }
}
```

JIT exports follow the `packages/shared` pattern — the `.ts` source is the export target, no build step required.

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

### 6.2 Schema Design

#### `packages/db/src/schema/pulse.ts`

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/** Schedule definitions for the Pulse scheduler. Replaces schedules.json. */
export const pulseSchedules = sqliteTable('pulse_schedules', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(),
  description: text('description'),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  prompt: text('prompt').notNull(),
  cwd: text('cwd'),
  status: text('status', {
    enum: ['active', 'paused', 'pending_approval'],
  })
    .notNull()
    .default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Execution history for Pulse scheduler runs. Replaces pulse.db 'runs' table. */
export const pulseRuns = sqliteTable('pulse_runs', {
  id: text('id').primaryKey(), // ULID
  scheduleId: text('schedule_id')
    .notNull()
    .references(() => pulseSchedules.id),
  status: text('status', {
    enum: ['running', 'completed', 'failed', 'cancelled', 'timeout'],
  }).notNull(),
  startedAt: text('started_at').notNull(), // ISO 8601 TEXT
  finishedAt: text('finished_at'),
  durationMs: integer('duration_ms'),
  output: text('output'), // was: output_summary
  error: text('error'),
  sessionId: text('session_id'),
  trigger: text('trigger', {
    enum: ['scheduled', 'manual', 'agent'],
  })
    .notNull()
    .default('scheduled'),
  createdAt: text('created_at').notNull(),
});
```

#### `packages/db/src/schema/relay.ts`

```typescript
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Derived SQLite index over Maildir message files.
 * This table is fully rebuildable from the Maildir filesystem.
 * Replaces relay/index.db 'messages' table.
 */
export const relayIndex = sqliteTable('relay_index', {
  id: text('id').primaryKey(), // ULID (message ID)
  subject: text('subject').notNull(),
  endpointHash: text('endpoint_hash').notNull(),
  status: text('status', {
    enum: ['pending', 'delivered', 'failed'], // was: 'new'/'cur' (Maildir terms)
  })
    .notNull()
    .default('pending'),
  expiresAt: text('expires_at'), // was: ttl INTEGER (Unix ms)
  payload: text('payload'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
});

/** Delivery telemetry for Relay messages. Replaces relay/index.db 'message_traces' table. */
export const relayTraces = sqliteTable('relay_traces', {
  id: text('id').primaryKey(), // ULID
  messageId: text('message_id').notNull().unique(),
  traceId: text('trace_id').notNull(),
  subject: text('subject').notNull(),
  status: text('status', {
    enum: ['sent', 'delivered', 'failed', 'timeout'],
  }).notNull(),
  sentAt: text('sent_at').notNull(), // ISO 8601 TEXT (was: INTEGER Unix ms)
  deliveredAt: text('delivered_at'),
  processedAt: text('processed_at'),
  errorMessage: text('error_message'),
  metadata: text('metadata'),
});
```

#### `packages/db/src/schema/mesh.ts`

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/** Registered mesh agents. Replaces mesh/mesh.db 'agents' table. */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(),
  runtime: text('runtime').notNull(),
  projectPath: text('project_path').notNull().unique(),
  namespace: text('namespace').notNull().default('default'),
  capabilities: text('capabilities_json').notNull().default('[]'), // JSON array
  entrypoint: text('entrypoint'),
  version: text('version'),
  description: text('description'),
  approver: text('approver'),
  status: text('status', {
    enum: ['active', 'inactive'],
  })
    .notNull()
    .default('active'),
  lastSeenAt: text('last_seen_at'), // ISO 8601 TEXT
  lastSeenEvent: text('last_seen_event'),
  registeredAt: text('registered_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // manifest_json DROPPED — redundant with individual structured columns
});

/** Paths denied from mesh registration. Replaces 'denials' table. */
export const agentDenials = sqliteTable('agent_denials', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  reason: text('reason'),
  denier: text('denier'),
  createdAt: text('created_at').notNull(),
});

/**
 * Sliding-window rate limiting buckets per agent per minute.
 * Replaces 'budget_counters' table.
 */
export const rateLimitBuckets = sqliteTable('rate_limit_buckets', {
  agentId: text('agent_id').notNull(),
  bucketMinute: integer('bucket_minute').notNull(), // minutes since Unix epoch
  count: integer('count').notNull().default(0),
});
```

### 6.3 `packages/db/src/index.ts` — Factory Functions

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Opens (or creates) the DorkOS SQLite database at the given path.
 * Applies WAL mode, NORMAL sync, 5s busy timeout, and foreign key enforcement.
 */
export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

/**
 * Applies all pending Drizzle migrations synchronously.
 * Safe to call before server.listen() — no async required.
 * Resolves migrations folder relative to this file (works in both dev and CLI bundle).
 */
export function runMigrations(db: ReturnType<typeof createDb>): void {
  const migrationsFolder = path.join(__dirname, '../../drizzle');
  migrate(db, { migrationsFolder });
}

/** The Drizzle DB instance type. Use as the parameter type for all stores. */
export type Db = ReturnType<typeof createDb>;

// Re-export all schema tables and inferred types
export * from './schema/index.js';
```

**Path resolution in CLI bundle**: esbuild bundles server code to `dist/server/index.js`. `__dirname` in the bundled output resolves to `dist/server/`. So `../../drizzle` resolves to `dist/drizzle/` — where the build script copies the migration SQL files.

### 6.4 Server Wiring (`apps/server/src/index.ts`)

In the `start()` function, before any service instantiation:

```typescript
import { createDb, runMigrations } from '@dorkos/db';
import os from 'os';
import path from 'path';

// ... inside start():
const dorkHome = process.env.DORK_HOME ?? path.join(os.homedir(), '.dork');
await fs.mkdir(dorkHome, { recursive: true });

const db = createDb(path.join(dorkHome, 'dork.db'));
runMigrations(db); // synchronous — safe before listen()

logger.info('Database ready at ~/.dork/dork.db');

// Then instantiate stores with db:
const pulseStore = isPulseEnabled ? new PulseStore(db) : undefined;
const relayCore = isRelayEnabled
  ? new RelayCore({ db, maildir: path.join(dorkHome, 'relay/maildir'), ... })
  : undefined;
const traceStore = isRelayEnabled ? new TraceStore(db) : undefined;
const meshCore = isMeshEnabled ? new MeshCore({ db, ... }) : undefined;
```

### 6.5 Service Refactoring

#### PulseStore (`apps/server/src/services/pulse/pulse-store.ts`)

- Constructor changes: `PulseStore(dbPath: string)` → `PulseStore(db: Db)`
- Remove `better-sqlite3` import and `Database` constructor
- Remove all 9 prepared statements
- Replace `schedules.json` read/write with `pulse_schedules` table queries
- Replace `crypto.randomUUID()` with `ulid()` from `ulidx`
- Key Drizzle patterns:

```typescript
import { eq, desc, and, inArray } from 'drizzle-orm';
import { pulseSchedules, pulseRuns, type Db } from '@dorkos/db';
import { ulid } from 'ulidx';

// List schedules
const schedules = await this.db.select().from(pulseSchedules);

// Upsert schedule
await this.db
  .insert(pulseSchedules)
  .values({ id: ulid(), ...data, createdAt: now, updatedAt: now })
  .onConflictDoUpdate({
    target: pulseSchedules.id,
    set: { ...updates, updatedAt: now },
  });

// Create run
await this.db.insert(pulseRuns).values({
  id: ulid(),
  scheduleId,
  status: 'running',
  startedAt: new Date().toISOString(),
  trigger: 'scheduled',
  createdAt: new Date().toISOString(),
});

// List runs for a schedule
const runs = await this.db
  .select()
  .from(pulseRuns)
  .where(eq(pulseRuns.scheduleId, scheduleId))
  .orderBy(desc(pulseRuns.startedAt))
  .limit(50);
```

#### SqliteIndex (`packages/relay/src/sqlite-index.ts`)

- Constructor changes: `new SqliteIndex(dbPath: string)` → `new SqliteIndex(db: Db)`
- Remove `Database` constructor and `PRAGMA user_version` migration chain
- Replace 13 prepared statements with Drizzle queries
- Update `rebuild()` to use `db.insert(relayIndex)` operations
- Map status values on all inserts/reads: `'new'` → `'pending'`, `'cur'` → `'delivered'`
- `expires_at` replaces the old `ttl` column (already ISO 8601 string from message envelope)

```typescript
// queryMessages with cursor support
const rows = await this.db
  .select()
  .from(relayIndex)
  .where(
    and(
      eq(relayIndex.endpointHash, hash),
      eq(relayIndex.status, 'pending'),
      cursor ? gt(relayIndex.id, cursor) : undefined
    )
  )
  .orderBy(asc(relayIndex.id))
  .limit(pageSize);
```

#### TraceStore (`apps/server/src/services/relay/trace-store.ts`)

- Constructor changes: `new TraceStore({ dbPath: string })` → `new TraceStore(db: Db)`
- Remove shared-connection complexity and table-existence migration guard
- Replace dynamic `UPDATE` with camelCase→snake_case fieldMap with direct Drizzle update
- ISO 8601 timestamps on insert (no more `Date.now()` integer):

```typescript
// Insert trace span
await this.db.insert(relayTraces).values({
  id: ulid(),
  messageId: span.messageId,
  traceId: span.traceId,
  subject: span.subject,
  status: 'sent',
  sentAt: new Date().toISOString(),
  metadata: span.metadata ? JSON.stringify(span.metadata) : null,
});

// Update span status
await this.db
  .update(relayTraces)
  .set({
    status: update.status,
    deliveredAt: update.deliveredAt ?? null,
    processedAt: update.processedAt ?? null,
    errorMessage: update.errorMessage ?? null,
  })
  .where(eq(relayTraces.messageId, messageId));
```

#### AgentRegistry (`packages/mesh/src/agent-registry.ts`)

- Constructor changes: `new AgentRegistry(dbPath: string)` → `new AgentRegistry(db: Db)`
- Remove 4-version `PRAGMA user_version` migration chain
- Remove `manifest_json` column usage (dropped from schema)
- Remove `get database()` getter (DenialList and BudgetMapper receive `Db` directly)
- Replace 11 prepared statements with Drizzle queries
- Move `julianday()` health computation to TypeScript:

```typescript
/** Compute agent health status from last_seen_at timestamp. */
export function computeHealthStatus(lastSeenAt: string | null): 'active' | 'inactive' | 'stale' {
  if (!lastSeenAt) return 'stale';
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  const diffMinutes = diffMs / 60_000;
  if (diffMinutes < 5) return 'active';
  if (diffMinutes < 30) return 'inactive';
  return 'stale';
}
```

```typescript
// Register agent
await this.db.insert(agents).values({
  id: ulid(),
  name: manifest.name,
  runtime: manifest.runtime,
  projectPath: manifest.projectPath,
  namespace: manifest.namespace ?? 'default',
  capabilities: JSON.stringify(manifest.capabilities ?? []),
  entrypoint: manifest.entrypoint ?? null,
  version: manifest.version ?? null,
  description: manifest.description ?? null,
  approver: approver ?? null,
  status: 'active',
  registeredAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// List with health (health computed in TypeScript, not SQL)
const rows = await this.db.select().from(agents);
return rows.map((row) => ({
  ...row,
  capabilities: JSON.parse(row.capabilities) as string[],
  healthStatus: computeHealthStatus(row.lastSeenAt),
}));
```

#### DenialList (`packages/mesh/src/denial-list.ts`)

- Constructor changes: `new DenialList(database: Database)` → `new DenialList(db: Db)`
- Remove `CREATE TABLE IF NOT EXISTS` (handled by Drizzle migration)
- Replace prepared statements with Drizzle queries:

```typescript
// Add denial
await this.db.insert(agentDenials).values({
  id: ulid(),
  path: realPathSync(filePath),
  reason: reason ?? null,
  denier: denier ?? null,
  createdAt: new Date().toISOString(),
});

// Check if denied
const [row] = await this.db
  .select()
  .from(agentDenials)
  .where(eq(agentDenials.path, realPathSync(filePath)))
  .limit(1);
return row !== undefined;
```

#### BudgetMapper (`packages/mesh/src/budget-mapper.ts`)

- Constructor changes: `new BudgetMapper(database: Database)` → `new BudgetMapper(db: Db)`
- Replace prepared statements with Drizzle queries including upsert:

```typescript
// Increment bucket count
const minute = Math.floor(Date.now() / 60_000);
await this.db
  .insert(rateLimitBuckets)
  .values({ agentId, bucketMinute: minute, count: 1 })
  .onConflictDoUpdate({
    target: [rateLimitBuckets.agentId, rateLimitBuckets.bucketMinute],
    set: { count: sql`count + 1` },
  });

// Get window count (last N minutes)
const cutoff = Math.floor(Date.now() / 60_000) - windowMinutes;
const [result] = await this.db
  .select({ total: sum(rateLimitBuckets.count) })
  .from(rateLimitBuckets)
  .where(and(eq(rateLimitBuckets.agentId, agentId), gte(rateLimitBuckets.bucketMinute, cutoff)));
return Number(result?.total ?? 0);
```

### 6.6 Lefthook Setup (New to Project)

Lefthook is not currently installed. This spec adds it:

**1. Install lefthook:**

```bash
pnpm add -D lefthook -w
```

**2. Add `prepare` script to root `package.json`:**

```json
{
  "scripts": {
    "prepare": "lefthook install"
  }
}
```

**3. Create `lefthook.yml` at repo root:**

```yaml
pre-commit:
  commands:
    db-migrations:
      glob: 'packages/db/src/schema/*.ts'
      run: |
        npx drizzle-kit generate --config packages/db/drizzle.config.ts
        git add packages/db/drizzle/
      fail_text: 'DB schema changed — migrations generated and staged. Review and re-commit.'
```

**How it works**: The `glob` filter means the hook only runs when schema files change. When triggered, `drizzle-kit generate` computes the diff between the current schema and the last snapshot, generates a new SQL file in `drizzle/`, and stages it automatically. The commit proceeds with both the schema change and the migration file together. Developers don't manually run `drizzle-kit`.

**Why committed `lefthook.yml`**: Unlike plain git hooks in `.git/hooks/` (which are local only), `lefthook.yml` is committed to the repository. When any developer runs `npm install` or `pnpm install`, the `prepare` script installs the hooks automatically. This is identical to Husky's distribution model.

**Note**: Drizzle does not have a native `--check` or `--dry-run` flag (open issue #5059 as of Feb 2026). The auto-generate-and-stage approach avoids the need for a separate check step.

### 6.7 Turbo Tasks

Add to `turbo.json`:

```json
{
  "tasks": {
    "db:generate": {
      "inputs": ["packages/db/src/schema/**/*.ts", "packages/db/drizzle.config.ts"],
      "outputs": ["packages/db/drizzle/**"],
      "cache": true
    },
    "db:check": {
      "inputs": ["packages/db/src/schema/**/*.ts", "packages/db/drizzle.config.ts"],
      "cache": false
    }
  }
}
```

Usage:

```bash
# Generate migrations manually (also run by lefthook hook):
turbo run db:generate --filter=@dorkos/db

# Validate migrations are up to date (for CI):
turbo run db:check --filter=@dorkos/db
```

### 6.8 CLI Bundle — Migration Copy Step

esbuild does not copy static assets. Add to `packages/cli/scripts/build.ts` after Step 2 (server bundle):

```typescript
import { cpSync } from 'fs';

// Step 2.5: Copy Drizzle migration SQL files alongside bundled server
cpSync(path.join(rootDir, 'packages/db/drizzle'), path.join(outDir, 'drizzle'), {
  recursive: true,
});
```

At runtime in the bundled CLI:

- `__dirname` in `packages/db/src/index.ts` resolves to the directory containing the bundled server
- `path.join(__dirname, '../../drizzle')` resolves to `dist/drizzle/` — the copied folder

### 6.9 Dependency Changes

**Add to `packages/db/package.json` (new package):**

- `better-sqlite3: ^11.0.0`
- `drizzle-orm: ^0.39.0`
- `ulidx: ^2.4.0`
- devDep: `drizzle-kit: ^0.30.0`
- devDep: `@types/better-sqlite3: ^7.6.0`

**Add to root `package.json` (monorepo-level deduplication):**

- `drizzle-orm: ^0.39.0` — prevents `instanceof` check failures when `drizzle-orm` is instantiated from multiple locations

**Remove from `packages/relay/package.json`:**

- `better-sqlite3` (moves to `packages/db`)
- `@types/better-sqlite3` (moves to `packages/db`)

**Remove from `packages/mesh/package.json`:**

- `better-sqlite3` (moves to `packages/db`)
- `@types/better-sqlite3` (moves to `packages/db`)

**Add `@dorkos/db: workspace:*` to:**

- `apps/server/package.json`
- `packages/relay/package.json`
- `packages/mesh/package.json`

### 6.10 Existing Data Handling

Old database files are **left intact** — never deleted:

| Old file                 | Status after upgrade |
| ------------------------ | -------------------- |
| `~/.dork/pulse.db`       | Preserved, ignored   |
| `~/.dork/relay/index.db` | Preserved, ignored   |
| `~/.dork/mesh/mesh.db`   | Preserved, ignored   |
| `~/.dork/schedules.json` | Preserved, ignored   |

Log message emitted at startup:

```
[db] Migrations applied to ~/.dork/dork.db
[db] Legacy databases preserved at previous paths
```

All data is ephemeral or rebuildable:

- **Pulse run history**: Nice-to-have, not critical; schedules are re-created on first run
- **Relay index**: Fully derivable from the Maildir filesystem via `SqliteIndex.rebuild()`
- **Relay traces**: Delivery telemetry; safe to lose
- **Agents/denials/buckets**: Re-populated via discovery and registration

---

## 7. Data Model Changes Summary

### Table Renames

| Old Name          | New Name             | Old DB           | New DB    |
| ----------------- | -------------------- | ---------------- | --------- |
| `runs`            | `pulse_runs`         | `pulse.db`       | `dork.db` |
| _(JSON file)_     | `pulse_schedules`    | `schedules.json` | `dork.db` |
| `messages`        | `relay_index`        | `relay/index.db` | `dork.db` |
| `message_traces`  | `relay_traces`       | `relay/index.db` | `dork.db` |
| `denials`         | `agent_denials`      | `mesh/mesh.db`   | `dork.db` |
| `budget_counters` | `rate_limit_buckets` | `mesh/mesh.db`   | `dork.db` |
| `agents`          | `agents`             | `mesh/mesh.db`   | `dork.db` |

### Column Changes

| Table             | Old Column             | New Column                     | Change                                |
| ----------------- | ---------------------- | ------------------------------ | ------------------------------------- |
| `relay_index`     | `ttl INTEGER`          | `expires_at TEXT`              | Duration→timestamp, INT→ISO TEXT      |
| `relay_index`     | `status 'new'/'cur'`   | `status 'pending'/'delivered'` | Maildir terms removed                 |
| `pulse_runs`      | `output_summary TEXT`  | `output TEXT`                  | Rename ("summary" implies truncation) |
| `agents`          | `manifest_json TEXT`   | _(dropped)_                    | Redundant with individual columns     |
| `relay_traces`    | `sent_at INTEGER`      | `sent_at TEXT`                 | INT Unix ms → ISO 8601 TEXT           |
| `relay_traces`    | `delivered_at INTEGER` | `delivered_at TEXT`            | INT Unix ms → ISO 8601 TEXT           |
| `relay_traces`    | `processed_at INTEGER` | `processed_at TEXT`            | INT Unix ms → ISO 8601 TEXT           |
| `pulse_schedules` | `id UUID`              | `id ULID`                      | Standardize to ULID                   |
| `pulse_runs`      | `id UUID`              | `id ULID`                      | Standardize to ULID                   |

---

## 8. API Changes

None. All HTTP routes, SSE event types, and MCP tool signatures remain unchanged. The refactor is purely internal — the `MeshCore`, `RelayCore`, and `PulseStore` public interfaces remain stable. Only their constructors change (accept `Db` instead of file paths).

---

## 9. User Experience

**Installing DorkOS for the first time:** No change. `~/.dork/dork.db` is created automatically on first run. No manual steps.

**Upgrading from a previous version:** The new server ignores `pulse.db`, `relay/index.db`, and `mesh/mesh.db`. On first start, a log message explains that the new database is at `dork.db` and old files are preserved. Pulse schedule definitions are re-entered (run history is lost). Relay index is rebuilt automatically from the Maildir. Mesh agents are re-discovered/re-registered.

**Developer workflow:** Schema changes now require a migration file. The lefthook pre-commit hook generates and stages the file automatically — no manual `drizzle-kit generate` step. If the hook fails (e.g., offline with no npx access), the error message explains what to run manually.

---

## 10. Testing Strategy

### Unit Tests — Each Service

Each refactored store/service should have tests that use **in-memory SQLite** via `createDb(':memory:')` + `runMigrations()`:

```typescript
// Example: pulse-store.test.ts
import { createDb, runMigrations } from '@dorkos/db';
import { PulseStore } from '../pulse-store.js';

let db: ReturnType<typeof createDb>;
let store: PulseStore;

beforeEach(() => {
  // Purpose: Each test starts with a clean in-memory database
  // with all migrations applied, preventing test bleed
  db = createDb(':memory:');
  runMigrations(db);
  store = new PulseStore(db);
});

it('createSchedule stores schedule in pulse_schedules', async () => {
  // Purpose: Verify that schedule creation persists to the correct table
  const schedule = await store.createSchedule({
    name: 'Test',
    cron: '* * * * *',
    prompt: 'run',
    timezone: 'UTC',
  });
  expect(schedule.id).toMatch(/^[0-9A-Z]{26}$/); // ULID pattern
  const found = await store.getSchedule(schedule.id);
  expect(found?.name).toBe('Test');
});

it('createRun generates ULID id, not UUID', async () => {
  // Purpose: Verify ID standardization — no crypto.randomUUID()
  const schedule = await store.createSchedule({ ... });
  const run = await store.createRun(schedule.id, 'manual');
  expect(run.id).toMatch(/^[0-9A-Z]{26}$/);
  expect(run.id).not.toMatch(/-/); // ULIDs have no hyphens, UUIDs do
});
```

Tests that need to change due to this refactor:

- `apps/server/src/services/__tests__/pulse-store.test.ts` — replace `tmpdir` SQLite path with `createDb(':memory:')`
- `packages/relay/src/__tests__/sqlite-index.test.ts` — same
- `packages/mesh/src/__tests__/agent-registry.test.ts` — same, remove raw DB assertions

### Integration Test — Migration Smoke Test

```typescript
// packages/db/src/__tests__/migrations.test.ts
import { createDb, runMigrations } from '../index.js';

it('applies all migrations to a fresh database without errors', () => {
  // Purpose: Catch SQL errors in migration files before deployment
  expect(() => {
    const db = createDb(':memory:');
    runMigrations(db);
  }).not.toThrow();
});

it('migrations are idempotent — running twice does not throw', () => {
  // Purpose: Verify __drizzle_migrations tracking prevents re-application
  const db = createDb(':memory:');
  runMigrations(db);
  expect(() => runMigrations(db)).not.toThrow();
});
```

### Anti-Regression Tests

```typescript
it('pulse store does not use crypto.randomUUID', async () => {
  // Purpose: Ensure UUID usage is fully eliminated
  const spy = vi.spyOn(crypto, 'randomUUID');
  await store.createSchedule({ ... });
  expect(spy).not.toHaveBeenCalled();
});

it('relay trace sentAt is ISO 8601 string, not number', async () => {
  // Purpose: Verify timestamp standardization
  await traceStore.insertSpan({ messageId: 'msg1', traceId: 'trace1', subject: 'test' });
  const trace = await traceStore.getTrace('msg1');
  expect(typeof trace?.sentAt).toBe('string');
  expect(trace?.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
});

it('agent health uses TypeScript computation, not julianday SQL', async () => {
  // Purpose: Verify SQLite-specific code is removed
  // If julianday() were still in use, it would work in SQLite but fail portability checks
  const agent = await registry.register({ ... });
  await registry.updateLastSeen(agent.id, new Date().toISOString());
  const health = registry.getAgentHealth(agent.id);
  expect(health?.healthStatus).toBe('active');
});
```

### Test Utilities

`packages/test-utils` should expose a shared `createTestDb()` helper:

```typescript
// packages/test-utils/src/db.ts
export function createTestDb() {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}
```

---

## 11. Performance Considerations

- **Single connection**: One `better-sqlite3` instance handles all tables. Better than 3 separate connections since better-sqlite3 is single-threaded by design — there's no benefit to distributing across files.
- **WAL mode**: Already set on all existing databases; preserved in `createDb()`.
- **Drizzle query builder**: Compiles to the same parameterized SQL as hand-written prepared statements. No runtime performance regression.
- **Migration at startup**: `migrate()` from `drizzle-orm/better-sqlite3/migrator` is synchronous and queries the `__drizzle_migrations` table. If no pending migrations, it returns immediately (microseconds). If migrations are pending, they run before the server accepts connections.
- **In-memory tests**: Using `':memory:'` in tests is faster than tmpdir files and eliminates test cleanup.

---

## 12. Security Considerations

- **No new attack surface**: This is a pure internal refactor. No new HTTP endpoints, no new MCP tools, no new SSE event types.
- **Foreign key enforcement**: `sqlite.pragma('foreign_keys = ON')` is already set and preserved. Drizzle respects this — `pulseRuns.scheduleId` enforces referential integrity at the DB layer.
- **Injection safety**: Drizzle's query builder uses parameterized queries — same as prepared statements, no SQL injection risk.
- **File permissions**: `~/.dork/dork.db` inherits the same user-only permissions as the existing database files. No change in access control model.

---

## 13. Documentation

### Updates Required

- `contributing/architecture.md` — Update "Services" table to note `packages/db` as the database layer; update data flow section to show single DB
- `AGENTS.md` — Update server services list to reference `packages/db` and `createDb()`; add `db:generate` to the commands table
- `contributing/configuration.md` — Update DB file paths section (single `dork.db` replaces three files)

### New Documentation

No new external (`docs/`) documentation required — this is an internal infrastructure change invisible to end users.

---

## 14. Implementation Phases

### Phase 1 — Create `packages/db`

1. Scaffold the package (`package.json`, `tsconfig.json`, `drizzle.config.ts`)
2. Write schema files (`pulse.ts`, `relay.ts`, `mesh.ts`) with all renamed tables/columns
3. Run `drizzle-kit generate` to produce `0000_initial.sql`
4. Implement `createDb()` and `runMigrations()` in `src/index.ts`
5. Install lefthook, add `prepare` script, create `lefthook.yml`
6. Add `db:generate` and `db:check` tasks to `turbo.json`
7. Write migration smoke tests in `packages/db/src/__tests__/`

**Checkpoint**: `pnpm --filter=@dorkos/db run typecheck` passes. Migration SQL file exists and runs against `:memory:`.

### Phase 2 — Migrate Pulse

1. Rewrite `PulseStore` to accept `Db`, replace prepared statements, move schedules from JSON
2. Update `apps/server/src/index.ts` to call `createDb()` + `runMigrations()` and inject `db`
3. Update Pulse tests to use `createTestDb()`
4. Remove `schedules.json` read/write from `PulseStore`

**Checkpoint**: `pnpm test` passes for server tests. `pnpm typecheck` passes.

### Phase 3 — Migrate Relay

1. Rewrite `SqliteIndex` to accept `Db`, replace 13 prepared statements
2. Rewrite `TraceStore` to accept `Db`, replace 3 prepared statements + dynamic UPDATE
3. Update `RelayCore` constructor to accept `db` instead of `dbPath`
4. Update Relay tests

**Checkpoint**: `pnpm test` passes for relay tests. Relay SSE stream functions correctly in dev.

### Phase 4 — Migrate Mesh

1. Move `julianday()` health computation to `computeHealthStatus()` TypeScript helper
2. Rewrite `AgentRegistry` to accept `Db`, remove migration chain, remove `manifest_json`, remove `.database` getter
3. Rewrite `DenialList` and `BudgetMapper` to accept `Db` directly (from `MeshCore` injection)
4. Update `MeshCore` constructor to accept `db`
5. Update Mesh tests

**Checkpoint**: `pnpm test` passes for mesh tests. Agent registration/discovery works in dev.

### Phase 5 — CLI Bundle and Cleanup

1. Add `cpSync` migration copy step to `packages/cli/scripts/build.ts`
2. Remove `better-sqlite3` and `@types/better-sqlite3` from `packages/relay/package.json` and `packages/mesh/package.json`
3. Add `@dorkos/db: workspace:*` to `apps/server`, `packages/relay`, `packages/mesh`
4. Add `drizzle-orm` to root `package.json` for deduplication
5. Verify `pnpm --filter=dorkos run build` produces a working CLI bundle
6. Run full test suite: `pnpm test -- --run`

**Checkpoint**: CLI builds, starts, and serves the client. `~/.dork/dork.db` is created on first run. No reference to `pulse.db`, `relay/index.db`, or `mesh/mesh.db` in server startup logs.

---

## 15. Open Questions

None. All architectural decisions were resolved during ideation. See [Section 6 of the ideation document](./01-ideation.md) for the full decision log.

---

## 16. Related ADRs

| ADR                                                                       | Title                                                    | Relationship                                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [ADR #12](../../decisions/0012-use-ulid-for-relay-message-ids.md)         | Use ULID for Relay Message IDs                           | Extended: this spec standardizes ULIDs to Pulse tables as well                                  |
| [ADR #13](../../decisions/0013-hybrid-maildir-sqlite-storage.md)          | Use Hybrid Maildir + SQLite for Relay Storage            | Refactored: the SQLite portion moves to `dork.db` under Drizzle                                 |
| [ADR #25](../../decisions/0025-simple-json-columns-for-agent-registry.md) | Use Simple JSON Columns for Agent Registry SQLite Schema | Extended: schema moves to `dork.db`; `manifest_json` redundant column is dropped                |
| [ADR #28](../../decisions/0028-sqlite-trace-storage-in-relay-index.md)    | Store Message Traces in Existing Relay SQLite Index      | Superseded: traces now live in `dork.db` (`relay_traces` table), not alongside `relay/index.db` |

---

## 17. References

- [Drizzle ORM — better-sqlite3 adapter](https://orm.drizzle.team/docs/connect-better-sqlite3)
- [Drizzle Kit — migrations overview](https://orm.drizzle.team/docs/kit-overview)
- [Drizzle — SQLite column types](https://orm.drizzle.team/docs/column-types/sqlite)
- [better-sqlite3 — WAL mode](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- [Lefthook — configuration reference](https://github.com/evilmartians/lefthook/blob/master/docs/configuration.md)
- [ulidx — ULID generation for TypeScript](https://github.com/perry-mitchell/ulidx)
- Ideation document: [specs/db-drizzle-consolidation/01-ideation.md](./01-ideation.md)
