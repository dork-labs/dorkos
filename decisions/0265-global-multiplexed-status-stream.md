---
number: 265
title: Global Multiplexed Status Stream for Session & Agent Liveness
status: draft
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 265. Global Multiplexed Status Stream for Session & Agent Liveness

## Status

Draft (auto-extracted from spec: chat-stream-reconnection)

## Context

The sidebar agent/session list polls REST every 5s and the status bar (context usage, cost, cache, model, todo counts) is computed from in-memory state that is `null` until the next live event — so both drift and are stale immediately after a hard refresh. Opening one SSE connection per session for liveness would exhaust the HTTP/1.1 6-connection budget. Sessions driven outside DorkOS (e.g. the Claude Code CLI) are only discovered on the next poll tick.

## Decision

Add a single always-on multiplexed `GET /api/events` stream carrying named events — `agent_status`, `session_upserted`, `session_removed`, `presence` — derived from the runtime adapters' `subscribeSessionList()` (server-side discovery, including externally-driven sessions). The sidebar and status items subscribe to a store fed by this stream instead of polling; the 5s sessions poll is removed. Combined with the per-session durable stream, a client holds two SSE connections total. Status reloads on refresh/switch because it is carried in the per-session snapshot and kept live by these events.

## Consequences

### Positive

- Sidebar + status are accurate immediately after refresh and update live without timer polling.
- Externally-driven sessions appear live via server-side discovery, no client polling required.
- Bounded connection count (~2 SSE/client), leaving HTTP/1.1 slots for approve/deny POSTs.

### Negative

- The server must reliably emit lifecycle/status transitions and watch for external session changes (debounced file-watch for the Claude adapter).
- A new always-on stream and its client subscription to build and test.
