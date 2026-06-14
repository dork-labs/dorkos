---
number: 255
title: Persist Per-Session Runtime Ownership in Drizzle `session_metadata` Table
status: accepted
created: 2026-04-16
spec: codex-runtime-adapter-prework
superseded-by: null
---

# 0255. Persist Per-Session Runtime Ownership in Drizzle `session_metadata` Table

## Status

Accepted

## Context

With a second runtime (Codex) coming, every session needs a stable `runtime` owner so production routes can dispatch correctly. The server's default runtime and the agent manifest's `runtime` field can both change over time, so the per-session owner cannot safely be recomputed on each request. Three candidates were considered: a Claude JSONL header field, a sidecar JSON file, or a row in the consolidated Drizzle DB (`packages/db`, spec #63). DB consolidation has already landed and the established DorkOS pattern is "primary data in files, operational metadata in SQLite" (see ADR 0003 for the file-primary rule for transcripts; relay index, mesh agent registry, and pulse runs all follow the SQLite-for-metadata half).

## Decision

Add a `session_metadata` table to `packages/db/src/schema/sessions.ts` with columns `(sessionId, runtime, agentPath, createdAt)`. Session _content_ continues to live in JSONL (for Claude) or the equivalent runtime-specific transcript format; only the operational metadata — which runtime owns this session — lives in the DB. `runtimeRegistry.resolveForSession(sessionId)` reads from this table. Legacy sessions that predate this table are inferred as `claude-code` on first access and persisted.

## Consequences

### Positive

- Deterministic runtime dispatch for every session, independent of default-runtime or agent-manifest drift.
- Enables concrete future queries — sessions sidebar filtered by runtime, mesh observability counting active sessions per runtime, cross-runtime search — in a single indexed query.
- Fits the established layered pattern; no new storage primitive introduced.
- No later sidecar→SQLite migration needed once observability features want richer queries.

### Negative

- Couples this spec's Phase 1 to the DB schema / Drizzle migration workflow.
- Sessions created during rollback windows need careful back-fill handling.
- A new write path on session creation (writes to JSONL _and_ DB); partial failures require reconciliation.
