---
number: 40
title: Consolidate All DorkOS Databases to Single dork.db
status: accepted
created: 2026-02-25
spec: db-drizzle-consolidation
superseded-by: null
---

# 40. Consolidate All DorkOS Databases to Single dork.db

## Status

Accepted

## Context

DorkOS maintained three separate SQLite database files: `~/.dork/pulse.db`, `~/.dork/relay/index.db`, and `~/.dork/mesh/mesh.db`. `TraceStore` and `SqliteIndex` shared `relay/index.db` but could not both use `PRAGMA user_version` cleanly — `TraceStore` was forced to use `CREATE TABLE IF NOT EXISTS` with no version tracking. `AgentRegistry`, `DenialList`, and `BudgetMapper` shared `mesh/mesh.db` via a raw `database` getter that leaked the `better-sqlite3` connection object across service boundaries. This created tight coupling and made it impossible to move the database layer to a shared package.

## Decision

Consolidate all three databases into a single `~/.dork/dork.db` file, managed through a new `packages/db` workspace package that exports a single `createDb(dbPath)` factory function and a `Db` type. All tables from all three databases are combined into one Drizzle schema with domain-prefixed table names (`pulse_schedules`, `pulse_runs`, `relay_index`, `relay_traces`, `agents`, `agent_denials`, `rate_limit_buckets`). One Drizzle instance is created at server startup and injected into all services.

## Consequences

### Positive

- One migration folder, one `__drizzle_migrations` table, one consistent history
- Services receive `Db` via constructor injection — no raw `Database` getter leakage
- `packages/db` is importable by Obsidian plugin (DirectTransport) without depending on the server
- Single WAL file to monitor, backup, and reason about
- Eliminates the PRAGMA user_version conflict between SqliteIndex and TraceStore

### Negative

- All tables are visible to all services — no domain isolation at the SQL level (mitigated by namespace conventions and code organization)
- Fresh start required for existing users — old `pulse.db`, `relay/index.db`, `mesh/mesh.db` data is abandoned (acceptable because all data is ephemeral or rebuildable)
- A bug in one service's schema can affect the shared `__drizzle_migrations` table (mitigated by Drizzle's content-hash tracking)
