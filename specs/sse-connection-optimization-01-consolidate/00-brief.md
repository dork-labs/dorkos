---
slug: sse-connection-optimization-01-consolidate
number: 187
created: 2026-03-27
status: brief
project: sse-connection-optimization
phase: 1
---

# Phase 1: Consolidate SSE Connections

**Project:** SSE Connection Optimization
**Phase:** 1 of 2
**Depends on:** Nothing (first phase)
**Enables:** Phase 2 (fetch-based SSE transport unlocks HTTP/2 multiplexing on the consolidated stream)

---

## Problem

The DorkOS client opens multiple persistent `EventSource` (SSE) connections to the same origin:

1. **Session sync** (`SSEConnection` → `/api/sessions/:id/stream`) — persistent, per-session
2. **Tunnel events** (`EventSource('/api/tunnel/stream')`) — persistent, always on
3. **Extension events** (`EventSource('/api/extensions/events')`) — persistent, always on
4. **Relay stream** (`/api/relay/stream`) — persistent, when Relay is enabled
5. **Message stream** (`fetch('/sessions/:id/messages')`) — active during agent conversation

Browsers limit HTTP/1.1 connections to **6 per origin** (Chrome). When 4-5 persistent SSE connections are open and the message stream is active, the connection pool is exhausted. Any subsequent HTTP request (tool approval, API polling, TanStack Query refetches) gets **queued by the browser** and never reaches the server until a connection frees up.

This causes the critical tool approval bug: clicking "Approve" hangs for 30s (the `fetchJSON` timeout) because the POST request is queued behind SSE connections. The server never sees the request — no server-side errors appear. The client appears frozen.

**Note:** `EventSource` is an HTTP/1.1-only API. Even with HTTP/2 on the server, `EventSource` connections do not multiplex. This constraint makes consolidation the correct first fix regardless of future HTTP/2 adoption.

## Scope

