---
slug: sse-connection-optimization-01-consolidate
number: 187
created: 2026-03-27
status: specified
project: sse-connection-optimization
phase: 1
---

# Phase 1: Consolidate SSE Connections

**Slug:** sse-connection-optimization-01-consolidate
**Author:** Claude Code
**Date:** 2026-03-27
**Branch:** preflight/sse-connection-optimization-01-consolidate

---

## Source Brief

`specs/sse-connection-optimization-01-consolidate/00-brief.md` (spec #187)

---

## 1) Intent & Assumptions

- **Task brief:** Consolidate the 4 persistent global SSE connections (session sync, tunnel, extensions, relay) into 2 (one unified global stream + one per-session sync stream). This resolves the critical tool approval timeout bug caused by HTTP/1.1 per-origin connection exhaustion (6-connection limit in Chrome).

- **Assumptions:**
  - The app runs on localhost (Express serves the client directly) — no reverse proxy, no HTTP/2
  - `EventSource` is HTTP/1.1-only; even with HTTP/2 on the server, EventSource connections don't multiplex
  - The tunnel, extension, and relay event streams are low-volume — consolidating them adds negligible overhead
  - The `SSEConnection` class already provides full resilience (backoff, heartbeat, visibility optimization) and can be reused as-is for the unified stream
  - The Obsidian plugin uses `DirectTransport` (in-process) and is unaffected by HTTP transport changes
  - The session sync stream (`GET /api/sessions/:id/stream`) stays separate because it's session-scoped

- **Out of scope:**
  - Replacing `EventSource` with `fetch()` + `ReadableStream` (Phase 2)
  - HTTP/2 server migration
  - WebSocket or WebTransport adoption
  - Consolidating the session sync stream (it's session-scoped by design)
  - Selective server-side subscription filtering (`?subscribe=` param) — always send everything in v1

## 2) Pre-reading Log

- `apps/server/src/routes/tunnel.ts`: `GET /api/tunnel/stream` — EventEmitter listener on `tunnelManager.on('status_change')`, manual `res.write()`, no heartbeat, event name: `tunnel_status`
- `apps/server/src/routes/extensions.ts`: `GET /api/extensions/events` — broadcast to `sseClients` Set, manual `res.write()`, initial `:ok\n\n` heartbeat only, event name: `extension_reloaded`
- `apps/server/src/routes/relay.ts`: `GET /api/relay/stream` — `initSSEStream()`, keepalive comment every 15s, subject filtering via `?subject=`, event names: `relay_connected`, `relay_message`, `relay_backpressure`, `relay_signal`
- `apps/server/src/routes/sessions.ts`: `GET /api/sessions/:id/stream` — persistent per-session, heartbeat every 15s (`SSE.HEARTBEAT_INTERVAL_MS`), event names: `sync_connected`, `sync_update`, `presence_update`
- `apps/server/src/services/core/stream-adapter.ts`: `initSSEStream()`, `sendSSEEvent()`, `endSSEStream()` — shared SSE helpers used by session and relay streams
- `apps/client/src/layers/entities/tunnel/model/use-tunnel-sync.ts`: Creates `new EventSource('/api/tunnel/stream')` directly — manual lifecycle
- `apps/client/src/layers/features/extensions/model/extension-context.tsx`: Creates `new EventSource('/api/extensions/events')` directly — manual lifecycle
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`: Uses `useSSEConnection()` hook with resilience
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Uses `useSSEConnection()` for session sync (line 325), creates SSE with `enableCrossClientSync` flag
- `apps/client/src/layers/shared/lib/transport/sse-connection.ts`: `SSEConnection` class — full resilience: exponential backoff with jitter, heartbeat watchdog (45s), page visibility optimization (30s grace), state machine
- `apps/client/src/layers/shared/model/use-sse-connection.ts`: React wrapper around `SSEConnection` — handler stabilization via ref, visibility optimization, clean teardown
- `apps/server/src/config/constants.ts`: `SSE.HEARTBEAT_INTERVAL_MS = 15000`, `SSE.MAX_CLIENTS_PER_SESSION = 10`, `SSE.MAX_TOTAL_CLIENTS = 500`
- `apps/client/src/layers/shared/lib/constants.ts`: `SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS = 45000` (3x server interval), backoff base 500ms, cap 30s
- `research/20260324_sse_resilience_production_patterns.md`: Production SSE patterns, heartbeat strategies, alternatives to native EventSource
- `research/20260312_client_direct_sse_relay_removal.md`: Decision to remove relay from web client chat path; relay SSE serves external adapters only
- `research/20260327_sse_multiplexing_unified_stream.md`: SSE multiplexing patterns, singleton connection manager, incremental migration strategy

## 3) Codebase Map

**Primary components/modules:**

Server — SSE endpoints to consolidate:

- `apps/server/src/routes/tunnel.ts` (lines 39-56) — `GET /api/tunnel/stream`
- `apps/server/src/routes/extensions.ts` (lines 62-79) — `GET /api/extensions/events`
- `apps/server/src/routes/relay.ts` (lines 363-429) — `GET /api/relay/stream`

Server — SSE infrastructure:

- `apps/server/src/services/core/stream-adapter.ts` — `initSSEStream`, `sendSSEEvent`, `endSSEStream`
- `apps/server/src/config/constants.ts` — SSE timing constants

Client — consumers to migrate:

- `apps/client/src/layers/entities/tunnel/model/use-tunnel-sync.ts` — raw `EventSource`
- `apps/client/src/layers/features/extensions/model/extension-context.tsx` — raw `EventSource`
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts` — `useSSEConnection()`

Client — SSE infrastructure (reuse):

- `apps/client/src/layers/shared/lib/transport/sse-connection.ts` — `SSEConnection` class
- `apps/client/src/layers/shared/model/use-sse-connection.ts` — `useSSEConnection()` hook

**Shared dependencies:**

- `apps/server/src/services/core/stream-adapter.ts` — used by session sync and relay streams
- `@dorkos/shared/types` — `ConnectionState` type shared between server and client
- TanStack Query — tunnel, extension, and relay consumers invalidate query caches on events

**Data flow (current):**

```
Server EventEmitters (tunnel, extension, relay)
  → 3 separate SSE endpoints (3 HTTP connections)
    → 3 separate EventSource instances in browser
      → 3 separate event handlers (cache invalidation, state updates)
```

**Data flow (target):**

```
Server EventEmitters (tunnel, extension, relay)
  → 1 unified SSE endpoint (1 HTTP connection)
    → 1 SSEConnection instance in browser
      → Event router dispatches by event name
        → Existing handlers (unchanged)
```

**Feature flags/config:**

- `enableCrossClientSync` flag controls session sync stream (not affected)
- Relay stream is conditional on relay being enabled (behavior preserved in unified stream)

**Potential blast radius:**

- Direct: 6 files (3 server routes + 3 client consumers)
- New: 2 files (1 server route for `/api/events` + 1 client-side event router/provider)
- Indirect: 0 — existing event handlers are unchanged, they just receive events from a different source
- Tests: Existing tests for tunnel sync, extension context, and relay event stream will need mock updates

## 4) Root Cause Analysis

Not applicable — this is a feature, not a bug fix. The bug (tool approval timeout) is already mitigated by the timeout increase in `http-transport.ts`. This spec addresses the underlying architectural issue.

## 5) Research

Research reference: `research/20260327_sse_multiplexing_unified_stream.md`

**Potential solutions:**

**1. Unified SSE endpoint with event-name routing (Recommended)**

- Single `GET /api/events` endpoint, server fans out from existing EventEmitters
- Uses SSE spec's built-in `event:` field for type discrimination
- Client creates one `SSEConnection` with handler map keyed by event name
- Pros: Simplest, uses existing SSE infrastructure, no new dependencies, matches existing `SSEConnection` handler pattern
- Cons: All events go to all clients (acceptable given low volume)
- Complexity: Low
- Maintenance: Low

**2. JSON envelope multiplexing**

- Single endpoint, but wrap events in `{ type: "tunnel_status", data: {...} }` envelope
- Client parses JSON and routes by `type` field
- Pros: More flexible payload structure
- Cons: Extra parsing step, doesn't match existing `SSEConnection` pattern which uses SSE event names, more code
- Complexity: Medium
- Maintenance: Medium

**3. WebSocket replacement**

- Replace all SSE with a single WebSocket connection
- Pros: Full duplex, single connection
- Cons: Completely different server architecture, Express needs `ws` library, breaks existing SSE infrastructure, overkill for unidirectional events
- Complexity: High
- Maintenance: High

**Recommendation:** Solution 1 (unified SSE with event-name routing). It's the simplest approach, reuses all existing infrastructure, and the `SSEConnection` class already supports named event handlers natively.

**Key implementation insight from research:** `EventSource` should only be instantiated **once per app lifetime**, not once per hook mount. The current architecture creates 3 separate `EventSource` instances in different hooks — the unified approach creates 1.

## 6) Decisions

| #   | Decision                             | Choice                                  | Rationale                                                                                                                                                                                                                                                               |
| --- | ------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Selective subscription               | Always send everything, client filters  | Event volume is low across all three streams. Server-side filtering adds reconnection complexity and subscription state for negligible bandwidth savings.                                                                                                               |
| 2   | Obsidian plugin impact               | No impact                               | Obsidian plugin uses `DirectTransport` (in-process), bypassing HTTP entirely. Verified via codebase exploration.                                                                                                                                                        |
| 3   | Connection lifecycle on route change | Stay connected globally                 | Tunnel events and extension reloads are relevant on every page. `SSEConnection` already handles visibility optimization (disconnect on tab hide) — that's the right granularity. Route-scoped connections would add latency and reconnection complexity for no benefit. |
| 4   | Backpressure                         | Adopt relay stream's existing pattern   | The relay SSE endpoint already handles backpressure with write-or-queue and drain events (`routes/relay.ts` lines 399-422). The unified endpoint should reuse this proven pattern.                                                                                      |
| 5   | Event routing mechanism              | SSE `event:` field (not JSON envelope)  | Matches the SSE spec, matches `SSEConnection`'s existing named event handler pattern, zero parsing overhead.                                                                                                                                                            |
| 6   | Heartbeat strategy                   | Single shared heartbeat at 15s interval | Reuse `SSE.HEARTBEAT_INTERVAL_MS` constant. One heartbeat serves the whole connection — no per-stream heartbeats needed.                                                                                                                                                |
| 7   | Server-side fan-out                  | Node.js `EventEmitter`                  | Each existing stream source (tunnel manager, extension broadcaster, relay core) already uses EventEmitter patterns. The unified endpoint listens to all three and writes to a single response. No external pub/sub needed.                                              |
