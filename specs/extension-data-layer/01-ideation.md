---
slug: extension-data-layer
id: 260718-042902
created: 2026-07-17
status: ideation
linearIssue: DOR-358
---

# Per-extension scoped SQLite data layer

**Slug:** extension-data-layer
**Author:** spec-data-layer (IDEATE stage, Shapes program W6)
**Date:** 2026-07-17

---

## 1) Intent & Assumptions

- **Task brief:** Replace the single-JSON-blob storage limit for DorkOS
  extensions with a **per-extension scoped SQLite database** — a real
  relational store an extension can declare tables against, query, and grow.
  This is workstream **W6** of the Shapes program (`plans/shapes-program.md`)
  and the hard prerequisite for **CRM-grade shapes** (reference shape P4 —
  contacts + pipeline + overnight follow-ups). The validation bar: contacts +
  pipeline tables with follow-up queries must be expressible **with zero escape
  hatches**.
- **Why now:** Today an extension's entire persistent state is one JSON blob
  overwritten whole on every save (see §3). Anything list-shaped — contacts,
  deals, activity logs — means load-the-whole-file, mutate in memory, rewrite
  the whole file, with no query, no index, no partial update, and (for the web
  bridge) a de-facto **1 MB ceiling** from the Express body limit. That does not
  support a CRM, a content pipeline, or any shape that accumulates rows.

