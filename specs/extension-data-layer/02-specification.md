---
slug: extension-data-layer
id: 260718-042902
created: 2026-07-17
status: specified
linearIssue: DOR-358
---

# Per-extension scoped SQLite data layer

**Status:** Draft (frozen for DECOMPOSE)
**Author:** spec-data-layer (SPECIFY stage, Shapes program W6)
**Date:** 2026-07-17
**Tracker:** DOR-358 (Shapes W6 — prerequisite for CRM-lite reference shape P4)

## Overview

DorkOS extensions today persist state as a single JSON blob overwritten whole on
every save (`api.saveData(obj)` → `PUT /api/extensions/:id/data` → one
`data.json`, `apps/server/src/routes/extensions.ts:289-312`). There is no query,
no index, no partial update, and — over the web bridge — a de-facto **1 MB**
ceiling from `express.json({ limit: '1mb' })` (`apps/server/src/app.ts:105`).
That cannot back a CRM, a content pipeline, or any shape that accumulates rows.

This spec gives every extension a **scoped SQLite database of its own** — one
file per extension, isolated by construction, with a parameterized-SQL query API,
schema declared as versioned SQL migrations in the manifest, per-extension size
quotas, and a migration/rollback story consistent with the marketplace install
transaction (ADR-0304). It is workstream **W6** of the Shapes program and the
hard prerequisite for the CRM-lite reference shape (P4). The acceptance bar is
concrete: **contacts + pipeline tables with follow-up queries must be expressible
with zero escape hatches** (§CRM-lite validation).

Managed sync / multi-user hosted data — the post-launch revenue line — is
**out of scope** and named as future without being designed
(`plans/shapes-program.md` W6).

## Background / Problem Statement

Verified against the codebase (2026-07-17):

- **The blob store is two methods.**
  `packages/extension-api/src/extension-api.ts:100-106` declares
  `loadData<T>(): Promise<T | null>` and `saveData<T>(data: T): Promise<void>`.
  Server-side extensions get the same pair under
  `DataProviderContext.storage` (`packages/extension-api/src/server-extension-api.ts:42-46`),
  beside `secrets` (AES-256-GCM) and `settings` (plaintext) key-value stores.
- **It writes one file, whole, every time.**
  `apps/server/src/services/extensions/extension-server-api-factory.ts:49-66`
  writes `path.join(dorkHome, 'extension-data', extensionId, 'data.json')` via
  `JSON.stringify(data, null, 2)` + atomic temp+rename. The web route
  (`routes/extensions.ts:289-312`) writes `req.body` the same way, with the path
  resolved scope-aware by `resolveDataPath(id, manager, dorkHome, getCwd)`
  (`routes/extensions.ts:537-553`): local extensions →
  `cwd/.dork/extension-data/:id/data.json`, global → `dorkHome/extension-data/:id/data.json`.
  Real usage (`apps/server/src/core-extensions/linear-issues/server.ts:213-250`)
  is load-whole-blob → compare → rewrite-whole-blob.
- **The only size limit is incidental.** `express.json({ limit: '1mb' })`
  (`app.ts:105`) caps the client `saveData` body at 1 MB; the server-ext factory
  path has no ceiling at all. There is no per-extension quota, row cap, or query
  guard anywhere (grep for `quota`/`maxSize` in the extension services: none).
- **The manifest cannot declare data.**
  `ExtensionManifestSchema` (`packages/extension-api/src/manifest-schema.ts:90-121`)
  has `serverCapabilities` (serverEntry, externalHosts, secrets[], settings[])
  but **no** storage/schema declaration; `permissions` is "Reserved for future
  permission model."
- **The bridge is raw `fetch`, not `Transport`.** `loadData`/`saveData` in
  `apps/client/src/layers/features/extensions/model/extension-api-factory.ts:189-203`
  call `fetch(extensionApiUrl('/extensions/:id/data'))` directly.
  `packages/shared/src/transport.ts` has **zero** extension methods. So the whole
  extension-data surface is **HTTP/web-only** — there is no Obsidian
  `DirectTransport` (in-process) path. Extension identity at the bridge is the
  **URL path param `:id`** (validated by `SAFE_EXT_ID = /^[a-z0-9][a-z0-9-]*$/`,
  `routes/extensions.ts:65`); there is no header/token/agent context. The server
  authorizes by existence only (`extensionManager.get(id)`), which returns even
  disabled extensions.
