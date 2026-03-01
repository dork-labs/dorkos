---
title: "Embedded PostgreSQL for Desktop Apps & CLI Tools"
date: 2026-02-25
type: exploratory
status: archived
tags: [postgres, embedded, desktop, cli, pglite, sqlite]
---

# Embedded PostgreSQL for Desktop Apps & CLI Tools

**Research Date**: 2026-02-25
**Mode**: Deep Research
**Searches Performed**: 16

---

## Research Summary

Bundling a real PostgreSQL server with a desktop app or CLI tool is technically feasible
and there are production-grade npm packages to do it. The primary mechanism is downloading
pre-compiled platform-specific PostgreSQL binaries at npm install time, then spawning them
as child processes at runtime. However, the 136 MB per-platform binary cost, the root-user
restriction, and the complexity of cross-platform data-directory management make it a non-
trivial engineering choice. Two newer options — **PGlite** (Postgres compiled to WASM, ~3 MB
gzipped) and **pgmock** (full Postgres in a WASM x86 emulator) — are emerging as lower-
friction alternatives for scenarios where single-connection constraints are acceptable.

---

## Key Findings

### 1. `embedded-postgres` npm Package (leinelissen) — Production-Capable

- **What it is**: A Node.js package that wraps pre-compiled PostgreSQL binaries and lets you
  spawn a real PostgreSQL cluster programmatically via a simple API.
- **How it works**:
  1. During `npm install`, optional platform-specific sub-packages (e.g.,
     `@embedded-postgres/darwin-arm64`) are downloaded. Each contains the actual Postgres
     binaries and exports paths to `pg_ctl`, `initdb`, and `postgres`.
  2. At runtime, `new EmbeddedPostgres({ port, dataDir, ... }).initialise()` runs `initdb`
     to create a data directory, then `.start()` runs `pg_ctl start`.
  3. The full lifecycle (create cluster, create DB, run queries via node-postgres, stop) is
     managed in JavaScript.
- **Platform packages available** (as of Feb 2026, PG 17.x/18.x):
  - `@embedded-postgres/darwin-arm64` — 136 MB
  - `@embedded-postgres/darwin-x64` — 136 MB
  - `@embedded-postgres/linux-x64` — available
  - `@embedded-postgres/linux-arm64` — available
  - `@embedded-postgres/linux-arm` — available
  - `@embedded-postgres/linux-ia32` — available
  - `@embedded-postgres/linux-ppc64` — available
  - Windows x64 — available
- **PostgreSQL versions**: 14.x through 18.x (tracks official PG support lifecycle)
- **Known limitations**:
  - PostgreSQL refuses to run as root — requires `createPostgresUser: true` option which
    **permanently creates a system user** on the host machine; Docker containers running as
    root need a custom setup
  - PNPM users must manually approve post-install scripts (npm post-install scripts handle
    symlink generation that npm tarballs cannot express natively)
  - ~100 GitHub stars; actively maintained but not a large project
  - Primarily designed for testing/CI use cases, not for production long-running deployments
- **Source**: https://github.com/leinelissen/embedded-postgres

---

### 2. `zonkyio/embedded-postgres-binaries` — The Upstream Binary Source

- **What it is**: A Java/Gradle project (not directly Node.js) that produces the pre-compiled
  PostgreSQL binaries that the npm `embedded-postgres` package re-packages.
- **How binaries are built**: Uses Docker + QEMU for cross-compilation on Linux. Full build of
  all architectures can take "a few hours." Binaries are stripped and size-optimized.
- **Claimed size**: ~10 MB per binary archive for Linux (stripped). The npm packages for macOS
  are 136 MB, which indicates the macOS builds include more components (frameworks, extensions).
- **Intended use**: Explicitly documented as "intended for testing purposes" — not production
  server deployments.
- **Platforms**: Darwin, Windows, Linux, Alpine Linux (Alpine variants disable ICU for further
  size reduction)