Merge the global SSE connections (tunnel, extensions, relay) into a single multiplexed event stream. The session-scoped sync stream stays separate (it's per-session and already managed by `SSEConnection`).

**In scope:**

- Single `GET /api/events` endpoint that carries tunnel, extension, and relay events (distinguished by SSE event name)
- Server-side event fan-out from existing event emitters into the unified stream
- Server-side heartbeat on the unified stream (reuse existing heartbeat pattern)
- Client-side consumer that routes events to existing handlers by event type
- Removal of the three individual `EventSource` connections from tunnel, extension, and relay consumers
- Connection drops from 4-5 per tab to 2 (one global unified + one per-session)

**Out of scope:**

- Replacing `EventSource` with `fetch()`-based SSE (Phase 2)
- HTTP/2 server migration
- Session sync stream consolidation (it's session-scoped and needs to stay separate)
- WebSocket or WebTransport adoption

## Deliverables

### 1. Unified SSE Endpoint (`GET /api/events`)

**Problem:** Three separate SSE endpoints exist (`/api/tunnel/stream`, `/api/extensions/events`, `/api/relay/stream`), each consuming a browser connection.

**Solution:**

- Create a single `GET /api/events` Express route that opens one SSE stream per client
- Fan out events from the tunnel manager, extension reloader, and relay core into this stream
- Each event retains its original event name (e.g., `tunnel_status`, `extension_reloaded`, `relay_message`) so client-side routing is a simple event-name filter
- Include periodic heartbeat events (reuse `SSE.HEARTBEAT_INTERVAL_MS` from constants)
- Support optional `?subscribe=tunnel,extensions,relay` query param for selective subscription (optimization, not required for v1)

**Key source files:**

- `apps/server/src/routes/tunnel.ts` — `GET /api/tunnel/stream` (SSE endpoint)
- `apps/server/src/routes/extensions.ts` — `GET /api/extensions/events` (SSE endpoint)
- `apps/server/src/routes/relay.ts` — `GET /api/relay/stream` (SSE endpoint)
- `apps/server/src/services/core/stream-adapter.ts` — `initSSEStream`, `sendSSEEvent`, `endSSEStream` helpers

### 2. Client-Side Unified Consumer

**Problem:** Three separate `EventSource` instances are created in different hooks/components, each managing its own connection lifecycle.

**Solution:**

- Create a single `SSEConnection` instance for the unified `/api/events` stream, managed at the app shell level
- Route incoming events to existing handlers based on event type — tunnel events go to the tunnel sync hook, extension events go to the extension context, relay events go to the relay event stream
- Existing consumer hooks (`useTunnelSync`, extension context `useEffect`, `useRelayEventStream`) switch from managing their own `EventSource` to subscribing to the shared connection's event router
- The shared connection uses the existing `SSEConnection` class (already has backoff, heartbeat watchdog, visibility optimization)

**Key source files:**

- `apps/client/src/layers/entities/tunnel/model/use-tunnel-sync.ts` — Creates `new EventSource('/api/tunnel/stream')`
- `apps/client/src/layers/features/extensions/model/extension-context.tsx` — Creates `new EventSource('/api/extensions/events')`
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts` — Creates SSE connection for relay events
- `apps/client/src/layers/shared/lib/transport/sse-connection.ts` — `SSEConnection` class with full resilience

### 3. Deprecate Individual SSE Endpoints

**Problem:** The old individual endpoints should be removed to prevent connection leaks if any consumer still uses them.

**Solution:**

- Remove the three individual SSE routes after the unified endpoint is stable
- If backward compatibility is needed (e.g., Obsidian plugin uses one directly), keep them but log a deprecation warning

## Key Decisions (Settled)

1. **Consolidate global streams only** — Session sync (`/api/sessions/:id/stream`) stays separate because it's session-scoped and already well-managed by `SSEConnection`.
2. **Event-name routing** — Use SSE event names (not a payload-level `type` field) for client-side routing. This matches the existing pattern and requires no parsing overhead.
3. **Single `SSEConnection` instance** — Reuse the existing class with its backoff, heartbeat, and visibility optimization. No new connection management code.
4. **Server-side fan-out via EventEmitter** — Node's built-in `EventEmitter` is sufficient. No external pub/sub library needed.

## Open Questions (For /ideate)

1. **Selective subscription** — Should `/api/events` accept a query param like `?subscribe=tunnel,extensions` to limit which event types are sent? Or always send everything and let the client filter?
2. **Obsidian plugin impact** — Does the Obsidian plugin use any of the individual SSE endpoints directly? If so, does it use `DirectTransport` (in-process) and bypass HTTP entirely?
3. **Connection lifecycle on route change** — Should the unified stream disconnect when leaving the `/session` route? Or stay connected globally (dashboard, agents page)?
4. **Backpressure** — If a client falls behind on event consumption, should the server buffer, drop, or disconnect?

## Reference Material

### Existing specs

- `specs/sse-resilience-connection-health/` (spec #174) — SSE resilience infrastructure, `SSEConnection` class, heartbeat watchdog
- `specs/client-direct-sse/` — Direct SSE transport patterns

### Research

- `research/` — Check for existing SSE or connection management research before new research

### Architecture docs

- `contributing/architecture.md` — Hexagonal architecture, Transport interface
- `contributing/relay-adapters.md` — Relay adapter event patterns

## Acceptance Criteria

- [ ] `GET /api/events` endpoint exists and streams tunnel, extension, and relay events over a single SSE connection
- [ ] Server sends heartbeat events on the unified stream at the configured interval
- [ ] Client creates one `SSEConnection` for the unified stream (managed at app shell level)
- [ ] `useTunnelSync` no longer creates its own `EventSource` — subscribes to the unified stream
- [ ] Extension context no longer creates its own `EventSource` — subscribes to the unified stream
- [ ] `useRelayEventStream` no longer creates its own `EventSource` — subscribes to the unified stream
- [ ] Total persistent SSE connections per tab drops from 4-5 to 2 (unified global + session sync)
- [ ] Tool approval requests no longer time out due to connection exhaustion under normal usage
- [ ] No behavioral regression in tunnel status updates, extension hot-reload, or relay message delivery
- [ ] Individual SSE endpoints are removed or deprecated with warnings