- **Uninstall never touches `extension-data/`.**
  `apps/server/src/services/marketplace/flows/uninstall.ts:116-140` moves the
  package dir aside and, when `purge:false`, restores only
  `<installRoot>/.dork/data/` + `<installRoot>/.dork/secrets.json`. The
  top-level `dorkHome/extension-data/:id/` store is **outside** any install root,
  so extension runtime state survives uninstall untouched — and is **not** even
  removed by `--purge` (a gap this spec closes).

The SQLite house style already exists and is what we mirror:
`packages/db/src/index.ts:10-47` — `createDb(dbPath)` opens `better-sqlite3`
with pragmas `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
`foreign_keys=ON`; `runMigrations(db)` applies drizzle-kit SQL from
`packages/db/drizzle/`. Schemas are `sqliteTable` with snake_case columns, ULID
`text().primaryKey()`, enum `text(col,{enum})`, boolean `integer(col,{mode:'boolean'})`,
ISO-text timestamps, TSDoc on every table.

## Goals

- One **isolated SQLite database per extension**; an extension can never read or
  write another extension's data.
- A **parameterized-SQL query API** (`query`/`run`/`transaction`) usable from a
  client extension (over the bridge) and a server extension (in-process), with
  **zero escape hatches** for the CRM-lite validation case.
- **Schema declared in the manifest** as Zod-validated versioned SQL migrations,
  applied append-only, with a byte-for-byte rollback on failure consistent with
  ADR-0304.
- **Per-extension size quota** + result row/byte caps, enforced server-side.
- **Injection-proof by construction**; DDL confined to migrations; `ATTACH`,
  `PRAGMA`, and multi-statement input rejected at runtime.
- Lifecycle consistency: data **survives** default uninstall/reinstall; `--purge`
  truly removes it.

## Non-Goals

- Managed sync / multi-user hosted data (post-launch revenue line).
- Per-agent / per-scope data partitioning (data stays global-by-`id`,
  assumption **A-SCOPE-GLOBAL**).
- Promoting extension data onto the `Transport` port for Obsidian in-process
  parity (**A-WEB-FIRST**) — a documented follow-up; the DB layer is HTTP-only
  in v1, exactly like the blob store it extends.
- A typed query-builder / Drizzle-subset / ORM codegen for extension authors
  (raw parameterized SQL is the surface; an ergonomic wrapper is a later option).
- Full-text search, vector columns, cross-extension shared tables.
- A per-statement wall-clock timeout (**A-BSQLITE-SYNC**: `better-sqlite3` is
  synchronous; v1 relies on row/byte/quota caps, worker-thread timeout deferred).
- Removing `loadData`/`saveData` in this spec (Decision 9: additive now,
  collapse onto a reserved KV table as a fast-follow).

## Technical Dependencies

- `better-sqlite3` `^12.11.1` and `drizzle-orm` `^0.45.2` — already deps of
  `@dorkos/db` (`packages/db/package.json`). The new per-extension connection
  reuses `better-sqlite3` directly; it does **not** use the shared `dork.db`
  Drizzle instance (schema is extension-owned, not DorkOS-owned).
- `zod` — the manifest `storage` block and all wire DTOs are Zod schemas
  (authoritative per `AGENTS.md` "no stringly-typed code").
- `conf` (config-manager) — the global quota-default config field ships via a
  semver-keyed migration (`adding-config-fields` skill).
- `@dorkos/extension-api` (author contract), `@dorkos/shared` (wire types).
- No new runtime dependency is introduced.

## Detailed Design

### 1. Storage model — one file per extension

Each extension gets a single SQLite database file:

```
<dorkHome>/extension-data/<id>/store.db          # global extensions
<cwd>/.dork/extension-data/<id>/store.db         # local (project-scoped) extensions
```

plus WAL sidecars `store.db-wal` / `store.db-shm`. `<id>` is the manifest `id`
(kebab-case, `SAFE_EXT_ID`). The directory is exactly the one the blob store
already uses, so the DB file sits **beside** the legacy `data.json`. This is
deliberate: the store inherits the existing per-extension lifecycle (§6) with
zero new disk surface.

**Path resolution is extracted and shared.** `resolveDataPath` in
`routes/extensions.ts:537-553` currently hard-codes the `data.json` filename.
Refactor it into a shared helper so the blob path and the DB path derive from
one scope-aware base:

```ts
// apps/server/src/services/extensions/extension-data-paths.ts (NEW)
/** Absolute per-extension data directory (scope-aware), or null if unresolvable. */
export function resolveExtensionDataDir(
  id: string,
  manager: ExtensionManager,
  dorkHome: string,
  getCwd: () => string | null
): string | null;

