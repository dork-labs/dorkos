---
number: 264
title: Server-Owned Durable, Resumable Per-Session Stream (Turn Decoupled from POST)
status: draft
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 264. Server-Owned Durable, Resumable Per-Session Stream (Turn Decoupled from POST)

## Status

Draft (auto-extracted from spec: chat-stream-reconnection)

## Context

Live token streaming is bound to the lifecycle of the `POST /api/sessions/:id/messages` request, so a hard refresh or second window mid-turn has nothing to reattach to. The only reconnection stream (`GET /:id/stream`) is gated behind an off-by-default toggle and, when on, carries only `sync_update`/pending re-emits — not the in-flight turn. There is no gap-free way to hydrate current state and continue streaming. This generalizes the DOR-73 / ADR-0262 pending-interaction recovery to all event classes.

## Decision

Make the persistent DorkOS server the durable mediator. A `SessionStateProjector` consumes the runtime's event stream, assigns a per-session monotonic `seq`, maintains a live-state projection, an EventLog, and a bounded **RingBuffer** for the current turn (TTL after `turn_end`). The message POST becomes **trigger-only** (start/queue the turn, return the canonical id); turn tokens flow through the projector to a single delivery path. A new always-on `GET /api/sessions/:id/events` serves **snapshot → gap-replay (`Last-Event-ID` / `?after=cursor`) → live**, emitting `id: <sid>-<seq>` per frame. Apply is idempotent by `seq`, closing both the missed-event and duplicate-event races. In-process buffering only (no Redis); a server restart aborts the in-flight turn (accepted loss boundary, per ADR-0262).

## Consequences

### Positive

- Any client (sender, other window, refreshed tab) attaches and is immediately correct, including resuming an in-flight turn.
- Collapses DOR-73's Path A pull + Path B re-emit into one snapshot+replay mechanism.
- Self-hosted-appropriate: no external infrastructure.

### Negative

- Decoupling turn execution from the POST is a substantial server refactor; migration must avoid double-delivery (POST + stream).
- In-flight turns are lost on server restart (notably on `pnpm dev` hot reload).
- RingBuffer sizing/TTL must be tuned to cover hard-refresh races without unbounded memory.
