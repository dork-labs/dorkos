---
number: 264
title: Server-Owned Durable, Resumable Per-Session Stream (Turn Decoupled from POST)
status: proposed
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 264. Server-Owned Durable, Resumable Per-Session Stream (Turn Decoupled from POST)

## Status

Proposed — 2026-06-11 (implemented by spec: chat-stream-reconnection; updated post-implementation to record the decision as built)

## Context

Live token streaming was bound to the lifecycle of the `POST /api/sessions/:id/messages` request, so a hard refresh or second window mid-turn had nothing to reattach to. The only reconnection stream (`GET /:id/stream`) was gated behind an off-by-default toggle and carried only `sync_update`/pending re-emits — not the in-flight turn. There was no gap-free way to hydrate current state and continue streaming. This generalizes the DOR-73 / ADR-0262 pending-interaction recovery to all event classes.

## Decision

The persistent DorkOS server is the durable mediator; delivery is **exclusively** `GET /api/sessions/:id/events`.

**Trigger-only POST.** `POST /:id/messages` starts a detached turn and responds `202 { sessionId }` without streaming tokens (`apps/server/src/services/session/trigger-turn.ts`). The body's session id is the **best-effort canonical id**: `triggerTurn` taps the runtime's event stream, resolves the 202 via `Promise.race([firstEvent, delay(CANONICAL_ID_TIMEOUT_MS)])` (5s bound), and retries the projector rekey on every yielded event until the canonical id appears — if it has not resolved by then, the request id is returned and converges later via the retire announce (ADR-0265/0267). The session write-lock is bound to the turn's real duration (a `DetachedTurnLifecycle`, not the short-lived POST), and a detached failure is surfaced INTO the stream (`guardTurnErrors` → `status_change {lifecycle: 'error'}` + `turn_end {terminalReason: 'error'}`) since the client can no longer learn of it from the POST.

**Projector + buffers.** A per-session `SessionStateProjector` (`session-state-projector.ts`) consumes the normalized turn stream, assigns the monotonic `seq`, maintains the live projection (status, in-progress turn, pending interactions), and appends every event to an `EventLog` (trimmed at 5000 events — completed-turn history for log-backed runtimes plus deep-replay overflow) and a `RingBuffer` (current turn, 200-event cap, 10-minute TTL after `turn_end` to absorb the refresh-just-after-completion race).

**Snapshot → gap-free replay → live.** `GET /:id/events` (`apps/server/src/routes/session-events-handler.ts`) is always on. A cold connect emits the `SessionSnapshot` (messages, in-progress turn, status, pending interactions, `cursor`) then goes live from `snapshot.cursor`. A reconnect presents `Last-Event-ID` (or `?after=`); every frame's id is `<sessionId>-<epoch>-<seq>` where `STREAM_EPOCH` identifies this server process's seq space — per-session counters restart at 0 with the process, so a cursor minted by a previous process must not integer-compare against the new space. A mismatched epoch falls through to a cold connect. `subscribeSession` validates the cursor **eagerly** and throws `StaleResumeCursorError` (cursor ahead of the counter, or below the trimmed replay floor); the route catches it and falls back to the cold snapshot path — silently resuming would leave the client permanently deaf. Client apply is idempotent by `seq` (`applyEvent` no-ops at or below the watermark), closing both the missed-event and duplicate-event races. The route deliberately does NOT 404 unknown ids: a brand-new client UUID must be subscribable before its first message (subscribe-first hydration), and on-disk sessions exist that the in-memory store has not seen.

In-process buffering only (no Redis). A server restart aborts the in-flight turn (accepted loss boundary, per ADR-0262); the restart-degradation path marks a turn left `streaming` as `interrupted` so a cold hydrate shows it was cut short.

## Consequences

### Positive

- Any client (sender, other window, refreshed tab) attaches and is immediately correct, including resuming an in-flight turn; the seq watermark makes dual observation harmless.
- Collapses DOR-73's Path A pull + Path B re-emit into one snapshot+replay mechanism (see ADR-0262 amendment).
- Self-hosted-appropriate: no external infrastructure; eviction is lazy/bounded (ring cap + TTL, log trim, self-disposing empty projectors).

### Negative

- Decoupling turn execution from the POST was a substantial refactor with real subtleties now owned by `trigger-turn.ts`: lock lifetime, detached error surfacing, and the canonical-id race (the 202's id is only best-effort).
- In-flight turns are lost on server restart (notably on `pnpm dev` hot reload); the epoch check converts that into a clean cold reconnect rather than silent deafness, but the turn itself is gone.
- Buffer sizing is policy: a client further behind than the ring/log retention falls back to a full snapshot rather than gap-replay; `EventLog` depth also bounds log-backed history (ADR-0263).