/** `<dataDir>/data.json` — the legacy blob path. */
export function resolveBlobPath(...): string | null;

/** `<dataDir>/store.db` — the SQLite database path. */
export function resolveDbPath(...): string | null;
```

`resolveDataPath`'s existing callers switch to `resolveBlobPath` (no behavior
change); the DB layer uses `resolveDbPath`. **No `os.homedir()`** — `dorkHome`
is always threaded in (Hard Rule 3).

**Connection.** A new `ExtensionDatabase` service opens the file with the
`packages/db` pragmas and never bundles a Drizzle schema:

```ts
// apps/server/src/services/extensions/extension-database.ts (NEW)
import Database from 'better-sqlite3';

function openExtensionDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
```

Connections are cached per `id` in an LRU (open is cheap but non-zero; a hot CRM
shape queries repeatedly). Cache eviction closes the handle. `better-sqlite3` is
synchronous, so all executor calls are synchronous under the hood and wrapped in
`Promise.resolve` at the async boundary.

**`better-sqlite3` is confined.** It is a native addon already externalized in
the CLI/desktop bundlers (`apps/desktop/scripts/rebuild-natives.ts`). The import
lives only in `apps/server` service code (no FSD/client import), same as
`@dorkos/db`.

### 2. Isolation guarantees

Isolation is **structural**, not policy:

1. The server computes the DB path from the **`:id` path param only** (via
   `resolveDbPath`), never from the request body. An extension's SDK closes over
   its own `id` (`createExtensionAPI(extId, …)`,
   `extension-api-factory.ts:38`), so it can only ever address its own file.
2. `SAFE_EXT_ID` (existing) blocks path traversal in `:id`.
3. `ATTACH DATABASE` / `DETACH` are on the statement denylist (§4), so even
   server-side no query can open a second file. One connection sees exactly one
   extension's tables.

Result: **no query can span two extensions' data**, and an extension cannot name
another's database through the API. (Per-caller authentication of a local
request is the existing localhost posture — assumption **A-LOCALHOST-TRUST**,
DOR-278; not tightened here.)

### 3. Schema declaration — versioned migrations in the manifest

Add an optional `storage` block to `ExtensionManifestSchema`
(`packages/extension-api/src/manifest-schema.ts`). All Zod, all
Zod-expressible:

```ts
/** One forward-only schema migration for an extension's database. */
export const StorageMigrationSchema = z.object({
  /** Monotonic, 1-based version. Must equal its 1-based index + 1 across the array. */
  version: z.number().int().positive(),
  /** Optional human note surfaced in migration errors/logs. */
  name: z.string().optional(),
  /**
   * The migration body: one or more DDL/DML statements applied in a single
   * SQLite transaction. DDL (CREATE/ALTER/DROP TABLE|INDEX, CREATE TRIGGER) is
   * allowed HERE and only here — the runtime query API forbids it (§4).
   */
  up: z.string().min(1),
});

/** Per-extension storage declaration. */
export const StorageDeclarationSchema = z
  .object({
    /**
     * Requested byte quota for this extension's database. Clamped to the host
     * maximum (`extensions.dataQuotaBytes`, config-manager). Omitted = host default.
     */
    quotaBytes: z.number().int().positive().optional(),
    /** Ordered, append-only migrations. Versions must be 1..N with no gaps. */
    migrations: z.array(StorageMigrationSchema),
  })
  .strict()
  .refine((s) => s.migrations.every((m, i) => m.version === i + 1), {
    message: 'storage.migrations must be numbered 1..N in order with no gaps',
  });

// ExtensionManifestSchema gains:  storage: StorageDeclarationSchema.optional(),
```

**Why SQL migrations, not a JSON table-DSL** (Decision 4): the DorkOS DB house
style is drizzle-kit SQL files (`packages/db/drizzle/0000..0028_*.sql`). A JSON
DSL would mean inventing and validating a schema language and translating it to
SQL, losing indexes / triggers / CHECK / FK expressivity. Shipping SQL matches
the repo and gives full SQLite power — which the CRM criterion needs. The Zod
envelope validates **structure** (monotonic versions, non-empty bodies); SQLite
validates **semantics** at apply time inside a transaction (§5).

**Why in the manifest** and not loose files: the manifest is the single declared
contract the loader already parses; keeping migrations there means the schema is
reviewable in one place, versioned with the extension, and available before any
code runs. Append-only is enforced by the `1..N` refinement + review discipline
(never edit a shipped migration; add the next version) — the same rule
config-manager states for `CONFIG_MIGRATIONS` (`config-manager.ts:26-52`).

**Applied-version tracking.** Each extension DB carries a reserved meta table
(created by the migrator, invisible to the author's schema namespace by the
`_dork_` prefix):

```sql
CREATE TABLE IF NOT EXISTS _dork_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- row: ('schema_version', '<highest applied migration version>')
```

This mirrors drizzle's `__drizzle_migrations` journal and config-manager's
in-file `__internal__.migrations.version`.

### 4. Query API surface

#### 4a. Author-facing API (client + server)

Both the client `ExtensionAPI` and the server `DataProviderContext` gain the same
`data` object:

```ts
/** A value bindable to a SQL `?` placeholder (better-sqlite3 bindable types). */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/** Result of a mutating statement. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** One step in an atomic transaction. */
export interface SqlStep {
  sql: string;
  params?: SqlValue[];
}

