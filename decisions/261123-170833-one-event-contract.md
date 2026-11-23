---
id: 261123-170833
title: One event contract, a DorkOsEvent envelope and type union with seq and replay on every stateful stream; duplicate streams removed
status: accepted
created: 2026-11-23
spec: null
superseded-by: null
amends: [0204]
---

# 261123-170833. One event contract, a DorkOsEvent envelope and type union with seq and replay on every stateful stream; duplicate streams removed

## Status

Accepted (Dorian, 2026-11-21 and 2026-11-23; draft D of [`research/20261121_rest-api-review.md`](../research/20261121_rest-api-review.md) §6, with "deprecated" replaced by "removed" under ADR 261123-170832). Feeds DOR-4986 and DOR-4973.

**Amends** [0204](0204-consolidate-sse-connections-into-unified-stream.md), which stays Accepted: the streams it consolidated into `/api/events` are removed rather than "deprecated carefully" (retired by ADR 261123-170832). Its single global stream stands and gains the shared envelope and replay.

## Context

Most of the app's state arrives over event streams. Each stream defines its own envelope and event names in `packages/shared` (`session-stream.ts`, the global event names), and none is one union a client generator can read. The chat stream and the room stream have `seq` and `Last-Event-ID` replay, each in its own envelope; the global stream `GET /api/events` has neither. `GET /api/events` and the tunnel stream are served but not declared as streams in the OpenAPI document. Three streams (`/api/relay/stream`, `/api/extensions/events`, `/api/tunnel/stream`) overlap `/api/events`, are called deprecated in prose and are still served. The relay stream is not a strict duplicate: it accepts `relay.system.*`, `relay.signal.*` and `relay.human.console.*` subjects, while `/api/events` carries only `relay.human.console.>`. Seventeen operations answer `202` and nothing says which event reports the outcome.

## Decision

We will define one `DorkOsEvent` envelope, `{ seq, at, type, payload }`, and one event-type union in `packages/shared` that every stream shares.

Every stream that carries state gets a monotonic `seq` and `Last-Event-ID` replay from a bounded buffer. The chat and room streams already replay; they move onto the shared envelope. The global stream gains replay.

Every served stream is declared in the OpenAPI document as a `text/event-stream` response whose schema is the union. The human page, `docs/integrations/sse-protocol.mdx`, lists event names from the same union.

Streams that duplicate `/api/events` are **removed**, not deprecated, in the change that moves every caller onto `/api/events`. Before the relay stream is removed, `/api/events` carries the relay system and signal subjects too, so nothing a caller reads today is lost.

Every `202` answer names the event (its `type`, on `/api/events` or the chat stream) that reports the outcome, with an id to correlate it.

## Consequences

### Positive

- A generated client gets typed events, and one parser handles every stream.
- A client that drops its connection can resume on any stateful stream, not only a chat.
- Fewer streams to serve, test and document.
- A caller of a `202` knows exactly what to wait for.

### Negative

- Adding replay to the global stream and moving the chat and room streams onto the shared envelope is real work, and the buffers cost memory per stream.
- One union across every stream grows large and every new event type edits a shared file.
- Integrations outside the repo that read the removed streams break on that release; the changelog fragment is their warning (ADR 261123-170832).
- The space server's streams keep their frozen shape; they change only through D6's deliberate path, agreed with Cloud first.
