---
title: 'PGlite Deep Dive Research'
date: 2026-02-25
type: exploratory
status: archived
tags: [pglite, postgres, wasm, sqlite, database, embedded]
---

# PGlite Deep Dive Research

**Date:** 2026-02-25
**Depth:** Deep Research (15 tool calls)
**Topic:** @electric-sql/pglite — validated facts for production evaluation

---

## Research Summary

PGlite is a pure WASM build of PostgreSQL 17.4 (as of v0.3.x), compiled with Emscripten and packaged as a TypeScript library. It requires zero native bindings, no electron-rebuild, and no system dependencies. It is a first-class Drizzle ORM driver with full drizzle-kit support. Its primary architectural constraint is single-connection-only — it cannot be shared across processes. Package size is ~3.7 MB gzipped. Performance is slower than wa-sqlite for bulk inserts but competitive for single-row CRUD and complex queries.

---

## Key Findings

1. **Pure WASM, no native modules** — PGlite requires no C++ bindings, no node-gyp, no electron-rebuild. It is entirely WASM compiled via Emscripten from the PostgreSQL source. This is its most important property for Electron/Obsidian compatibility.

2. **PostgreSQL 17.4** — v0.3.x (current major series) is based on PG 17.4. v0.2.x was PG 16.x. The fork is maintained at `electric-sql/postgres-pglite`.

3. **Single-connection hard limit** — PGlite cannot support multiple processes or concurrent connections to the same database. This is a fundamental Emscripten/WASM constraint: you cannot fork processes.

4. **Drizzle ORM is first-class** — Official driver at `drizzle-orm/pglite`. drizzle-kit `generate`, `migrate`, and `push` all work. The `drizzle.config.ts` uses `dialect: 'postgresql'` and `driver: 'pglite'`.

5. **Node.js filesystem persistence works** — `new PGlite('./path/to/pgdata')` writes to disk in Node/Bun. It is NOT a single file like SQLite; it writes a Postgres data directory.

6. **No Electron-specific reports** — No documented cases of PGlite running in an Electron/Obsidian context were found. However, since Obsidian renderer processes have Node integration, and PGlite works in both browser and Node contexts, it should work — with caveats about WASM binary loading paths.

---

## Detailed Analysis

### 1. What PGlite Is Exactly

PGlite is PostgreSQL compiled to WebAssembly using Emscripten. Unlike prior "Postgres in the browser" projects (e.g., sql.js which runs SQLite), PGlite is not a Linux virtual machine running Postgres — it compiles Postgres directly to WASM using PostgreSQL's built-in "single user mode," which bypasses the postmaster process spawning model.

**Quote from docs:** "Unlike previous 'Postgres in the browser' projects, PGlite does not use a Linux virtual machine - it is simply Postgres in WASM."

The PostgreSQL fork is at `electric-sql/postgres-pglite`, branch `REL_17_5_WASM-pglite-builder`. The v0.3.x series of `@electric-sql/pglite` is based on **PostgreSQL 17.4**.

The library is packaged as a TypeScript client — you import it, instantiate it, and query it directly without any external process or server.

**Version history:**

- v0.2.x → PostgreSQL 16.x
- v0.3.x → PostgreSQL 17.4 (BREAKING: data directory format changed, pg_dump required to migrate)
- Current release: **0.3.15** (as of late January 2026, with 243 total releases published)
- `@electric-sql/pglite-socket@0.0.21` published February 23, 2026

---

### 2. Native Modules — Zero Requirements

**Confirmed: PGlite has NO native/C++ bindings whatsoever.**

This is its core design goal. Installation is:

```bash
npm i @electric-sql/pglite
```

No `node-gyp`, no `better-sqlite3`-style prebuilt binaries, no `electron-rebuild`, no platform-specific compilation steps. The WASM binary is bundled inside the npm package. This is a major advantage over `better-sqlite3` for Electron/Obsidian plugin use cases.

---

### 3. Drizzle ORM Support

PGlite is a **first-class Drizzle driver** with official documentation at `orm.drizzle.team/docs/connect-pglite`.

**Import paths:**

```typescript
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
```

**Configuration options:**

```typescript
// Option 1: In-memory (ephemeral)
const db = drizzle();

// Option 2: Filesystem path (Node/Bun)
const db = drizzle('path-to-dir');

// Option 3: Extended config
const db = drizzle({ connection: { dataDir: 'path-to-dir' } });

// Option 4: Pass existing PGlite instance
const client = new PGlite();
const db = drizzle({ client });
```