/** Scoped SQLite access for this extension. Injection-proof; DDL only via migrations. */
export interface ExtensionDataAPI {
  /** Run one SELECT (or WITH…SELECT). Returns typed rows, capped (§4c). */
  query<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** Run one INSERT / UPDATE / DELETE. Returns changes + lastInsertRowid. */
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  /** Run steps atomically (all-or-nothing) in one SQLite transaction. */
  transaction(steps: SqlStep[]): Promise<RunResult[]>;
}
```

Added to `ExtensionAPI` as `readonly data: ExtensionDataAPI`
(`packages/extension-api/src/extension-api.ts`) and to `DataProviderContext` as
`readonly data: ExtensionDataAPI`
(`packages/extension-api/src/server-extension-api.ts`).

**Parameterized only.** Values reach SQL exclusively through the `params` array,
bound by `better-sqlite3` prepared statements — never string-interpolated. There
is no `sql\`…\``template or format helper in the surface, so an author *cannot*
build a statement by concatenating untrusted values into`sql` and have it
treated as anything but the literal statement text. This is the injection
guarantee, by construction.

#### 4b. Statement guard (server-side, `sql-guard.ts`)

Every incoming statement passes a guard before execution:

- **Single statement only.** `better-sqlite3`'s `db.prepare(sql)` compiles
  exactly one statement and throws on trailing SQL — a structural guard against
  `"…; DROP TABLE …"`. The guard additionally rejects any input whose tokenizer
  finds a statement separator outside a string/comment.
- **Leading-keyword allowlist:**
  - `query` → `SELECT` or `WITH` (a CTE resolving to a SELECT). Nothing else.
  - `run` → `INSERT`, `UPDATE`, or `DELETE`.
  - `transaction` → each step classified as `run`.
- **Denylist (rejected on any surface):** `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`,
  `ALTER`, `DROP`, `CREATE`, `REINDEX`, `ANALYZE`, and transaction control
  (`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`) — the executor owns transactions.
  DDL is reachable **only** through migrations (§3).

Guard failures return a typed `ExtensionDbError` with `code: 'STATEMENT_REJECTED'`
and a message naming the reason (never echoing bound values).

#### 4c. Resource limits (server-side)

- **Row cap.** `query` results are capped at `min(host max, requested)`; default
  `1000`, hard max `10000` (config `extensions.dataMaxRows`). The executor wraps
  the author SELECT so the cap is enforced regardless of the query's own LIMIT;
  exceeding it returns the capped rows plus a `truncated: true` flag on the wire
  DTO (the client throws `ROWS_TRUNCATED` so silent truncation is impossible).
- **Byte cap.** Serialized result payload capped (default 8 MB,
  `extensions.dataMaxResultBytes`); over-cap → `RESULT_TOO_LARGE`.
- **Quota (write path).** Before committing a `run`/`transaction`, the executor
  reads `page_count * page_size` (via `db.pragma`) and rejects with
  `QUOTA_EXCEEDED` if the post-write size would exceed the effective quota
  (`manifest.storage.quotaBytes` clamped to `extensions.dataQuotaBytes`, default
  **25 MB**). Because writes run inside a transaction, an over-quota write rolls
  back cleanly.
- **Lock contention.** `busy_timeout=5000` (pragma) handles concurrent writers.
- **Statement wall-clock timeout: deferred (A-BSQLITE-SYNC).**
  `better-sqlite3` is synchronous and exposes no progress handler, so a true
  per-statement timeout would require running each extension DB on a worker
  thread. v1 relies on the row/byte/quota caps + the single-writer, small-DB
  reality; the worker-thread timeout is a documented follow-up. This is stated
  honestly rather than claimed.

### 5. Migration execution & rollback

The migrator (`extension-migrator.ts`) runs when an extension is enabled/loaded
(§6) and on every version bump:

