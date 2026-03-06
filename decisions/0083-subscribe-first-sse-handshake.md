---
number: 83
title: Subscribe-First SSE Handshake for Relay Delivery
status: proposed
created: 2026-03-06
spec: fix-relay-sse-delivery-pipeline
superseded-by: null
---

# 83. Subscribe-First SSE Handshake for Relay Delivery

## Status

Proposed

## Context

When Relay transport is enabled, the client sends POST /messages (which returns 202 immediately) and expects response chunks via SSE relay_message events. However, the EventSource SSE connection may not be fully established when the POST fires — events published to `relay.human.console.{clientId}` with no active subscriber are silently lost. This race condition causes ~40-50% of messages to freeze.

## Decision

Add a `stream_ready` SSE event that the server sends after `subscribeToRelay()` completes in SessionBroadcaster. The client waits for this event (with a 5-second timeout) before sending the POST on the Relay path. This follows the subscribe-first pattern used by MCP Streamable HTTP, ensuring the delivery channel is confirmed ready before triggering message production.

## Consequences

### Positive

- Eliminates the primary timing race (responsible for ~90% of message drops per research)
- Simple protocol addition — one new SSE event type, no breaking changes
- Timeout fallback ensures the client is never permanently blocked

### Negative

- Adds up to 50ms latency on first message (EventSource establishment time)
- Client must track `stream_ready` state via ref, adding minor complexity to the hook
