---
number: 25
title: Use Simple JSON Columns for Agent Registry SQLite Schema
status: proposed
created: 2026-02-24
spec: mesh-core-library
superseded-by: null
---

# 25. Use Simple JSON Columns for Agent Registry SQLite Schema

## Status

Proposed (auto-extracted from spec: mesh-core-library)

## Context

The agent registry needs to persist agent metadata in SQLite. We evaluated two schema approaches: a normalized 5-table design (agents, capabilities, behaviors, budgets, denials) with foreign keys, and a simple 2-table design (agents + denials) with JSON columns for capabilities and manifest data. The expected agent count is 5-50 per user.

## Decision

Use a simple 2-table schema with `capabilities_json TEXT` and `manifest_json TEXT` columns on the agents table, plus a separate denials table. Capability filtering is done at the application layer by parsing the JSON array and using `Array.includes()`. This follows the same pattern as `@dorkos/relay`'s SQLite usage (WAL mode, PRAGMA user_version migrations, prepared statements).

## Consequences

### Positive

- Simpler schema: 2 tables vs 5 tables, fewer migrations to manage
- Matches the existing relay package's SQLite patterns exactly
- Application-layer filtering at 5-50 agents is sub-millisecond — no performance concern
- Easy to evolve: adding fields to the manifest just means updating the JSON, no schema migration
- SQLite's `json_each()` is available as an escape hatch if query-level filtering is needed later

### Negative

- Cannot use SQL indexes on individual capabilities (must parse JSON in application code)
- No referential integrity for capabilities — relies on Zod validation at the application layer
- Would need schema migration if agent count grows to thousands and query performance matters