- **Node.js equivalent**: The npm `embedded-postgres` package IS the Node.js equivalent —
  it re-packages the zonky binaries as scoped npm packages.
- **Source**: https://github.com/zonkyio/embedded-postgres-binaries

---

### 3. FerretDB — MongoDB Wire Protocol, NOT a Postgres Replacement for This Use Case

- **What it is**: An open-source proxy that translates MongoDB wire protocol queries to SQL,
  backed by PostgreSQL or SQLite. Written in Go.
- **SQLite backend**: Production-ready as of v1.10 (2023). Supports aggregation pipelines,
  indexes, query explains, collection renaming.
- **Embedded Go package**: FerretDB exposes a Go library package for embedding directly into
  Go applications.
- **Relevance to this question**: FerretDB is NOT a Postgres replacement. It provides a
  MongoDB-compatible API over Postgres/SQLite. You would use it only if you want MongoDB
  driver compatibility (for applications already using MongoDB drivers), not if you want to
  run a Postgres-compatible database.
- **Node.js integration**: None native. You would run FerretDB as a separate binary and
  connect with a MongoDB Node.js driver. Not directly embeddable in a Node.js process.
- **Verdict**: Useful as a MongoDB-compatible embedded DB if you build in Go, or if you
  need MongoDB driver compatibility for your app. Not a direct Postgres alternative for
  Node.js desktop apps.
- **Source**: https://github.com/FerretDB/FerretDB

---

### 4. Postgres.app (macOS) — How It Bundles Postgres

- **What it is**: A native macOS menubar app that includes full PostgreSQL server binaries.
- **Bundle structure**: Binaries live at
  `/Applications/Postgres.app/Contents/Versions/{major}/bin/`. The full installation
  includes postgresql, postgis, wal2json, pldebugger, pgvector, and pgrouting.
- **Build process**: Each version's `src-{major}/makefile` downloads and compiles all
  binaries. Different macOS versions used for different PG versions (e.g., PG 13 on macOS
  10.15/Xcode 11.7; PG 17-18 on macOS 14/Xcode 15.3) for compatibility.
- **How it manages Postgres**: Simple menubar toggle starts/stops `pg_ctl`. The app
  manages the data directory (`~/Library/Application Support/Postgres/`).
- **Reusability**: The binary bundling approach (self-contained binary tree inside the .app
  bundle) is reusable. Electron apps can do the same by putting binaries in
  `extraResources` in electron-builder config. However, Postgres.app builds binaries from
  source for each platform version — you would use pre-built binaries from zonkyio or
  theseus-rs for a Node.js equivalent.
- **Source**: https://github.com/PostgresApp/PostgresApp

---

### 5. Supabase Local Dev — Docker-Based, Not Bundled

- **Confirmed**: Supabase local dev uses **Docker**. The CLI requires Docker Desktop (or
  compatible runtime) to be installed and running. On first run, it pulls Docker images.
- **Architecture**: `supabase start` pulls the `supabase/postgres` Docker image (a custom
  Postgres build) plus auxiliary images (auth, storage, realtime, etc.).
- **Implication**: Supabase does NOT bundle Postgres binaries into the CLI itself. It
  delegates entirely to Docker for process isolation and cross-platform binary compatibility.
- **User experience impact**: This is why `supabase start` is slow on first run and why
  Docker Desktop is a hard requirement.
- **Source**: https://supabase.com/docs/guides/local-development

---

### 6. Binary Sizes — What to Expect

| Component | Size |
|---|---|
| `@embedded-postgres/darwin-arm64` npm package | **136 MB** |
| `@embedded-postgres/darwin-x64` npm package | **136 MB** |
| zonkyio Linux binaries (stripped) | **~10 MB** (stripped, no ICU) |
| PGlite (WASM, full Postgres) | **~3 MB gzipped** |
| pgmock (WASM x86 emulator + Postgres) | larger (emulates full Linux VM) |
| Full EnterpriseDB installer (with tools) | **~300-500 MB** |

