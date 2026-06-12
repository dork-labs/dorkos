---
number: 39
title: Use Drizzle ORM for Database Layer
status: accepted
created: 2026-02-25
spec: db-drizzle-consolidation
superseded-by: null
---

# 39. Use Drizzle ORM for Database Layer

## Status

Accepted

## Context

DorkOS had three separate SQLite databases with ~35 hand-written `better-sqlite3` prepared statements spread across six files. Each service managed its own `PRAGMA user_version` migration chain independently. There was no standardized query API and no type safety between schema definitions and query results. Schema changes could be committed without corresponding migration files, causing silent failures for users on upgrade.

## Decision

Adopt Drizzle ORM (`drizzle-orm` + `drizzle-kit`) as the single database layer for all DorkOS SQLite access. All hand-written prepared statements are replaced with Drizzle's type-safe query builder. Drizzle Kit generates SQL migration files by diffing TypeScript schema definitions against a stored snapshot. The `migrate()` function from `drizzle-orm/better-sqlite3/migrator` applies pending migrations synchronously at server startup.

## Consequences

### Positive

- TypeScript types are inferred directly from schema definitions — no manual interface duplication
- Migration files are auto-generated from schema diffs (no hand-writing SQL)
- `__drizzle_migrations` table tracks applied migrations by content hash — idempotent and reliable
- Single consistent query API across all domains (Pulse, Relay, Mesh)
- Schema and query code are co-located in `packages/db` — easier to audit and change

### Negative

- Drizzle has no native `--check`/`--dry-run` flag for CI validation (open issue #5059 as of Feb 2026) — requires a workaround via generate + git diff
- Drizzle query builder is a new abstraction layer for contributors familiar with raw SQL
- `drizzle-kit generate` must be run (automatically by lefthook hook) whenever the schema changes — cannot skip this step