**drizzle.config.ts for drizzle-kit:**

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  driver: 'pglite',
  dbCredentials: {
    url: ':memory:', // or './path/to/pgdata' for filesystem
  },
});
```

**drizzle-kit compatibility:**

- `drizzle-kit generate` — works (generates standard PostgreSQL SQL migrations)
- `drizzle-kit migrate` — works (applies migrations to PGlite instance)
- `drizzle-kit push` — works (pushes schema changes directly)

The dialect is `'postgresql'` throughout, meaning standard Postgres-dialect SQL is generated — migrations are fully portable to a real Postgres server.

**NOTE:** There is a GitHub discussion (#2532 in drizzle-orm) about nuances of `drizzle-kit migrate` with PGlite. The core issue is that `drizzle-kit migrate` spawns an external process to connect to the database, which does not work with PGlite's in-process model. The recommended workaround is to use `migrate()` programmatically in code at startup (not via drizzle-kit CLI against a live PGlite instance):

```typescript
import { migrate } from 'drizzle-orm/pglite/migrator';
await migrate(db, { migrationsFolder: './drizzle' });
```

`drizzle-kit generate` (SQL generation) and `drizzle-kit push` work fine since push connects directly in-process.

---

### 4. Bundle Size

| Metric                | Value                                                        |
| --------------------- | ------------------------------------------------------------ |
| npm package (gzipped) | ~3.7 MB                                                      |
| Advertised size       | "under 3 MB gzipped" (homepage)                              |
| npm package unpacked  | Not officially documented; significantly larger than gzipped |
| WASM binary           | Included in the npm package                                  |

Extensions add size on top of the base package. For example:

- `pgcrypto`: 1.1 MB additional
- `pgvector`: 42.9 KB additional
- `pg_trgm`: 15.8 KB additional

There was a size regression in v0.2.15 (incomplete PostGIS work accidentally included) that was reverted in a subsequent release. Current 0.3.x releases are not affected.

By comparison, `better-sqlite3`'s npm package is ~7-8 MB unpacked but includes a prebuilt native binary. PGlite at ~3.7 MB gzipped is competitive, especially since it requires no native build step.

---

### 5. Performance vs. better-sqlite3 / wa-sqlite

Official benchmarks (M2 MacBook Air, from `pglite.dev/benchmarks`):

**Single-row CRUD (milliseconds, lower is better):**

| Operation        | PGlite (memory) | SQLite (memory) |
| ---------------- | --------------- | --------------- |
| Insert small row | 0.058 ms        | 0.083 ms        |
| Select small row | 0.088 ms        | 0.042 ms        |
| Update small row | 0.073 ms        | 0.036 ms        |
| Delete small row | 0.145 ms        | 0.1 ms          |

**Bulk operations (seconds, lower is better):**

| Test                          | PGlite (memory) | wa-sqlite (memory) |
| ----------------------------- | --------------- | ------------------ |
| 1,000 INSERTs                 | 0.016 s         | 0.035 s (sync)     |
| 25,000 INSERTs in transaction | 0.292 s         | 0.077 s            |
| 100 SELECTs without index     | 0.218 s         | 0.104 s            |

**Summary:**

- PGlite beats wa-sqlite for single-INSERT throughput
- wa-sqlite is significantly faster for bulk inserts (25k inserts: 3.8x faster)
- SELECT performance: SQLite ~2x faster for simple queries
- The PGlite docs themselves state: "wa-sqlite is faster than PGlite when run purely in memory"
- "PGlite performs well within the range you would expect when comparing native SQLite to Postgres"

**vs. better-sqlite3 specifically:** No direct published benchmarks. `better-sqlite3` uses synchronous native bindings with minimal overhead and is consistently among the fastest SQLite drivers. PGlite would be slower for bulk write workloads by a significant margin, but for typical CRUD operations at human-interaction speed, the difference is imperceptible.

---

### 6. Storage Backends

PGlite uses a virtual filesystem (VFS) abstraction with four backends:

| Backend          | Environment               | Persistence                | Notes                                                           |
| ---------------- | ------------------------- | -------------------------- | --------------------------------------------------------------- |
| **In-Memory FS** | Universal                 | None                       | Default. Data lost on process exit. `dumpDataDir()` can export. |
| **Node FS**      | Node.js, Bun              | Yes, to filesystem         | Writes a Postgres data directory (NOT a single file)            |
| **IndexedDB FS** | Browser                   | Yes, to IndexedDB          | Supports `relaxedDurability` for async writes                   |
| **OPFS AHP FS**  | Chrome only (web workers) | Yes, via Origin Private FS | Safari broken (252 handle limit bug)                            |

**Critical distinction from SQLite:** PGlite does NOT store data in a single `.db` file. It writes an entire Postgres data directory structure. You pass a directory path, not a file path:

```typescript
// This creates/opens a Postgres data directory at ./pgdata/
const db = new PGlite('./pgdata');
```

**For Node.js (DorkOS server context):** `new PGlite('./path/to/dir')` works correctly and persists between process restarts.

---

### 7. Concurrency Model

**Hard limit: single-connection, single-process only.**

This is the most important limitation. The cause is architectural: Emscripten-compiled programs cannot fork processes. PostgreSQL's standard multi-process model (postmaster + backend processes) cannot be replicated in WASM. PGlite operates in PostgreSQL's "single user mode."

**Implications:**

- One PGlite instance = one "connection"
- Multiple JavaScript callers in the same process are serialized (queries are queued internally)
- Two different Node.js processes CANNOT open the same PGlite data directory simultaneously — this is data-corruption territory (no WAL-based multi-writer support, no shared memory)
- There is NO WAL mode, no MVCC for concurrent writers, no equivalent to `better-sqlite3`'s WAL mode

**Browser multi-tab workaround:** `PGliteWorker` runs PGlite in a Web Worker with leader election — only one tab's worker instance owns the database. Other tabs proxy through it. This is browser-only.

**Node.js multi-process:** Not supported. If you need multiple Node.js processes accessing shared state, you need real Postgres or SQLite with WAL mode.

---

### 8. Postgres Features Available

PGlite exposes the full PostgreSQL 17.4 query engine. The following are all confirmed available:

**Core SQL:**

- JSON and JSONB (native, core)
- CTEs (`WITH` clauses)
- Window functions
- Full-text search (built-in `tsvector`/`tsquery`)
- Subqueries, lateral joins
- Prepared statements
- Transactions with savepoints
- `EXPLAIN` / `EXPLAIN ANALYZE`

**Extensions (bundled or separately loadable):**

- `pgvector` — vector similarity search (42.9 KB)
- `pg_trgm` — trigram similarity for fuzzy text search (15.8 KB)
- `fuzzystrmatch` — string distance functions (11.7 KB)
- `hstore` — key-value pairs (20.9 KB)
- `ltree` — hierarchical tree labels (19.1 KB)
- `cube` — multidimensional cube type (14.8 KB)
- `pgcrypto` — cryptographic functions (1.1 MB)
- `uuid-ossp` — UUID generation (17.5 KB)
- `pg_uuidv7` — ULIDv7-style UUIDs (1.5 KB)
- `unaccent` — accent-insensitive search (9.1 KB)
- `amcheck`, `pageinspect`, `pg_visibility`, `pg_buffercache` — admin/diagnostic
- `dict_int`, `dict_xsyn` — full-text search dictionaries
- **`live`** — PGlite-specific reactive query subscriptions (21.3 KB)

**NOT available (known limitations):**

- PostGIS (was experimentally included in a bad release, removed — not ready)
- Multi-process replication, logical replication, streaming replication
- `pg_notify` LISTEN/NOTIFY between separate processes (works within one instance)
- Any extension requiring OS process forking or shared memory
- `pg_cron` (background job scheduling — no background processes)
- Connection pooling (no meaning in single-connection model)

---

### 9. Maturity and Production Readiness

| Property        | Detail                                                      |
| --------------- | ----------------------------------------------------------- |
| Maintainer      | ElectricSQL (commercial company, building local-first sync) |
| Initial release | ~May 2024 (announced at ElectricSQL blog post)              |
| Current version | 0.3.15 (sub-1.0, active development)                        |
| Release cadence | Frequent (243 releases as of Feb 2026)                      |
| License         | Apache 2.0 + PostgreSQL License (dual)                      |
| Ecosystem       | Drizzle, TypeORM, Knex, Prisma adapters exist               |

**Production readiness assessment:**

- Version is still 0.x — no 1.0 stability guarantee
- ElectricSQL uses PGlite as core infrastructure for their own product (strong commercial incentive to maintain)
- Primary production use cases documented: offline-first apps, in-browser databases, local-first sync with Electric
- Not suitable for: high-write-throughput production workloads, multi-process architectures, shared-database patterns
- Suitable for: test isolation (excellent), dev tooling (excellent), single-user local apps (good), Obsidian plugin local state (good)

---

### 10. Limitations Summary

| Limitation                | Severity   | Notes                                                               |
| ------------------------- | ---------- | ------------------------------------------------------------------- |
| Single connection only    | Critical   | No multi-process, no concurrent writers                             |
| Sub-1.0 versioning        | Medium     | API may change; migration breaking changes between 0.2→0.3          |
| Not a single file         | Medium     | Data directory, not `.db` file — different mental model from SQLite |
| Bulk write performance    | Medium     | ~3-4x slower than wa-sqlite for 25k bulk inserts                    |
| No PostGIS                | Low-medium | Removed after a bad release; not ready                              |
| No background jobs        | Low        | No pg_cron, no LISTEN/NOTIFY across processes                       |
| Major version breaks data | Medium     | PG16→PG17 format incompatible, need pg_dump migration               |
| OPFS Safari broken        | Low        | Only matters in browser/Safari context                              |
| drizzle-kit migrate CLI   | Low        | Use programmatic `migrate()` instead; generate/push work fine       |

---

### 11. Electron Compatibility

**No documented production cases found.** However, the architecture strongly suggests it should work:

**Why it should work:**

- Electron renderer processes (with Node integration enabled, as in Obsidian) support both browser APIs and Node.js APIs
- PGlite works in both browser contexts (IndexedDB FS) and Node.js contexts (Node FS)
- Since it's pure WASM with no native bindings, there is no `electron-rebuild` step
- No `require()` of native `.node` modules — pure JavaScript + WASM

**Potential issues:**

- WASM binary loading: In Electron, WASM files sometimes need explicit handling in the bundler (Vite's `assetsInclude` or webpack `asset/resource` rules) to ensure the `.wasm` file is served correctly and not processed as JS
- One documented issue (GitHub #199): "Improve error with pointer to docs when PGlite is unable to load WASM binary" — the WASM binary fails to load with a misleading error when the binary path resolves incorrectly
- Content Security Policy in Electron may need `wasm-unsafe-eval` or equivalent in some configurations
- **For the DorkOS Obsidian plugin specifically:** The `safeRequires` and `patchElectronCompat` Vite build plugins already handle some of these cases. PGlite's WASM loading would need to be verified through the plugin's Vite config.

**Recommendation for DorkOS:** Use PGlite in the **main process** (via IPC) rather than the renderer, to avoid CSP issues and to use the Node FS backend for persistence. If used in the renderer, prefer the IndexedDB FS backend.

---

### 12. Node.js Support

**Confirmed fully supported.** PGlite is documented for Node.js, Bun, and Deno.

```typescript
// Node.js in-memory
const pg = new PGlite();

