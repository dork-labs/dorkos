---
id: 261123-170833
title: One event contract, a DorkOsEvent envelope and type union with seq and replay on every stateful stream; duplicate streams removed
status: accepted
created: 2026-11-23
spec: null
superseded-by: null
---

# 261123-170833. One event contract, a DorkOsEvent envelope and type union with seq and replay on every stateful stream; duplicate streams removed

## Status

Accepted (Dorian, 2026-11-21 and 2026-11-23; draft D of [`research/20261121_rest-api-review.md`](../research/20261121_rest-api-review.md) §6, with "deprecated" replaced by "removed" under ADR 261123-170832). Feeds DOR-4986 and DOR-4973.

## Context

Most of the app's state arrives over event streams. Each stream defines its own envelope and event names in `packages/shared` (`session-stream.ts`, the global event names), and none is one union a client generator can read. Only the per-chat stream has `seq` and `Last-Event-ID` replay. `GET /api/events` and the tunnel stream are served but not declared as streams in the OpenAPI document. Three streams (`/api/relay/stream`, `/api/extensions/events`, `/api/tunnel/stream`) duplicate `/api/events`, are called deprecated in prose and are still served. Seventeen operations answer `202` and nothing says which event reports the outcome.

## Decision

We will define one `DorkOsEvent` envelope, `{ seq, at, type, payload }`, and one event-type union in `packages/shared` that every stream shares.

Every stream that carries state gets a monotonic `seq` and `Last-Event-ID` replay from a bounded buffer, as `GET /api/sessions/{id}/events` does today.

Every served stream is declared in the OpenAPI document as a `text/event-stream` response whose schema is the union. The human page, `docs/integrations/sse-protocol.mdx`, lists event names from the same union.

Streams that duplicate `/api/events` are **removed**, not deprecated, in the change that moves every caller onto `/api/events`.

Every `202` answer names the event (its `type`, on `/api/events` or the chat stream) that reports the outcome, with an id to correlate it.

## Consequences

### Positive

- A generated client gets typed events, and one parser handles every stream.
- A client that drops its connection can resume on any stateful stream, not only a chat.
- Fewer streams to serve, test and document.
- A caller of a `202` knows exactly what to wait for.

### Negative

- Moving the global stream and the room stream onto the shared envelope with replay buffers is real work, and the buffers cost memory per stream.
- One union across every stream grows large and every new event type edits a shared file.
- Integrations outside the repo that read the removed streams break on that release; the changelog fragment is their warning (ADR 261123-170832).
- The space server's streams keep their frozen shape until after the December 8 launch.
