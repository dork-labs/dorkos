---
number: 26
title: Use Receipt+SSE Protocol for Console-via-Relay
status: proposed
created: 2026-02-25
spec: relay-convergence
superseded-by: null
---

# 0026. Use Receipt+SSE Protocol for Console-via-Relay

## Status

Proposed (auto-extracted from spec: relay-convergence)

## Context

The current Console chat protocol streams SSE responses on the POST request itself — the client sends a message and reads the response as an SSE stream on the same HTTP connection. When migrating Console to flow through Relay, this protocol doesn't fit because Relay decouples send from receive. The message must be published to Relay, processed by a MessageReceiver, and responses routed back to the sender's endpoint asynchronously.

## Decision

POST /api/sessions/:id/messages returns an immediate 202 receipt with `{ messageId, traceId }` when Relay is enabled. Response chunks arrive on the existing SSE EventSource connection (`GET /api/sessions/:id/stream`) as typed `relay_message` events. The client's stream event handler is reused for both protocols — same event processing, different transport. When Relay is disabled, the existing SSE-on-POST protocol continues unchanged.

## Consequences

### Positive

- POST returns immediately — no hanging HTTP request during LLM inference
- Single EventSource carries both session sync and Relay events (fan-in)
- Consistent with how external adapters already communicate via Relay
- Client code reuses the same StreamEvent handler for both paths

### Negative

- Two code paths in both server (POST handler) and client (use-chat-session)
- Client must correlate receipt messageId with incoming relay_message events
- Slightly more complex error handling when POST succeeds but no events arrive
