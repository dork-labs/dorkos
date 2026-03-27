---
number: 117
title: Use Direct SSE as Sole Web Client Transport
status: accepted
created: 2026-03-12
spec: client-direct-sse
superseded-by: null
---

# 0117. Use Direct SSE as Sole Web Client Transport

## Status

Accepted

## Context

The DorkOS web client had two code paths for sending messages: direct SSE (POST streams response inline) and relay (POST returns 202, response arrives via persistent EventSource through the relay bus). The relay path was added for external adapters (Telegram, webhooks) but was generalized to the web client despite it having a direct HTTP connection. Every streaming bug in the codebase was relay-specific — five separate bug-fix specs addressed relay-only failure modes (delivery pipeline, ghost messages, streaming bugs, backpressure, history gaps). The direct SSE path was stable throughout.

## Decision

The web client always uses direct SSE for message sending and streaming responses, regardless of whether the relay feature is enabled. The relay message path is removed from the client chat hook and the server-side code that served only the web client (relay fan-in in SessionBroadcaster, `publishViaRelay()`, relay 202 POST path, `stream_ready` handshake). Relay infrastructure stays intact for external adapters and agent-to-agent communication. The `sendMessageRelay()` method remains on the Transport interface for backward compatibility but is no longer called from the web client.

## Consequences

### Positive

- Eliminates an entire category of streaming bugs (relay-specific failure modes)
- Simplifies the codebase by ~350 lines of removed code plus ~2000 lines of deleted relay-only tests
- One code path to reason about for client messaging
- Removes the `stream_ready` handshake delay (up to 5 seconds of polling)
- Removes staleness timer, correlation ID tracking, and relay EventSource overhead

### Negative

- If relay message routing is ever needed for the web client in the future, it would need to be re-implemented
- The relay infrastructure becomes less "exercised" since the web client no longer uses it (external adapters still do)
