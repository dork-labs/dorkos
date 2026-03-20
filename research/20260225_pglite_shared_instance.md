---
title: 'PGlite: Sharing a Single Instance Across Multiple Consumers'
date: 2026-02-25
type: exploratory
status: archived
tags: [pglite, postgres, shared-instance, worker, database]
---

# PGlite: Sharing a Single Instance Across Multiple Consumers

**Research Date:** 2026-02-25
**Depth:** Deep Research
**Objective:** Understand all available mechanisms for sharing a single PGlite instance across multiple consumers in Node.js

---

## Research Summary

PGlite is fundamentally a single-connection embedded Postgres (WASM). It has no built-in multi-connection support — Postgres compiled via Emscripten cannot fork processes and runs in "single-user mode." However, several real projects exist that address this constraint. The viable strategies are: (1) serialize all consumers through a single in-process instance using `@middle-management/pglite-pg-adapter`, (2) expose PGlite over the Postgres wire protocol via `@electric-sql/pglite-socket` (single client at a time), (3) use `pg-gateway` (Supabase) for a more capable TCP server with full auth/TLS hooks, and (4) `PGliteWorker` for browser-only multi-tab sharing. There is **no** built-in worker-thread-based solution for Node.js multi-process sharing, and no roadmap item to add true multi-connection support.

---

## Key Findings

### 1. PGlite is Architecturally Single-Connection

The constraint is not a bug or a missing feature — it is structural. PostgreSQL normally forks a process per connection; Emscripten (the WASM compiler) cannot fork. PGlite uses Postgres's "single-user mode" which bypasses the normal startup/auth protocol and runs outside a TCP connection entirely. This means:

- Only one consumer can execute queries at a time
- Any multi-consumer solution is a serialization layer, not true parallel access
- There is no official roadmap for multi-connection support (GitHub Issue #324 remains open and unresolved as of Oct 2025)

### 2. PGliteWorker — Real, but Browser-Only

**Status: EXISTS and works, but browser-only.**

`PGliteWorker` is a first-party package from electric-sql that implements a leader-election pattern across browser tabs:

- Each tab spawns its own worker running the same worker script
- One tab is elected "leader" and that tab's worker is the one that actually calls `init()` and creates the PGlite instance
- All other tabs proxy their queries to the leader via `postMessage`
- When the leader tab closes, a new election runs and a fresh PGlite instance initializes on the new leader
- Extensions are NOT exposed on connecting (non-leader) `PGliteWorker` instances

**Does it work in Node.js?** No. It relies on the Web Workers API (browser-exclusive). Node.js Worker Threads exist but are fundamentally different. No adapter for Node.js worker threads exists in the official packages or community.

Usage:

```ts
// worker.js
import { PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';
worker({
  async init() {
    return new PGlite();
  },
});

// main.ts
import { PGliteWorker } from '@electric-sql/pglite/worker';
const pg = new PGliteWorker(new Worker('./worker.js', { type: 'module' }));
```

### 3. `@electric-sql/pglite-socket` — Official TCP Server, Node.js, Single Client Only

**Status: EXISTS, official package, works in Node.js, single client at a time.**

This is a first-party package in the electric-sql monorepo. It wraps Node.js `net` module to expose PGlite as a Postgres TCP server.

**Classes:**

- `PGLiteSocketServer` — TCP server accepting Postgres connections
- `PGLiteSocketHandler` — Low-level handler for a single socket connection

**Hard constraint:** "As PGlite is a single-connection database, it is not possible to have multiple simultaneous connections open." The socket server enforces an exclusive lock — while one client is attached, other connections are blocked and direct `db.query()` calls will also be blocked.

**CLI:**

```bash
npx pglite-server --db ./mydb --port 5432 --run 'npm run dev' --include-database-url
```

The `--run` flag spawns a subprocess and injects `DATABASE_URL` so any app that reads that env var gets a standard Postgres connection string pointing at the PGlite server. The server shuts down when the subprocess exits.

**API:**

```ts
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite('./mydb');
const server = new PGLiteSocketServer({ db, port: 5432, host: '127.0.0.1' });
await server.start();
// also supports Unix socket via `path` option
```

**Unix socket support:** Yes, via the `path` option — allows IPC without TCP overhead.

**Use case fit:** Good for: a single app connecting via `pg` client, dev tooling, migration runners. Bad for: multiple concurrent processes, connection pools that open multiple parallel connections (Prisma, some ORMs will fail).

### 4. `kamilogorek/pglite-server` — Community TCP Server, Experimental

**Status: EXISTS, experimental/spare-time project, Bun-first.**

A community-built TCP server that intercepts `SSLRequest` and `StartupMessage` messages to fake authentication, then tunnels remaining Postgres wire protocol directly to a PGlite instance.

```ts
import { createServer } from 'pglite-server';
const pgServer = createServer(db, { logLevel: LogLevel.Debug });
pgServer.listen(5432);
```

The author explicitly recommends `pg-gateway` (Supabase) as the more production-worthy alternative. This project is a learning exercise more than a production tool.

### 5. `pg-gateway` (Supabase Community) — Full Postgres Wire Protocol Server, Pre-1.0

**Status: EXISTS, pre-1.0, actively developed, works in Node.js, explicit PGlite example in docs.**

`pg-gateway` is a TypeScript library from `supabase-community` that implements the server-side Postgres wire protocol. It has hooks for auth, TLS, startup, and raw message forwarding.

**PGlite integration pattern:** Handle startup/auth yourself in `pg-gateway` hooks, then use `onMessage()` to forward raw wire protocol messages to PGlite via `connection.sendData()`.

**Key features:**

- Auth modes: `none`, `cleartextPassword`, `md5Password`, `certificate`
- TLS/SSL with SNI routing (this is how Supabase's `database.build` "Live Share" feature routes browser PGlite instances to external `psql` clients)
- `detach()` method for taking full socket control
- `sendData()`, `sendError()`, `sendReadyForQuery()` response primitives

**Maturity:** Pre-1.0, "APIs are still WIP, expect breaking changes." But it IS used in production by Supabase's `database.build` tool for its Live Share feature.

**Repo:** https://github.com/supabase-community/pg-gateway

**Still single-consumer:** Using `pg-gateway` doesn't overcome PGlite's single-connection constraint. It gives you a better protocol implementation but you still serialize.

### 6. `@middle-management/pglite-pg-adapter` — In-Process Shared Instance via `pg`-compatible API

**Status: EXISTS, works in Node.js, allows multiple `pg` Client/Pool instances over one PGlite.**

This package provides a `pg`-compatible adapter that lets you create multiple `Client` and `Pool` instances from the `pg` npm package that all route to the same underlying PGlite instance. All serialization happens in-process.

**Key stats from benchmarks:**

- 80.7% faster than using separate PGlite instances
- 69.9% memory savings over separate instances

**Pattern:**

```ts
import { PGlite } from '@electric-sql/pglite';
import { createPool } from '@middle-management/pglite-pg-adapter';

const db = new PGlite();
const pool = createPool(db, { max: 10 });

// Now use pool like normal node-postgres
const client = await pool.connect();
await client.query('SELECT 1');
client.release();
```

**Limitation:** This only works within a single Node.js process. It does not help with multi-process scenarios (e.g., two separate Node.js processes sharing one DB).

### 7. PGlite Live Queries — Reactive, Not Multi-Connection

**Status: EXISTS, first-party, works in Node.js and browser.**

PGlite has a `live` extension that enables reactive/pub-sub query functionality. It does not add multi-connection support — it is a change-notification system within a single PGlite instance.

- `pg.live.query(sql, params, callback)` — re-runs query and calls callback when underlying tables change
- `pg.live.incrementalQuery(sql, params, key, callback)` — incremental diff, more efficient
- `pg.live.changes(sql, params, key, callback)` — emits only changed rows (INSERT/UPDATE/DELETE)

The React package `@electric-sql/pglite-react` provides hooks (`useLiveQuery`, `useLiveIncrementalQuery`) built on top of this.

This is a relevant architecture building block: if you have one PGlite instance and multiple in-process consumers, the live query system lets each consumer subscribe to changes reactively rather than polling. It does not help cross-process.

### 8. Supabase `database.build` Live Share — WebSocket Reverse Tunnel (Production Proof of Concept)

**Status: REAL production feature, highly specialized.**

Supabase built a "Live Share" feature for their `database.build` tool that lets you connect `psql` or any Postgres client to a PGlite instance running **in a browser tab**. The architecture:

1. Browser opens a persistent WebSocket reverse tunnel to a Supabase-hosted proxy
2. External client connects to the proxy over TCP
3. Proxy handles Postgres startup/auth, reads SNI for routing, forwards messages to the browser via WebSocket
4. Browser PGlite processes the messages and sends responses back

This is built on `pg-gateway`. It demonstrates that the pattern is production-viable, but it is not a general-purpose library — it's infrastructure Supabase operates.

**Hard limit:** Still single Postgres client at a time. Tools that open multiple parallel connections (Prisma's default, DBeaver) will fail. 5-minute idle timeout, 1-hour total timeout.

---

## Architecture Patterns: Practical Options for Node.js

### Pattern A: In-Process Serialization (Recommended for Single Process)

Run one PGlite instance. All consumers within the same Node.js process share it via `@middle-management/pglite-pg-adapter` or directly via the PGlite API. Queries are internally queued and executed serially.

- **Pros:** No IPC overhead, fastest option, `pg`-compatible API
- **Cons:** Breaks with any multi-process setup (cluster, worker_threads spawning child processes)

### Pattern B: PGliteSocket + Subprocess Injection (Dev Tooling Pattern)

Use `@electric-sql/pglite-socket` CLI to start a server, inject `DATABASE_URL` into a child process. The child process uses a normal `pg` connection string and doesn't know it's talking to PGlite.

```bash
pglite-server --db ./mydb --port 5432 --run 'node myapp.js' --include-database-url
```

- **Pros:** Zero changes to app code, standard Postgres connection string, works with migrations, ORMs that use a single connection
- **Cons:** Only ONE client can be connected at any moment; ORMs/frameworks that pool multiple connections will fail or behave unpredictably

### Pattern C: pg-gateway Custom Server (Advanced, Most Flexible)

Build a custom TCP server with `pg-gateway` that queues incoming connections, forwards to PGlite one at a time, and buffers/serializes access. This is the most work but gives you full control over the protocol and could implement a serialization queue that looks like a connection pool to clients.

- **Pros:** Full Postgres wire protocol, any client can connect, can implement fairness/queuing
- **Cons:** Pre-1.0 library, significant integration work, still fundamentally serial throughput

### Pattern D: Node.js Worker Thread with Message Passing (Theoretical, No Existing Library)

Run PGlite in a dedicated `worker_threads` Worker. Other threads send query requests over `MessageChannel` and receive results. This is the Node.js equivalent of `PGliteWorker` (which does this for browser Web Workers).

**No existing library does this.** The browser `PGliteWorker` package cannot be used in Node.js because it depends on the Web Workers API. Building this would require:

1. A worker thread that creates and owns the PGlite instance
2. A message protocol for query/result/transaction exchange
3. An adapter that presents a `pg`-compatible interface to callers

This is theoretically sound but would need to be built from scratch. The electric-sql team has not prioritized it.

---

## What Does NOT Exist

- **No official Node.js worker-thread multi-consumer solution** for PGlite
- **No connection pooler** that allows true concurrent queries (all solutions serialize)
- **No `PGliteWorker` for Node.js** — the browser package won't work
- **No multi-process shared-memory PGlite** — the WASM module cannot share state across OS processes
- **No roadmap commitment** from electric-sql for multi-connection support (Issue #324 open since Sept 2024, marked as a known limitation)

---

## Existing Projects Summary Table

| Project                                | Type                          | Node.js           | Multi-Consumer               | Maturity                   | Source                                                             |
| -------------------------------------- | ----------------------------- | ----------------- | ---------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `@electric-sql/pglite-socket`          | Official TCP server           | Yes               | No (serial, 1 at a time)     | Stable (official)          | https://pglite.dev/docs/pglite-socket                              |
| `PGliteWorker`                         | Browser multi-tab worker      | No (browser only) | Yes (proxied through leader) | Stable (official)          | https://pglite.dev/docs/multi-tab-worker                           |
| `@middle-management/pglite-pg-adapter` | In-process `pg` adapter       | Yes               | Yes (same process only)      | Community, unknown         | https://www.npmjs.com/package/@middle-management/pglite-pg-adapter |
| `pg-gateway`                           | Postgres wire protocol server | Yes               | No (serial)                  | Pre-1.0, active            | https://github.com/supabase-community/pg-gateway                   |
| `kamilogorek/pglite-server`            | TCP wire protocol server      | Bun-first         | No (serial)                  | Experimental/spare-time    | https://github.com/kamilogorek/pglite-server                       |
| `ben-pr-p/pglite-pool`                 | Test helper + ephemeral pool  | Yes (+ Bun)       | No (wraps pglite-server)     | Community, limited scope   | https://github.com/ben-pr-p/pglite-pool                            |
| PGlite `live` extension                | Reactive queries              | Yes               | Yes (within one process)     | Stable (official)          | https://pglite.dev/docs/                                           |
| Supabase Live Share                    | Browser-to-psql tunnel        | Browser + proxy   | No (1 client at a time)      | Production but specialized | https://supabase.com/blog/database-build-live-share                |

---

## Research Gaps

- The `@middle-management/pglite-pg-adapter` npm page returned 403; could not fully inspect the source. The package name and description were confirmed via search results.
- No information found about electric-sql's internal plans (private roadmap items not visible on GitHub)
- `pglite-pool` by ben-pr-p was confirmed to use `pglite-server` internally and create one ephemeral instance per call — it does not pool across instances

---

## Sources & Evidence

- [Multi-tab Worker | PGlite](https://pglite.dev/docs/multi-tab-worker) — Official docs for PGliteWorker
- [PGlite Socket | PGlite](https://pglite.dev/docs/pglite-socket) — Official docs for pglite-socket
- [Getting started with PGlite | PGlite](https://pglite.dev/docs/) — Live query extension documentation
- [Support for concurrent databases (node.js) · Issue #324 · electric-sql/pglite](https://github.com/electric-sql/pglite/issues/324) — Open issue tracking concurrent DB limitation
- [GitHub - supabase-community/pg-gateway](https://github.com/supabase-community/pg-gateway) — Supabase Postgres wire protocol server
- [GitHub - kamilogorek/pglite-server](https://github.com/kamilogorek/pglite-server) — Community TCP server for PGlite
- [@middle-management/pglite-pg-adapter - npm](https://www.npmjs.com/package/@middle-management/pglite-pg-adapter) — In-process pg-compatible adapter
- [ben-pr-p/pglite-pool](https://github.com/ben-pr-p/pglite-pool) — Test helper wrapping pglite-server
- [Live Share: Connect to in-browser PGlite with any Postgres client](https://supabase.com/blog/database-build-live-share) — Supabase Live Share architecture
- [electric-sql/pglite-socket - npm](https://www.npmjs.com/package/@electric-sql/pglite-socket) — Official pglite-socket package
- [Show HN: PGlite – in-browser WASM Postgres with pgvector and live sync | Hacker News](https://news.ycombinator.com/item?id=41224689) — Community discussion

---

## Search Methodology

- Searches performed: 10
- Most productive terms: "pglite server wire protocol postgres", "pglite socket node.js", "pglite multi process connection pooling", "pg-gateway pglite", "PGliteWorker multi-tab worker Node.js"
- Primary sources: pglite.dev official docs, electric-sql GitHub, supabase-community GitHub, npm registry