- **Assumptions (marked explicitly):**
  1. **A-SCOPE-GLOBAL:** Extension data stays keyed by the manifest `id` at the
     existing scope the blob store already uses (global under `dorkHome`,
     local-scoped under `cwd/.dork/`). We do **not** add a new per-agent data
     dimension — extension identity and state are global-by-`id` today
     (`contributing/marketplace-installs.md` §16: "Extension enable/disable is
     global — it has no per-agent dimension"). Per-scope data isolation is
     called out as a future decision, not designed here.
  2. **A-LOCALHOST-TRUST:** The bridge trusts a well-formed local `:id` path
     param the same way the existing extension-data/secrets/settings routes do
     (`apps/server/src/routes/extensions.ts`). Per-caller authentication of
     "is this request really that extension?" is the existing localhost posture
     (DOR-278 / `specs/mcp-local-auth-posture`), not something this spec
     tightens.
  3. **A-BSQLITE-SYNC:** `better-sqlite3` is synchronous and single-threaded
     (verified: `packages/db/src/index.ts`). A per-statement wall-clock timeout
     is therefore not natively available; v1 leans on hard row/byte/quota caps
     and defers a worker-thread timeout.
  4. **A-WEB-FIRST:** The launch-critical surface is the web cockpit
     (`AGENTS.md`). The existing extension-data bridge is HTTP-only (no Obsidian
     `DirectTransport` path — see §5); the DB layer inherits that boundary in
     v1 rather than blocking on a Transport refactor.

- **Out of scope (explicit):**
  - **Managed sync / multi-user hosted data** — the post-launch revenue line
    (Obsidian-Sync playbook, `plans/shapes-program.md` W6 + "Explicitly not
    doing"). Named as future; **not** designed here.
  - Per-agent / per-scope data partitioning (A-SCOPE-GLOBAL).
  - Promoting extension data onto the `Transport` port for Obsidian in-process
    parity (A-WEB-FIRST) — a documented follow-up.
  - Full-text search, vector columns, cross-extension shared tables, an ORM /
    typed query-builder codegen for extension authors.

## 2) Pre-reading Log

- `plans/shapes-program.md` (W6 row + P4 CRM-lite + "Explicitly not doing"):
  W6 scope is storage design + schema/migration story + query API surface;
  managed sync is out. CRM-lite (P4) is the downstream consumer and depends on
  W6. Success criterion "one prompt modifies a shape" implies the data API must
  be agent-drivable.
- `packages/extension-api/src/extension-api.ts` (lines 100-106): the current
  persistence surface is exactly two methods, `loadData<T>()` / `saveData<T>()`.
- `packages/extension-api/src/server-extension-api.ts` (lines 36-55): server
  extensions get `DataProviderContext.storage.{loadData,saveData}` plus
  `secrets` (encrypted) and `settings` (plaintext) key-value stores.
- `apps/server/src/services/extensions/extension-server-api-factory.ts` (lines
  49-66): the blob is a single `data.json`, whole-file read + atomic
  temp+rename write, at `path.join(dorkHome, 'extension-data', extensionId,
'data.json')`.
- `apps/server/src/routes/extensions.ts` (lines 266-312, 526-553): the web
  bridge — `GET/PUT /api/extensions/:id/data`, path resolved by
  `resolveDataPath(id, manager, dorkHome, getCwd)` (scope-aware: local → cwd,
  global → dorkHome). `SAFE_EXT_ID = /^[a-z0-9][a-z0-9-]*$/` (line 65).
- `apps/server/src/app.ts:105`: `express.json({ limit: '1mb' })` — the de-facto
  per-extension ceiling for the client blob path.
- `apps/client/src/layers/features/extensions/model/extension-api-factory.ts`
  (lines 189-203): `loadData`/`saveData` are **raw `fetch`** to
  `extensionApiUrl('/extensions/:id/data')` — NOT the `Transport` port.
- `packages/db/src/index.ts` (lines 10-47): the SQLite house style —
  `createDb(dbPath)` opens `better-sqlite3` with pragmas (`journal_mode=WAL`,
  `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`) and wraps it in
  Drizzle; `runMigrations(db)` applies drizzle-kit SQL migrations from
  `packages/db/drizzle/`.
- `packages/db/src/schema/tasks.ts`, `mesh.ts`: table-definition house style —
  `sqliteTable`, snake_case columns, `text().primaryKey()` (ULID), enums via
  `text(col,{enum})`, booleans via `integer(col,{mode:'boolean'})`, timestamps
  as ISO `text`, JSON as `_json text`, TSDoc on every table.
- `apps/server/src/lib/dork-home.ts`: only exports `resolveDorkHome()`; callers
  compose `path.join(dorkHome, ...)`. Prod `~/.dork`, dev `.temp/.dork`.
  `os.homedir()` banned outside this file.
- `apps/server/src/services/workspace/workspace-store.ts` +
  `workspace-reconciler.ts`: the ADR-0043 file-first write-through +
  derived-cache + 5-min reconciler pattern (relevant contrast — see §5).
- `apps/server/src/services/core/config-manager.ts` (lines 609-757): `conf`
  semver-keyed migrations (`CONFIG_MIGRATIONS` map, applied in insertion order,
  version stored in-file, append-only, idempotent).
- `apps/server/src/services/marketplace/transaction.ts` +
  `flows/uninstall.ts` + `decisions/0304-file-scoped-rollback-for-marketplace-installs.md`:
  install = stage(tmpdir) → backup target aside → atomic activate → restore on
  failure; uninstall moves the package dir aside, restores `.dork/data/` +
  `.dork/secrets.json` when `purge:false`, and **never touches**
  `dorkHome/extension-data/` (so extension state survives uninstall today, and
  is not even removed by `--purge`).
- `packages/extension-api/src/manifest-schema.ts` (lines 90-121):
  `ExtensionManifestSchema` — has `serverCapabilities` (serverEntry,
  externalHosts, secrets[], settings[]) but **no** storage/data/schema
  declaration; `permissions` is "Reserved for future permission model."

## 3) Codebase Map

- **Primary components/modules:**
  - Public author contract: `packages/extension-api/src/extension-api.ts`
    (client `ExtensionAPI`), `.../server-extension-api.ts`
    (`DataProviderContext`), `.../manifest-schema.ts` (`extension.json` Zod).
  - Current storage impl: `apps/server/src/services/extensions/extension-server-api-factory.ts`
    (server-ext blob), `apps/server/src/routes/extensions.ts` (client blob
    routes + `resolveDataPath`).
  - Client bridge: `apps/client/src/layers/features/extensions/model/extension-api-factory.ts`
    - `.../extension-api-url.ts`.
  - SQLite house style: `packages/db/` (`createDb`, `runMigrations`, schema
    files, `drizzle/`).
  - Data dir: `apps/server/src/lib/dork-home.ts`.
  - Lifecycle: `apps/server/src/services/marketplace/{transaction.ts,flows/uninstall.ts}`;
    `apps/server/src/services/extensions/{extension-manager.ts,extension-server-lifecycle.ts,extension-discovery.ts}`.
- **Shared dependencies:** `@dorkos/db` (`better-sqlite3` ^12.11.1, `drizzle-orm`
  ^0.45.2), `zod` (all schemas), `conf` (config migrations),
  `@dorkos/extension-api`.
- **Data flow TODAY (the thing being replaced):**
  `api.saveData(obj)` → `fetch PUT /api/extensions/:id/data` → `resolveDataPath`
  → whole-file `JSON.stringify` temp+rename to
  `{dorkHome|cwd/.dork}/extension-data/:id/data.json`. Reads are the mirror
  `GET`, `204 → null`. Server-side extensions bypass the route:
  `ctx.storage.saveData` writes the same `data.json` directly (no 1 MB cap).
  Real usage: `apps/server/src/core-extensions/linear-issues/server.ts`
  (lines 213-250) — load whole blob, compare, rewrite whole blob on any change.
- **Feature flags/config:** none for storage today. Config lives in
  `~/.dork/config.json` via `conf` (`services/core/config-manager.ts`); adding a
  global quota default is a semver-keyed migration (`adding-config-fields`).
- **Potential blast radius:** additive — a new `api.data` surface + new
  `/api/extensions/:id/db/*` routes + a new manifest `storage` block + a
  migrator hooked into extension enable. The only edit to existing behavior is
  extending uninstall `--purge` to clean `extension-data/:id/` (closing a real
  gap). Shipped extensions that use `loadData`/`saveData` keep working unchanged.

## 4) Root Cause Analysis

Not a bug fix — omitted. (The 1 MB blob ceiling and lack of query are design
limits, not defects; they are documented in §3 and §5.)

## 5) Research

### Potential solutions

1. **One shared table set in the consolidated `dork.db`, keyed by
   `extension_id`.** Extensions get rows in shared DorkOS tables.
   - Pros: reuses the injected `Db` handle and the drizzle-kit migration folder
     verbatim; one connection.
   - Cons: **breaks isolation** — every extension's data sits in one file with
     one schema; a bug or a crafted query can cross the `extension_id` boundary;
     no per-extension quota; extension-authored schema can't live in the
     DorkOS-owned migration folder. Rejected: isolation is a hard requirement.

2. **One SQLite file per extension** at
   `{dorkHome|cwd/.dork}/extension-data/:id/store.db`, opened with the
   `packages/db` pragmas, migrated by extension-shipped versioned SQL.
   - Pros: **structural isolation** (separate file, separate connection, no
     `ATTACH` allowed → cross-extension reads impossible); per-file byte quota
     is trivial (`page_count * page_size`); inherits the existing
     `extension-data/:id/` lifecycle (survives uninstall, ready to reinstall);
     matches the `{dorkHome}/extension-<kind>/<id>/` convention; the only
     per-entity-file precedent already exists (relay's fallback `index.db`,
     `packages/relay/src/relay-core.ts:157-164`).
   - Cons: many small files; extension-authored migrations can't use the
     DorkOS drizzle-kit folder (needs a small dedicated migrator). Manageable.
   - **Recommended.**

3. **Typed query-builder / Drizzle-subset API for authors.**
   - Pros: type-safe, no raw SQL.
   - Cons: extensions ship their **own** schema at runtime — there is no
     compile-time Drizzle model on the client to build against; any hand-rolled
     builder subset leaves gaps that force a raw-SQL escape hatch, directly
     violating the "zero escape hatches" CRM criterion. Rejected as the primary
     surface (kept as a possible future ergonomic wrapper over raw SQL).

4. **Parameterized SQL API** — `query(sql, params)` / `run(sql, params)` /
   `transaction(steps)`, `?`-placeholders + bound params, DDL forbidden at
   runtime (schema only via migrations).
   - Pros: full SQLite expressivity (joins, aggregates, date predicates,
     indexes, CHECK/FK) → **zero escape hatches**; `better-sqlite3` prepared
     statements bind params (never interpolate) → injection-proof by
     construction; matches the repo (every `@dorkos/db` store writes SQL, not a
     bespoke builder).
   - Cons: authors write SQL (acceptable — the audience is operators/devs and
     agents that write SQL fluently). **Recommended.**

### Schema-declaration options

- **(a) Table DSL in the manifest (JSON).** Would require inventing + validating
  a schema language and translating it to SQL; loses indexes/triggers/CHECK/FK
  without reinventing each. Rejected.
- **(b) Versioned SQL migrations shipped in the manifest `storage` block,
  Zod-validated envelope, applied in ascending integer order, tracked in a
  `_dork_meta` table.** Sequential integers match the drizzle-kit idiom
  (`packages/db/drizzle/0000..0028_*.sql`); declared-in-manifest + append-only +
  in-store version tracking match the `conf` config-migration idiom
  (`config-manager.ts`). Full SQLite power, auditable, gated. **Recommended.**

### Recommendation

Solution **2 + 4 + (b)**: one SQLite file per extension; a parameterized-SQL
query API with DDL confined to migrations; schema declared as versioned SQL in a
new Zod-validated manifest `storage` block, applied by a small house migrator
with backup-aside rollback (ADR-0304 shape). The bridge follows the **existing
raw-`fetch` REST precedent** (the whole extension-data surface already bypasses
`Transport`); server-side extensions get an in-process `ctx.db`.

**Ground-truth correction carried into SPECIFY:** the task brief assumed extension
API calls "bridge over Transport (HttpTransport + DirectTransport)." They do
**not** — `loadData`/`saveData` are raw `fetch` (verified
`extension-api-factory.ts:189-203`; `grep "extension" packages/shared/src/transport.ts`
returns zero matches). So the surface is HTTP/web-only with no Obsidian
in-process path. The DB layer matches this precedent in v1 and records
"promote extension data onto `Transport`" as an explicit follow-up.

## 6) Decisions

| #   | Decision                              | Choice                                                                                                                   | Rationale                                                                                                                   |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Storage model                         | One SQLite file per extension at `extension-data/:id/store.db` (reusing the blob store's scope-aware dir)                | Structural isolation + inherits existing lifecycle; matches `extension-<kind>/<id>/` convention                             |
| 2   | Isolation                             | Server derives the DB path from the authenticated `:id`, one connection per file, `ATTACH` denied                        | An extension can only ever reach its own file; no query can span two extensions                                             |
| 3   | Query surface                         | Parameterized SQL: `query`/`run`/`transaction`, `?`+bound params, DDL forbidden at runtime                               | Zero escape hatches (CRM criterion); injection-proof via prepared statements; matches repo SQL idiom                        |
| 4   | Schema declaration                    | Versioned SQL migrations in a Zod-validated manifest `storage` block; `_dork_meta` tracks applied version; append-only   | Merges the drizzle-kit sequential-SQL idiom with the config-manager append-only/in-store-version idiom                      |
| 5   | Migration rollback                    | Backup DB file aside → apply pending in one SQLite transaction → restore byte-for-byte + refuse-enable on failure        | Mirrors the marketplace install transaction (ADR-0304) "previous state intact" guarantee                                    |
| 6   | Bridge                                | Scoped REST routes `POST /api/extensions/:id/db/{query,run,transaction}` via raw `fetch`; `ctx.db` in-process for server | Consistent with the existing extension-data surface (which bypasses `Transport`); Obsidian parity deferred (A-WEB-FIRST)    |
| 7   | Resource limits                       | Per-extension byte quota (write), result row cap + byte cap (read), `busy_timeout` (locks); worker-thread timeout later  | Real guarantees the blob store never had; honest about `better-sqlite3` sync limits (A-BSQLITE-SYNC)                        |
| 8   | Uninstall/retention                   | Data survives default uninstall (existing behavior); extend `--purge` to remove `extension-data/:id/`                    | Safe reinstall/update by default; closes the current gap where `--purge` leaves extension state behind                      |
| 9   | Relationship to `loadData`/`saveData` | DB ships additively in v1; collapse the blob store onto a reserved `_dork_kv` table is a fast-follow                     | Avoids a risky big-bang migration of shipped extensions (e.g. `linear-issues`) while recording the single-substrate endgame |