Notes:
- The macOS 136 MB figure includes the full Postgres binary tree (server, client tools,
  shared libraries). The Linux stripped figure of ~10 MB is for minimal binaries with
  ICU disabled.
- A minimal `postgres` + `initdb` + `pg_ctl` installation (no extensions, no client tools)
  can be much smaller — but the npm packages ship the full tree for compatibility.
- For Electron apps, 136 MB per platform adds significant download/install size. If
  shipping for macOS arm64 + x64 + Windows + Linux, you're looking at ~400-550 MB of
  raw binary assets before compression.

---

### 7. Cross-Platform Binary Support — YES, Fully Covered

The `embedded-postgres` npm ecosystem covers all major desktop platforms:

| Platform | Architecture | Status |
|---|---|---|
| macOS | arm64 (Apple Silicon) | Supported (PG 15+) |
| macOS | x64 (Intel) | Supported |
| Windows | x64 | Supported |
| Linux | x64 | Supported |
| Linux | arm64 | Supported |
| Linux | arm32, ia32, ppc64 | Supported |

The `theseus-rs/postgresql-binaries` project (GitHub Releases, Shell scripts, Feb 2026
release of PG 18.2.0) provides an alternative source for pre-compiled binaries aligned
with Rust target triples, but has no npm integration.

---

### 8. Startup and Management — initdb, pg_ctl, Data Directories

The lifecycle for a bundled Postgres is:

```
1. FIRST RUN: initdb --pgdata=/path/to/datadir --auth=scram-sha-256
   (creates the database cluster — takes ~1-3 seconds)

2. EVERY STARTUP: pg_ctl start -D /path/to/datadir -l /path/to/logfile
   (starts the postgres server process — takes ~0.5-2 seconds)

3. EVERY SHUTDOWN: pg_ctl stop -D /path/to/datadir -m fast
   (graceful shutdown)

4. DATABASE MANAGEMENT: createdb, dropdb (CLI tools) or SQL CREATE DATABASE
```