1. Open (or create) `store.db`; ensure `_dork_meta`; read `schema_version`
   (absent = `0`).
2. Read `manifest.storage.migrations`; compute `pending = versions > applied`.
   If the DB's `schema_version` is **greater** than the manifest's highest
   version (installed an older extension over newer data), **refuse to enable**
   with `SCHEMA_DOWNGRADE` — forward-only, no destructive down-migrations
   (matching config-manager's forward-only stance). Nothing is mutated.
3. If `pending` is non-empty: **back up the DB file aside** —
   `cp store.db → store.db.bak-<applied>-<uuid>` — mirroring the marketplace
   backup-aside (ADR-0304, `transaction.ts:128-133`).
4. Apply all pending migrations **inside one SQLite transaction**
   (`BEGIN … COMMIT`), in ascending version order, updating
   `_dork_meta.schema_version` to the highest applied within the same
   transaction.
5. **On any error:** `ROLLBACK`, close + restore the backup file byte-for-byte
   over `store.db`, mark the extension `error` with the migration message
   (surfaced in the UI the same way a failed server-init is today,
   `extension-server-lifecycle.ts`), and **refuse to enable**. This delivers the
   ADR-0304 "previous state intact" guarantee at the row level.
6. On success: delete the backup.

Failure is isolated: one extension's migration failure disables only that
extension; every other extension DB is a separate file and untouched. A
dry-run validation (apply to a `:memory:` copy) runs at package
install/validate time so a broken migration is caught before it reaches a real
DB where practical.

### 6. Lifecycle & retention

- **Install / first enable.** On extension load, the migrator creates `store.db`
  and applies v1..vN (§5). Hooked into the existing
  `ExtensionServerLifecycle.initialize` path
  (`apps/server/src/services/extensions/extension-server-lifecycle.ts`) so a
  migration failure sets the same `error` status a failed server-init sets.
- **Update.** A new package version with additional migrations re-attaches to the
  **same** `store.db` (it lives under `extension-data/`, which the marketplace
  update flow never touches — `uninstall.ts` operates only within the install
  root) and applies the delta. This is the safe-update guarantee.
- **Uninstall (default, `purge:false`).** Data **survives** — `extension-data/:id/`
  is outside every install root, so `uninstall.ts:116-140` never removes it.
  Reinstalling re-attaches to the existing DB.
- **Uninstall `--purge`.** Extend `flows/uninstall.ts` to additionally remove
  `extension-data/:id/` (global) and, when a `projectPath` is given,
  `<projectPath>/.dork/extension-data/:id/` (local). This **closes the current
  gap** where `--purge` leaves extension state behind, making `--purge` mean
  "remove everything," consistent with the documented `.dork/data/` semantics
  (`contributing/marketplace-installs.md` §4).
- **Recovery.** The extension DB is the **source of truth** (unlike the ADR-0043
  derived-cache stores, there is no file-first mirror and therefore **no
  reconciler**). The user's escape hatch is deleting `store.db`; the next enable
  rebuilds an empty schema from migrations (data lost — documented).

### 7. Bridge (transport boundary)

**Client extensions** (React, in-browser). Add three scoped routes to the
extensions router (`apps/server/src/routes/extensions.ts`, mounted at
`/api/extensions`, `index.ts:1003-1006`):

```
POST /api/extensions/:id/db/query        { sql, params? }   -> { rows, truncated }
POST /api/extensions/:id/db/run          { sql, params? }   -> { changes, lastInsertRowid }
POST /api/extensions/:id/db/transaction  { steps: SqlStep[] } -> { results: RunResult[] }
```

Each handler: validate `SAFE_EXT_ID`; require `extensionManager.get(id)` exists
(404 otherwise — same authorization model as the blob routes); resolve the DB via
`resolveDbPath`; hand `(sql, params)` to the executor. Request/response bodies are
Zod DTOs in `@dorkos/shared` (`extension-db-dto.ts`).

The client `api.data` methods follow the **existing extension-data seam** — raw
`fetch` via `extensionApiUrl(...)`
(`extension-api-factory.ts`), exactly like `loadData`/`saveData`. Concretely:

```ts
// extension-api-factory.ts (new methods on the returned api.data)
async query(sql, params) {
  const res = await fetch(extensionApiUrl(`/extensions/${extId}/db/query`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw await toExtensionDbError(res);
  const body = QueryResultDto.parse(await res.json());
  if (body.truncated) throw new ExtensionDbError('ROWS_TRUNCATED', ...);
  return body.rows;
}
```

**Server extensions** (Node, in-process). `DataProviderContext.data` is wired
directly to the executor in
`apps/server/src/services/extensions/extension-server-api-factory.ts` — no HTTP,
mirroring how `ctx.storage` already binds in-process. The executor is the single
shared implementation both paths call.

**Honest boundary (A-WEB-FIRST).** Like the entire extension-data surface, this
bridge is **HTTP-only** — there is no Obsidian `DirectTransport` path, because
extension data was never promoted onto the `Transport` port
(`packages/shared/src/transport.ts` has no extension methods). Promoting the DB
API (and the pre-existing blob API) onto `Transport` for embedded parity is a
documented follow-up, out of scope for v1. The author-facing `api.data`
signatures are chosen so that later change is a wire-path swap with no API break.

### 8. CRM-lite validation (the acceptance criterion)

This worked example must be expressible **with zero escape hatches**. It ships as
a conformance test (§Testing) driving the real routes.

**Manifest `storage` block** (contacts + pipeline):

```jsonc
"storage": {
  "quotaBytes": 26214400,
  "migrations": [
    {
      "version": 1,
      "name": "contacts + pipeline",
      "up": "CREATE TABLE contacts ( id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, company TEXT, created_at TEXT NOT NULL, next_follow_up TEXT ); CREATE TABLE deals ( id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, title TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'lead', amount_cents INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL ); CREATE INDEX idx_deals_stage ON deals(stage); CREATE INDEX idx_contacts_follow_up ON contacts(next_follow_up);"
    }
  ]
}
```

**Writes** (parameterized `run` / `transaction`):

```ts
await api.data.run(
  'INSERT INTO contacts (id, name, email, company, created_at, next_follow_up) VALUES (?, ?, ?, ?, ?, ?)',
  [id, name, email, company, now, followUp]
);
await api.data.transaction([
  {
    sql: 'INSERT INTO deals (id, contact_id, title, stage, amount_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    params: [dealId, contactId, title, 'lead', 500000, now],
  },
  { sql: 'UPDATE contacts SET next_follow_up = ? WHERE id = ?', params: [followUp, contactId] },
]);
```

**The follow-up query** — "contacts due for follow-up today or earlier who have
an open deal in the negotiation stage, most valuable first" — a parameterized
join + aggregate + date predicate, no raw interpolation:

```ts
const due = await api.data.query<{
  contact_id: string;
  name: string;
  next_follow_up: string;
  open_value: number;
}>(
  `SELECT c.id AS contact_id, c.name, c.next_follow_up,
          SUM(d.amount_cents) AS open_value
     FROM contacts c
     JOIN deals d ON d.contact_id = c.id
    WHERE c.next_follow_up <= ?
      AND d.stage = ?
    GROUP BY c.id
    ORDER BY open_value DESC`,
  [today, 'negotiation']
);
```

Every clause a CRM needs — join, aggregate, `GROUP BY`, `ORDER BY`, date
comparison, stage filter — is a first-class SQL clause bound with `?` params.
There is **no escape hatch**: nothing in the example (or the API) requires
falling back to string-built SQL, a second store, or an unsafe primitive.

## User Experience

- **Extension author (Kai / Ikechi via an agent):** declares tables in the
  manifest `storage.migrations`, then calls `api.data.query/run/transaction`.
  Errors are typed and specific (`QUOTA_EXCEEDED`, `STATEMENT_REJECTED`,
  `ROWS_TRUNCATED`, `SCHEMA_DOWNGRADE`) with plain-language messages
  (`writing-for-humans`) — e.g. "This extension's data has reached its 25 MB
  limit. Remove rows or raise the limit in its manifest." No dark corners: a
  rejected statement says exactly which rule it broke.
- **Agent-driven ("one prompt modifies a shape"):** because the surface is
  ordinary parameterized SQL, an agent writing the extension can author schema
  and queries directly — no bespoke DSL to learn.
- **Operator:** data survives updates and reinstalls silently; `--purge` removes
  it and says so. Recovery is "delete `store.db`."
- **Entry points:** `api.data` (client), `ctx.data` (server),
  `manifest.storage` (schema). Error path: typed throw at the call site. Exit
  path: uninstall preserves; `--purge` removes.

## Testing Strategy

- **Unit — schema (`packages/extension-api`):** `StorageMigrationSchema` /
  `StorageDeclarationSchema` accept a valid 1..N sequence; reject gaps,
  duplicates, zero/negative versions, empty `up`, and unknown keys (`.strict()`).
  `ExtensionManifestSchema` round-trips with and without `storage`.
- **Unit — path resolution (`apps/server`):** `resolveExtensionDataDir` /
  `resolveBlobPath` / `resolveDbPath` return the correct scope-aware paths
  (global vs local); `resolveBlobPath` matches the pre-refactor `resolveDataPath`
  exactly (a golden test proving no behavior change). `SAFE_EXT_ID` rejection.
- **Unit — statement guard (`sql-guard.ts`):** allow single `SELECT`/`WITH` on
  `query`; allow `INSERT`/`UPDATE`/`DELETE` on `run`; reject `ATTACH`, `PRAGMA`,
  `DROP`, `CREATE`, transaction control, and any multi-statement
  (`"SELECT 1; DROP TABLE t"`) on both surfaces — each case a purpose comment,
  each able to fail.
- **Unit — executor (`extension-database.ts` + executor, `:memory:` DB):**
  parameterized round-trips (bound `?` values, incl. `null`/`bigint`/`Uint8Array`);
  an injection attempt via a param value is stored as data, never executed; row
  cap truncates + flags; byte cap trips `RESULT_TOO_LARGE`; quota trips
  `QUOTA_EXCEEDED` and rolls the write back (row count unchanged); `transaction`
  is all-or-nothing (a failing step reverts prior steps).
- **Unit — migrator:** fresh DB applies 1..N and stamps `_dork_meta`; a bump
  applies only the delta; a failing migration rolls back, restores the backup
  byte-for-byte, and leaves `schema_version` unchanged; a downgrade refuses with
  `SCHEMA_DOWNGRADE`; append-only 1..N gap is rejected at load.
- **Integration — routes (`apps/server`, real Express + real SQLite):** the three
  `/db/*` routes end-to-end for an installed extension; 404 for an unknown `:id`;
  400 for a malformed `:id`; a mutating statement on `/db/query` rejected; a
  transaction commits atomically.
- **Integration — CRM-lite conformance (the acceptance gate):** run §8 verbatim
  through the real routes — apply the migration, insert contacts + deals, run the
  follow-up query, assert the ranked result. A guard assertion proves the example
  uses only `api.data` (no `saveData`, no second store) — the "zero escape
  hatches" proof.
- **Client (`apps/client`, RTL + jsdom, mocked `fetch`):** `api.data.query/run`
  post the right body to the right URL; `truncated:true` throws `ROWS_TRUNCATED`;
  a non-2xx maps to a typed `ExtensionDbError`.
- **Lifecycle:** uninstall (`purge:false`) leaves `store.db` in place; `--purge`
  removes `extension-data/:id/` (both scopes); reinstall re-attaches and applies
  new migrations.
- **Mocking strategy:** server tests use a real on-disk temp SQLite (per the
  `better-sqlite3` precedent in `packages/db` tests) or `:memory:`; the extension
  manager is the real one seeded with a discovered fixture extension; client
  tests mock `fetch` only. No mocking of SQLite itself.

## Performance Considerations

- Per-extension connections are cached (LRU) — open cost is paid once per hot
  extension, not per call.
- WAL + `synchronous=NORMAL` (house pragmas) give good write throughput with
  single-writer safety; `busy_timeout` absorbs contention.
- Because `better-sqlite3` is synchronous, a pathological query blocks the event
  loop. Mitigations: row/byte caps (hard), the small single-extension DB size
  (quota-bounded), and — deferred — a worker-thread executor for a true
  statement timeout (A-BSQLITE-SYNC). Called out honestly, not hidden.
- Indexes are author-declared in migrations (see §8) — the layer neither adds nor
  prevents them.

## Security Considerations

- **Injection:** parameterized-only surface (§4a) + prepared-statement binding →
  values are never executed as SQL. The statement guard (§4b) rejects
  multi-statement input and DDL/`ATTACH`/`PRAGMA` on the runtime path.
- **Isolation:** structural (§2) — one file, one connection, server-derived path,
  no `ATTACH`. Cross-extension reads are impossible, not merely disallowed.
- **Authorization at the bridge:** the server resolves the DB from the `:id` path
  param and requires the extension to exist — the same model the blob/secrets/
  settings routes already use. Per-caller authentication is the existing
  localhost posture (A-LOCALHOST-TRUST, DOR-278); this spec does not weaken it and
  does not claim to strengthen it.
- **Resource exhaustion:** quota + row cap + byte cap + `busy_timeout` (§4c). The
  wall-clock-timeout gap is disclosed, not glossed.
- **DDL confinement:** schema change is reachable only through reviewed,
  append-only manifest migrations run in a rolled-back-on-failure transaction.
- **Secrets stay separate:** encrypted secrets remain in the existing
  `ExtensionSecretStore` (`extension-secrets/:id.json`, AES-256-GCM) — the DB is
  for structured application data, not credentials. Migration bodies and query
  logs never echo bound values.

## Documentation

- New developer guide `contributing/extension-data-layer.md` (via
  `writing-developer-guides`): storage model, the `storage` manifest block,
  the `api.data` surface, quotas/limits, the migration lifecycle, and the CRM
  example. Add to `contributing/INDEX.md`.
- Update `contributing/marketplace-installs.md` §4 to note `--purge` now also
  removes `extension-data/:id/`.
- User-facing docs: an extensions "store data" concept page + the CRM snippet.
- `contributing/configuration.md`: document the new `extensions.dataQuotaBytes` /
  `dataMaxRows` / `dataMaxResultBytes` config fields.
- A draft ADR ("Per-extension scoped SQLite over parameterized SQL") extracted at
  `/adr:from-spec` time.

## Implementation Phases

- **Phase 1 — Substrate:** manifest `storage` schema; shared path resolver;
  `ExtensionDatabase` connection + `_dork_meta`; migrator with backup-aside
  rollback.
- **Phase 2 — Query engine:** `sql-guard`; executor (query/run/transaction) with
  row/byte/quota caps + typed errors; `ctx.data` in-process wiring.
- **Phase 3 — Bridge:** `/db/*` routes + Zod DTOs; client `api.data` on
  `ExtensionAPI` + factory `fetch` impl.
- **Phase 4 — Lifecycle + config:** migrator hooked into extension enable;
  `--purge` extension-data cleanup; global quota/limit config fields + migration.
- **Phase 5 — Validation + docs:** CRM-lite conformance test; developer guide +
  docs; example extension.

## Open Questions

- **Blob-store collapse (Decision 9).** v1 ships `api.data` additively and keeps
  `loadData`/`saveData`. The single-substrate endgame is to re-implement the blob
  API over a reserved `_dork_kv` table in `store.db` and remove the standalone
  `data.json` path. Deferred so migrating shipped extensions (e.g.
  `linear-issues`) is its own change, not a gate on landing the substrate. Filed
  as a fast-follow.
- **Per-scope data (A-SCOPE-GLOBAL).** Data is global-by-`id` today. If a future
  shape needs per-agent CRM data, the DB path would need a scope/`projectPath`
  dimension — a new key not present in any existing extension store. Not decided
  here.
- **Worker-thread executor (A-BSQLITE-SYNC).** Whether/when to move extension DBs
  onto a worker for a true statement timeout. Deferred; row/byte/quota caps cover
  v1.
- **Transport promotion (A-WEB-FIRST).** Whether to lift extension data (blob +
  DB) onto the `Transport` port for Obsidian in-process parity. Deferred.

## Related ADRs

- `decisions/0304-file-scoped-rollback-for-marketplace-installs.md` — the
  backup-aside → atomic-activate → restore-on-failure pattern the migrator
  mirrors at the row level.
- `decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md` —
  file-first write-through + derived cache + reconciler; the **contrast** (the
  extension DB is a source of truth, so it has no reconciler).
- ADR-0310 (runtime-owned session storage) — precedent for domain-owned storage
  rather than a single unified store.
- A new ADR to be extracted from this spec (per-extension SQLite + parameterized
  SQL + manifest migrations).

## References

- Current blob store: `packages/extension-api/src/extension-api.ts:100-106`;
  `apps/server/src/services/extensions/extension-server-api-factory.ts:49-66`;
  `apps/server/src/routes/extensions.ts:266-312,526-553`;
  `apps/client/src/layers/features/extensions/model/extension-api-factory.ts:189-203`;
  `apps/server/src/app.ts:105`.
- SQLite house style: `packages/db/src/index.ts:10-47`;
  `packages/db/src/schema/{tasks,mesh}.ts`; `packages/db/drizzle/`.
- Manifest: `packages/extension-api/src/manifest-schema.ts:90-121`.
- Data dir: `apps/server/src/lib/dork-home.ts`.
- Config migrations: `apps/server/src/services/core/config-manager.ts:609-757`;
  `contributing/configuration.md`; `adding-config-fields` skill.
- Marketplace lifecycle: `apps/server/src/services/marketplace/transaction.ts`;
  `.../flows/uninstall.ts:116-140,235-253`;
  `contributing/marketplace-installs.md` §4, §16.
- Program: `plans/shapes-program.md` (W6, P4, "Explicitly not doing").