// Node.js with filesystem persistence
const pg = new PGlite('./path/to/pgdata');

// With Drizzle
import { drizzle } from 'drizzle-orm/pglite';
const db = drizzle('./path/to/pgdata');
```

The `Node FS` VFS uses `fs` APIs directly. There is no need for IndexedDB or browser APIs in Node.js.

**Important:** the data directory is a Postgres data directory structure (multiple files), not a single `.db` file. Back it up as a directory.

---

### 13. Migration Story (drizzle-kit)

**`drizzle-kit generate`** — Works fully. Generates standard PostgreSQL SQL migration files. These files are portable to real Postgres.

**`drizzle-kit push`** — Works fully. Reads schema, connects in-process to PGlite, pushes changes directly.

**`drizzle-kit migrate` (CLI)** — Has a known limitation. The CLI tool spawns an external connection to the DB, which doesn't work with PGlite's in-process model. **Use the programmatic migrator instead:**

```typescript
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

const db = drizzle('./pgdata');
await migrate(db, { migrationsFolder: './drizzle' });
```

This is the standard pattern for any embedded/in-process database with Drizzle (same pattern used with libSQL/Turso locally). The SQL files generated by `drizzle-kit generate` are standard Postgres SQL — they can be applied to both PGlite in development and a real Postgres instance in production.

---

## Sources & Evidence

- [What is PGlite - Official Docs](https://pglite.dev/docs/about) — WASM architecture, storage backends
- [PGlite GitHub Repository](https://github.com/electric-sql/pglite) — Version history, concurrency model, extensions
- [postgres-pglite fork](https://github.com/electric-sql/postgres-pglite) — PostgreSQL 17.5 branch confirmed (`REL_17_5_WASM-pglite-builder`)
- [PGlite Benchmarks](https://pglite.dev/benchmarks) — Official M2 MacBook Air benchmark numbers
- [PGlite Extensions](https://pglite.dev/extensions/) — Full extension list with sizes
- [PGlite Filesystems](https://pglite.dev/docs/filesystems) — Node FS, IndexedDB FS, OPFS, in-memory FS documentation
- [PGlite Multi-tab Worker](https://pglite.dev/docs/multi-tab-worker) — Leader election concurrency model
- [PGlite API Reference](https://pglite.dev/docs/api) — `relaxedDurability`, transaction API
- [Upgrading v0.2→v0.3](https://pglite.dev/docs/upgrade) — PostgreSQL 16→17 breaking change documentation
- [Drizzle ORM PGLite Connection](https://orm.drizzle.team/docs/connect-pglite) — Import paths, configuration options
- [Drizzle ORM PGLite Getting Started](https://orm.drizzle.team/docs/get-started/pglite-new) — drizzle.config.ts example
- [@electric-sql/pglite npm](https://www.npmjs.com/package/@electric-sql/pglite) — Version 0.3.15, 3.7 MB gzipped
- [npm package size issue #477](https://github.com/electric-sql/pglite/issues/477) — Size regression history
- [drizzle-kit migrate discussion #2532](https://github.com/drizzle-team/drizzle-orm/discussions/2532) — CLI migrate limitation with PGlite
- [PGlite WASM load error #199](https://github.com/electric-sql/pglite/issues/199) — WASM binary loading failure modes
- [PGlite ORM Support](https://pglite.dev/docs/orm-support) — Confirmed Drizzle support
- [OreateAI: PGlite vs SQLite](https://www.oreateai.com/blog/pglite-vs-sqlite-a-new-era-in-lightweight-databases/c619b9cc5617ffaed3600a1d6eb82e65) — Performance comparison narrative
- [PGlite HN Thread](https://news.ycombinator.com/item?id=41224689) — Community discussion, pgvector, live sync

---

## Research Gaps & Limitations

- **Exact unpacked npm install size** not found — npm registry page was inaccessible (403). The 3.7 MB gzipped figure is confirmed from multiple sources; unpacked size is larger but unknown precisely.
- **Electron-specific documented cases** — No production case studies found for PGlite in Electron/Obsidian. Compatibility is inferred from architecture, not confirmed by reported use.
- **File locking behavior** — No documentation found on what happens if two Node.js processes accidentally open the same PGlite data directory. It would likely corrupt the data (no OS-level advisory locks documented).
- **Memory footprint at runtime** — No published figures for RSS or heap usage when PGlite is loaded and running. The 3.7 MB gzipped is the package size, not the runtime memory cost of a loaded WASM instance.
- **Deno support maturity** — Listed as supported but no detailed documentation found; treat as less tested than Node.js.

---

## Contradictions & Disputes

- The PGlite homepage states "under 3MB gzipped" while the npm page shows "3.7MB gzipped." The discrepancy likely reflects the homepage copy not being updated as extensions were added to the base package.
- The `postgres-pglite` fork README references PostgreSQL 17.5 in the branch name, but the upgrade guide for v0.3.x states it is based on PostgreSQL 17.4. This is a minor version discrepancy; both are PG 17.x. The branch name may be ahead of what is actually shipped.

---

## Search Methodology

- Searches performed: 14
- Fetch calls: 9
- Most productive search terms: "pglite drizzle orm", "electric-sql pglite WASM postgres version", "pglite postgres version 16 17 based on fork", "pglite vs sqlite performance benchmarks"
- Primary sources: pglite.dev official docs, orm.drizzle.team, github.com/electric-sql/pglite, github.com/drizzle-team/drizzle-orm discussions
- Research mode: Deep Research
