---
number: 260
title: Persist Per-Session Settings in the API Core via a Narrow Port
status: accepted
created: 2026-06-08
spec: null
superseded-by: null
---

# 260. Persist Per-Session Settings in the API Core via a Narrow Port

## Status

Accepted

Extends [ADR-0255](0255-per-session-runtime-in-session-metadata-table.md) (adds columns to the same `session_metadata` table). Builds on [ADR-0240](0240-passthrough-permission-modes-to-sdk.md) (permission-mode passthrough), [ADR-0241](0241-runtime-declares-supported-permission-modes.md) (runtime-declared modes), and [ADR-0256](0256-runtime-capabilities-shape-booleans-plus-structured-plus-features.md) (capabilities shape). Supersedes none.

## Context

Per-session mutable settings — `permissionMode`, `model`, `effort`, `fastMode`, `autoMode` — live **only** on the in-memory `AgentSession` in the claude-code runtime; they are never persisted. On 30-minute idle eviction (`checkSessionHealth`) or server restart (frequent while dogfooding), the in-memory session is discarded, and the next message re-creates it with `permissionMode` hardcoded to `'default'` and the rest left undefined. Meanwhile the UI derives the displayed mode from the SDK JSONL transcript — the session-list badge reads the transcript head, the in-session toolbar reads the tail, and enforcement reads in-memory state — so three sources diverge. The reproduced symptom: a session the UI badges "Permissions bypassed" still prompts for tool approval because in-memory `permissionMode` silently reverted to `default`. This is **structural, not Claude-Code-specific** — any runtime with an in-memory working set plus idle eviction inherits it.

## Decision

We will make the **API core layer** (`apps/server/src/services/core/`, which already owns the `session_metadata` table and per-session runtime ownership) the single owner of session-settings persistence; the frontend is unchanged and remains a pure consumer. We will extend the existing `session_metadata` table (PK `sessionId`) with five nullable columns — `permission_mode`, `model`, `effort`, `fast_mode`, `auto_mode` — where mutable user prefs (last-write-wins `UPDATE`) coexist with immutable identity (`runtime`, `agentPath` — first-write-wins) in one 1:1 row, separated by column-group comments. We will define a single `SessionSettings` type + Zod schema in `@dorkos/shared` (collapsing the five fields currently duplicated across `UpdateSessionRequestSchema`, `updateSession`, `MessageOpts`, and `ensureSession` opts) and a narrow `SessionSettingsPort` (`getSettings`/`saveSettings`) implemented by a core service and injected into runtimes via an optional `setSessionSettings?(port)` setter — mirroring the existing `AgentRegistryPort`/`RelayPort` + `setMeshCore`/`setRelay` pattern, so runtimes stay pure executors and new runtimes opt in. The persisted store becomes the source of truth: runtimes **hydrate** in `ensureForMessage` (the funnel all send paths share — HTTP, Tasks, relay) with precedence `per-send override → persisted → runtime default`, **write through** in `updateSession`, and overlay the store in `getSession`/`listSessions` so badge, toolbar, and enforcement read one value; the in-memory session is a warm cache and the transcript is a legacy-only fallback. Finally, we will replace the Claude-specific `'default'` assumption with a runtime-declared default permission mode on `RuntimeCapabilities.permissionModes`, treating a `null` column as "use this runtime's default" and validating stored modes against the resolved runtime's capability list on read.

## Consequences

### Positive

- Fixes all five settings uniformly and permanently — they survive idle eviction and server restart.
- Collapses the three divergent display/enforcement sources into one, eliminating the "shows bypass, still prompts" class of desync.
- Runtime-agnostic by construction: a new runtime gains durable settings simply by accepting the injected port; the HTTP route, Tasks, and relay send paths all benefit because hydration lives below the dispatch point.
- Removes duplicated field lists (one `SessionSettings` type) and the hardcoded `'default'`, making each runtime define its own default mode.
- Reuses an existing table and an established port pattern — no new storage primitive or architectural concept.

### Negative

- Requires a Drizzle migration to add the columns (backward compatible — existing rows get `NULL` = runtime default; no backfill needed).
- One `session_metadata` row now mixes immutable identity with mutable preferences (two write semantics in one table), relying on column-group comments to keep the distinction legible.
- Adds a write on every settings change and a read on cold-session hydration; both are single indexed lookups, but the in-memory session is no longer fully self-contained.

## Alternatives Considered

- **New dedicated `session_settings` table** — cleaner immutable/mutable separation, but an extra 1:1 table and join for the same key and lifecycle; YAGNI.
- **Write settings into the SDK JSONL transcript** — we do not own that schema, it is SDK-specific, and `effort`/`fastMode`/`autoMode` are not representable; would not generalize across runtimes.
- **Client re-asserts settings on every send** — the client's own state derives from the lossy transcript, breaks on reload, and every transport plus Tasks/relay send would have to remember to include the settings; insufficient on its own.
- **`.dork/sessions/<id>.json` file sidecar** — a redundant second source of truth beside the existing DB row, adding reconciliation burden.
