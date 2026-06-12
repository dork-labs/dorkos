---
number: 265
title: Global Multiplexed Status Stream for Session & Agent Liveness
status: accepted
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 265. Global Multiplexed Status Stream for Session & Agent Liveness

## Status

Accepted — 2026-06-11 (implemented by spec: chat-stream-reconnection; updated post-implementation to record the decision as built)

## Context

The sidebar agent/session list polled REST every 5s, and the status bar (context usage, cost, cache, model, todo counts) was computed from in-memory state that was `null` until the next live event — both drifted and were stale immediately after a hard refresh. Opening one SSE connection per session for liveness would exhaust the HTTP/1.1 6-connection budget. Sessions driven outside DorkOS (e.g. the Claude Code CLI) were only discovered on the next poll tick.

## Decision

One multiplexed always-on stream replaces sidebar polling. Rather than adding a new endpoint, the existing unified `GET /api/events` fan-out (`apps/server/src/routes/events.ts`) carries the session-list events: `SessionListBroadcaster` (`apps/server/src/services/session/session-list-broadcaster.ts`) bridges the active runtime's `subscribeSessionList()` (server-side discovery, including externally-driven sessions via the adapter's debounced directory watch) plus the projector registry's lifecycle fan-out (`onProjectorStatusChange`) onto it, validating every event against `SessionListEventSchema` before the wire.

The event set is exactly three (`packages/shared/src/session-stream.ts`): `session_upserted` (full `Session` payload), `session_removed`, and `session_status` (full `SessionStatus` projection). There are no separate `agent_status`/`presence` events — agent-level liveness is **aggregated client-side**: `session_status` carries an optional `cwd`, and the sidebar's agent rows light up when any session in the agent's cwd is streaming/blocked (`statusCwds` in `apps/client/src/layers/entities/session/model/session-list-store.ts`).

`session_status` also carries an optional `retiredSessionId` — set only on the re-announce after a first-turn rekey (ADR-0267): the request UUID the session streamed under before the canonical id resolved. Clients MUST drop all state held under that id (pre-rekey transitions landed under it and no `session_removed` will ever fire for it — a lingering `streaming` would pin agent-row liveness forever), record the rekey, and migrate client-authored continuity to the canonical id.

The 5s sessions poll is removed (`use-sessions.ts` deliberately sets no `refetchInterval`). Status survives refresh/switch because it is carried whole in the per-session snapshot and kept live by these events. Status fan-out is lifecycle-transition-gated — per-chunk `status_change` deltas (output-token counts) do not hit the global stream. Combined with the per-session durable stream, a client holds two SSE connections total; the client `StreamManager` reuses the list connection for the server's other broadcast events (tunnel status, relay traffic) so generic consumers never open a third.

## Consequences

### Positive

- Sidebar + status are accurate immediately after refresh and update live without timer polling; externally-driven sessions appear via server-side discovery.
- Bounded connection count (2 SSE/client), leaving HTTP/1.1 slots for approve/deny POSTs.
- Reusing the existing `/api/events` fan-out meant no new endpoint, client connection, or auth surface — only new event names on a stream that already existed.

### Negative

- The global stream has no replay/cursor: `session_status` is fan-out-only, so a status held across a disconnect can go stale until that session's next transition — the client binding compensates by resetting all held statuses on every (re)connect, accepting a brief blank-status window.
- Per-agent liveness derived from `cwd` is heuristic — it assumes one agent per working directory and that the server knows the session's cwd.
- The server must reliably emit lifecycle transitions and watch for external session changes; a watcher construction failure degrades discovery to the client's opt-in polling fallback (ADR-0266) rather than failing the server.