Key management concerns for a desktop/CLI app:
- **Data directory location**: Must be user-writable. Typical choices:
  - `~/.config/myapp/pgdata/` (XDG standard on Linux)
  - `~/Library/Application Support/myapp/pgdata/` (macOS)
  - `%APPDATA%\myapp\pgdata\` (Windows)
- **Port selection**: Pick a non-standard port (e.g., 15432) to avoid conflicts with
  system Postgres. The `embedded-postgres` package supports configurable ports.
- **Version migrations**: If the app ships a new Postgres major version, `pg_upgrade`
  must be run or the data directory re-initialized (data migrated via dump/restore).
  This is a significant UX challenge for upgrades.
- **Root user restriction**: Postgres refuses to run as root. On Linux systems where
  the desktop app or CI runs as root (Docker containers), you must create a dedicated
  system user. The `embedded-postgres` npm package can do this automatically via
  `createPostgresUser: true`, but this **permanently modifies the host system**.
- **Windows**: `pg_ctl` works on Windows. Data directory initialization via `initdb`
  works. No special Windows-specific issues reported with the npm packages.

---

### 9. Docker as Alternative — Viable for Developer Tools, Poor for End-User Apps

**Verdict**: Docker is a reasonable requirement for **developer-focused CLI tools** but
a **poor choice for end-user desktop applications**.

Arguments FOR requiring Docker:
- Eliminates all binary bundling complexity
- Cross-platform compatibility handled by Docker
- Used by Supabase CLI, many developer tools
- Standard for local-dev workflows

Arguments AGAINST requiring Docker:
- Docker Desktop is not installed by default on any OS
- Docker Desktop requires a license for commercial use in organizations > 250 employees
  (as of 2022 licensing change)
- Docker daemon startup adds latency
- Poor UX for non-developer end-users
- 400 MB+ Docker for Desktop install is a heavy dependency
- Docker Desktop alternatives (Podman, OrbStack, Colima) exist but add complexity

**Observed pattern**: Projects like Supabase CLI, Planetscale CLI, and similar
developer-first tools use Docker. End-user desktop apps (password managers, accounting
software, etc.) that need a database almost universally use SQLite instead of Postgres.

---

### 10. Real-World Examples

#### Apps That Bundle Postgres Binaries
- **Postgres.app**: The canonical macOS example. Ships full Postgres binary tree inside
  the .app bundle. Manages via `pg_ctl`. Open source.
  https://github.com/PostgresApp/PostgresApp

- **Postcard**: An Electron + PostgreSQL application platform explicitly designed to
  bundle PostgreSQL for offline desktop use. "Manages starting PostgreSQL when users open
  the app." Open source but low activity.
  https://github.com/workflowproducts/postcard

- **tableau** (Desktop): Ships bundled Postgres (Hyper engine is a Postgres fork).
  Commercial, not open source.

#### CLI Tools That Use Docker for Postgres
- **Supabase CLI** (`supabase start`): Pulls Docker images
- **Neon CLI**: Connects to cloud Postgres, no local bundling
- **Railway CLI**: Connects to cloud, no local bundling

#### Testing Libraries (Not Production Deployment)
- **`embedded-postgres` (npm)**: Primarily used for CI/integration tests
- **`@databases/pg-test`**: Uses Docker to run Postgres for tests (last published 4 years ago)
- **`pg-mem`**: Pure JS in-memory Postgres implementation for unit tests (not real Postgres)

---

## Detailed Analysis

### PGlite — The Most Interesting New Option

**PGlite** (by ElectricSQL) is the most significant recent development in this space.

- **What it is**: PostgreSQL compiled to WebAssembly using "single-user mode" (a Postgres
  internal mode used for bootstrapping and recovery). Extended with full wire protocol
  support.
- **Size**: ~3 MB gzipped. This is an order of magnitude smaller than binary packages.
- **Platforms**: Runs in browser, Node.js, Bun, Deno — wherever WASM runs. No platform-
  specific binary management needed.
- **Persistence**: Ephemeral in-memory OR persistent to filesystem (Node.js) or IndexedDB
  (browser).
- **Extensions**: Dynamic extension loading including `pgvector`.
- **Production status**: Electric v1.0 released, marked as GA for mission-critical apps.
- **Critical limitation**: **Single connection only**. Only one PGlite instance can be
  active at a time per process. No concurrent connections. This rules it out for any use
  case requiring a connection pool or multiple simultaneous clients.
- **Wire protocol server**: Community projects (`pglite-server`, `pglite-socket`) expose
  a TCP wire protocol server, but they inherit the single-connection constraint.
- **Verdict**: Excellent for single-user desktop apps, CLI tools with a single active
  session, and browser-based apps. Not suitable for multi-user or multi-process scenarios.
- **Source**: https://github.com/electric-sql/pglite

### pgmock — Full Postgres in WASM x86 Emulator

- **What it is**: Runs actual Postgres inside a JavaScript x86 emulator (building on work
  by Supabase and Snaplet's postgres-wasm). Full feature compatibility with production
  Postgres.
- **Approach**: Emulates an x86 Linux VM in WASM, boots a real Postgres binary inside it.
- **Key advantage over pg-mem**: Real Postgres SQL compatibility (not a reimplementation).
- **Key advantage over PGlite**: May support multiple connections since it emulates a
  real Postgres with its process model.
- **Use case**: E2E tests, not embedded production use.
- **Source**: https://github.com/stack-auth/pgmock

### pg-mem — Pure JS Postgres Reimplementation (Testing Only)

- **What it is**: A TypeScript reimplementation of Postgres SQL evaluation logic. No real
  Postgres binary involved.
- **Limitations**:
  - Home-made SQL parser — some syntax is not supported
  - No PL/pgSQL, no PL/V8
  - No timezone support, numeric types handled as JS floats
  - No extensions
- **Use case**: Fast unit tests where you want zero infrastructure. NOT for production and
  not for verifying real Postgres behavior.
- **Source**: https://github.com/oguimbal/pg-mem

### DuckDB — Excellent for OLAP, Wrong Tool for OLTP

- **What it is**: An in-process columnar SQL database optimized for analytical queries.
  Native Node.js bindings via `@duckdb/node-api` (the old `duckdb` npm package is
  deprecated as of 1.4.x).
- **Concurrency**: Single-writer. Multiple readers allowed. One process holds write access
  at a time. This is a deliberate design choice.
- **WASM version**: `@duckdb/duckdb-wasm` exists but is single-threaded (experimental
  multithreading). Not suitable for concurrent workloads.
- **Production readiness**: Production-ready for OLAP/analytics. ACID-compliant.
- **When to use**: If your use case is analytical queries over large datasets (reporting,
  data pipelines, analytics dashboards). Not suitable as a general-purpose OLTP database
  (inserts, updates from multiple sources, web app backends).
- **Sources**: https://duckdb.org/docs/stable/connect/concurrency,
  https://github.com/duckdb/duckdb-node

### libSQL / sqld — SQLite Fork with Server Mode

- **What it is**: Turso's fork of SQLite that adds: server mode (sqld/libsql-server),
  embedded replicas, HTTP protocol support, and native vector search.
- **Server mode**: `sqld` runs a server that speaks the libSQL HTTP protocol and can be
  self-hosted on a VPS or embedded in a process.
- **Node.js support**: `@libsql/client` npm package. Also `libsql-js` (better-sqlite3
  compatible API for Node/Bun/Deno).
- **Embedded replicas**: A database can be used both locally AND as a network replica
  simultaneously — the local copy syncs from a remote libsql-server.
- **Production readiness**: `@libsql/client` is described as "battle-tested with ORM
  integration." Turso cloud uses it in production.
- **Concurrency**: Inherits SQLite's writer lock model — better-sqlite3 is synchronous
  and serializes writes. For typical desktop app write loads, this is not a problem.
- **Postgres compatibility**: None. It's SQLite-compatible, not Postgres-compatible.
- **When to use**: If you want SQLite semantics but with optional server-mode for
  multi-device sync or remote access. NOT a Postgres replacement.
- **Sources**: https://github.com/tursodatabase/libsql,
  https://github.com/tursodatabase/libsql-js

---

## Decision Matrix

| Option | Real Postgres? | Size | Concurrency | Cross-Platform | Production? | Complexity |
|---|---|---|---|---|---|---|
| `embedded-postgres` npm | YES | 136 MB/platform | Full | YES (all major) | Possible | High |
| PGlite (WASM) | YES (WASM) | ~3 MB gz | Single conn | YES (any WASM) | GA (ElectricSQL) | Low |
| pgmock | YES (emulated) | Large | Full? | YES | Testing only | Medium |
| pg-mem | NO (reimpl) | Small | N/A | YES | Testing only | Low |
| DuckDB | NO (columnar) | Medium | Single-writer | YES | Yes (OLAP) | Low |
| libSQL/sqld | NO (SQLite) | Small | Single-writer | YES | Yes | Low |
| FerretDB | MongoDB API | Medium | Full | YES | Yes | High |
| Docker + Postgres | YES | N/A (Docker req) | Full | YES (Docker) | YES | Medium |
| SQLite (plain) | NO | ~1 MB | Single-writer | YES | YES | Minimal |

---

## Research Gaps and Limitations

- **Actual startup time** for `embedded-postgres` npm (initdb + pg_ctl start) was not found
  in sources. Likely 1-5 seconds for `initdb`, 0.5-2 seconds for subsequent starts.
- **Windows-specific issues** with embedded-postgres were not documented in sources found.
  The package claims Windows x64 support but real-world Windows reports were scarce.
- **Electron-builder integration** details for bundling the 136 MB binaries into an
  `extraResources` bundle were not found in sources. The `tutorial-electron-bundle-binaries`
  repo (garethflowers) addresses general binary bundling, not specifically Postgres.
- **PG version upgrade path** for data directories in a desktop app was not covered in any
  found source. This is a real-world maintenance problem with no easy answer.

---

## Contradictions and Disputes

- The RxDB/Electron database guide claims bundling Postgres is "not viable in practice" due
  to binary/port complexity. This conflicts with the existence of `embedded-postgres` npm
  and Postgres.app. The more accurate framing is: it's viable but adds significant
  complexity compared to SQLite.

- zonkyio labels their binaries as "intended for testing purposes." However, the npm
  `embedded-postgres` wrapper is used for more than testing. The labeling reflects the
  original Java ecosystem use case, not a hard technical limitation.

---

## Sources and Evidence

- [embedded-postgres npm](https://www.npmjs.com/package/embedded-postgres)
- [leinelissen/embedded-postgres GitHub](https://github.com/leinelissen/embedded-postgres)
- [@embedded-postgres/darwin-arm64 npm](https://www.npmjs.com/package/@embedded-postgres/darwin-arm64)
- [@embedded-postgres/linux-x64 npm](https://www.npmjs.com/package/@embedded-postgres/linux-x64)
- [zonkyio/embedded-postgres-binaries GitHub](https://github.com/zonkyio/embedded-postgres-binaries)
- [zonkyio/embedded-postgres Java GitHub](https://github.com/zonkyio/embedded-postgres)
- [FerretDB GitHub](https://github.com/FerretDB/FerretDB)
- [FerretDB v1.10 SQLite Production Ready](https://blog.ferretdb.io/ferretdb-v1-10-production-ready-sqlite/)
- [PostgresApp GitHub](https://github.com/PostgresApp/PostgresApp)
- [Postgres.app Install Docs](https://postgresapp.com/documentation/install.html)
- [Supabase Local Development](https://supabase.com/docs/guides/local-development)
- [PGlite GitHub](https://github.com/electric-sql/pglite)
- [PGlite Website](https://pglite.dev/)
- [PGlite InfoQ Article](https://www.infoq.com/news/2024/05/pglite-wasm-postgres-browser/)
- [PGlite concurrency issue #324](https://github.com/electric-sql/pglite/issues/324)
- [pgmock GitHub](https://github.com/stack-auth/pgmock)
- [pg-mem GitHub](https://github.com/oguimbal/pg-mem)
- [@databases/pg-test npm](https://www.npmjs.com/package/@databases/pg-test)
- [DuckDB Node.js API](https://duckdb.org/docs/stable/clients/nodejs/overview)
- [DuckDB Concurrency Docs](https://duckdb.org/docs/stable/connect/concurrency)
- [DuckDB npm (deprecated)](https://www.npmjs.com/package/duckdb)
- [libSQL GitHub](https://github.com/tursodatabase/libsql)
- [libsql-js GitHub](https://github.com/tursodatabase/libsql-js)
- [theseus-rs/postgresql-binaries GitHub](https://github.com/theseus-rs/postgresql-binaries)
- [Postcard GitHub](https://github.com/workflowproducts/postcard)
- [Electron bundle binaries tutorial](https://github.com/ganeshrvel/tutorial-electron-bundle-binaries)
- [RxDB Electron Database Guide](https://rxdb.info/electron-database.html)
- [xstatic static PostgreSQL binaries](https://postgrespro.com/list/thread-id/2421212)
- [garethflowers/postgresql-portable](https://github.com/garethflowers/postgresql-portable)
