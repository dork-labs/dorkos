---
id: 260811-184735
title: The session message queue is server-owned, durable, and visible to every window
status: accepted
created: 2026-08-11
spec: persistent-session-runtime
supersedes: 104
amends: 264
superseded-by: null
---

# 260811-184735. The session message queue is server-owned, durable, and visible to every window

## Status

Accepted — implemented by spec `persistent-session-runtime` phase P2 (PRs #935, #940, #944, #951, #947, #957).

**Supersedes ADR-0104** (Client-Side Message Queue with Auto-Flush) in full. Not because that design was wrong — it was the correct trade in March 2026, when a queue that needed no server change was the difference between shipping and not — but because every one of its own listed negatives is a property of living in a tab, and the product now needs the opposite property.

**Amends ADR-0264.** The clause retired is the shape of its 202: "responds `202 { sessionId }` without streaming tokens". The POST stays trigger-only and delivery stays exclusively `GET /:id/events`; what changes is that the 202 now also says what happened to the message (`messageId`, `outcome`, `queuePosition`), because a message the server accepted is no longer necessarily a turn that started. ADR-0264's Context anticipated exactly this — it decoupled the turn from the request but left "what happens to the second message" unanswered — and this ADR names the thing that sits in that gap. Everything else in ADR-0264 still governs unchanged: the projector, the event log and ring buffer, snapshot → gap-free replay → live, the epoch-qualified cursor, and the turn-bound write lock.

## Context

The queue holding what a person typed while an agent was working lived in the browser (ADR-0104): ephemeral React state in one tab. It was lost on refresh, invisible to a second window, and unknown to the server, so a message somebody had been told was accepted could still evaporate. Coordination between clients was therefore not coordination at all but a refusal — a second window posting to a busy session got `409 SESSION_LOCKED`, an error where the honest answer was "it will run next". DOR-1088 later serialized turns per session and removed the double-turn corruption, but its chain was in-memory, per client, invisible to other windows, and held an HTTP socket open for every waiting message: the right shape for a correctness fix, the wrong shape for a feature people rely on.

## Decision

**The server owns the queue.** A message accepted while a session is busy is the server's responsibility from that moment on.

- **Persisted.** Rows in SQLite (`session_message_queue`), keyed by canonical session id and rekeyed alongside the projector when a new session gains its real id. Ordering is a sparse integer, so a reorder updates one row instead of rewriting the queue. Persistence is deliberate divergence from ADR-0264, which accepts losing an in-flight turn on restart: losing a turn is a mechanism failing, losing a person's typed words after telling them the words were accepted is a promise broken.
- **Visible wherever session state is.** `SessionSnapshot.queuedMessages` on a cold connect; a `queue_update` event on the durable stream on every mutation, carrying the **whole** queue rather than a diff, so a client that missed one update is corrected by the next. `GET /api/sessions/:id/queue` exists as well, redundant with the snapshot on purpose, for integrations and debugging.
- **Mutable from any window.** Any client may reword, move, or remove any message on the queue through `PATCH`/`DELETE /api/sessions/:id/queue/:messageId`. `enqueuedBy` exists so a window can _say_ which entries are its own, never so the server can refuse another window's.
- **Dispatched at turn boundaries by one dispatcher.** `services/session/message-dispatcher.ts` is the single ingress for every caller that can start a turn. It dequeues on `turn_end` and never on a bare `result`, and never while the projector reports a pending interaction. A caller that bypasses it keeps the old race, so P2 audited that none does.
- **The POST accepts instead of refusing.** `409 SESSION_LOCKED` is retired from `POST /:id/messages`. The write lock survives, retargeted: it is the mutex one turn window holds, and its inactivity TTL still reclaims a turn that went dark (DOR-782). It is simply no longer an answer that route can give.
- **Native runtime queueing stays an adapter-level optimization, never the contract.** A runtime that can queue or steer natively may do so behind the capability ladder, and the receipt (`MessageDeliveryOutcome`) reports what was requested versus what was applied. Every runtime declares those flags `false` today, so `steer` and `stage` resolve to `queue` with `degradedBecause: 'unsupported'`. The server-owned queue is what every runtime gets for free; nothing about the contract depends on a runtime having its own.

## Consequences

### Positive

- A queued message survives a refresh, a second window, a crashed turn, and a server restart — the four ways ADR-0104's queue could lose somebody's words.
- Two windows on one session finally agree. The whole queue on every update means ordering and duplication bugs are unrepresentable in the wire format, not merely avoided.
- The refusal is gone from the message path. A busy session is a queue, not a `409`, which removes the only case where DorkOS answered a person's message with an error that was not about their message.
- One dispatcher owns "may this run now", so the pending-interaction and `result`-versus-`turn_end` traps are handled once rather than by each of the eight callers that can start a turn.
- The queue is inspectable by anything that speaks HTTP, which makes a stuck session diagnosable without a browser.

### Negative

- A persisted queue is a schema migration and a standing sweep obligation. Rows outlive the process, so a session that is deleted or evicted must take its rows with it (`deleteForSessions`, called from session teardown) or an abandoned session holds storage for the life of the install.
- **`202` now means accepted, not running.** This is a real semantic change for any integrator that treated the 202 as "the turn has begun" and polled or timed from it. The body says which it was (`queuePosition` is 1 when nothing was ahead), but code written against the old meaning is wrong without failing loudly.
- Two windows can race an edit of the same queued message. Both the stream event and the `PATCH` response carry the whole queue, so the outcome is last-write-wins by whole-queue replacement: the losing window is corrected rather than merged, and one person's in-flight edit can be overwritten by another's.
- Rapid-fire sends can transpose. Two messages sent in quick succession from the same window can be accepted out of the order they were typed, because acceptance is a round trip and nothing serializes two in-flight POSTs (DOR-1165, known and filed).
- The client keeps a queue-shaped surface anyway — an optimistic chip while acceptance is in flight — so the browser is not free of queue state, only of queue ownership. That optimistic path is its own class of bug (a double-Enter could line one message up twice, fixed during P2).
- Ordering by sparse position defers cost rather than removing it: when repeated moves close the gap between two positions, the store respaces the session's whole queue. Bounded by one queue, but it is a rewrite that a naive array index would not have.
