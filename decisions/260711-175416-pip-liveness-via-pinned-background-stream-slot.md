---
id: 260711-175416
title: PIP liveness via a pinned background session-stream slot, not a per-session connection pool
status: accepted
created: 2026-07-11
spec: gen-ui-pip
superseded-by: null
---

# 260711-175416. PIP liveness via a pinned background session-stream slot, not a per-session connection pool

## Status

Accepted

## Context

A PIP'd gen-UI widget must stay live when the operator opens a different session, but `StreamManager` deliberately owns exactly one active-session durable stream and re-targets it on every session switch — the off-route session's projection freezes the moment its connection closes. Alternatives considered: accept staleness (fails the explicit ask), or generalize to a per-session connection pool (unbounded resource growth for a single-instance panel).

## Decision

We will add one **pinned slot** to `StreamManager`: `pinSession`/`unpinSession` guarantee a durable connection for at most one pinned session. When the pinned and attached sessions coincide they share the single active connection (one owner per connection, `pinnedConnection` null); when they diverge, the connection is transferred between slots as pure bookkeeping — never closed and reopened — so re-targeting is gap-free. The stream store's LRU eviction skips the pinned session. The connection ceiling grows from two (list + active) to three (list + active + pinned).

## Consequences

### Positive

- A PIP'd session stays live across route changes and session switches, with zero server changes (each per-session SSE connection is independent and replay-durable).
- Bounded resources: at most one extra connection, only while the panel shows a foreign session.
- Slot transfer preserves the connection object, so no replay gap or reconnect flicker on switches.
- Degrades naturally into a pool later: the pinned slot is the N=1 case.

### Negative

- The attach/pin transition matrix (share, diverge, adopt, re-pin, rebuild) is real state-machine surface that must be exhaustively unit-tested.
- A second panel instance or multi-pin future requires promoting the slot to a keyed map.
