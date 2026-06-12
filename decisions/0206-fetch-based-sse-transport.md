---
number: 206
title: Use fetch() Instead of EventSource for SSE Connections
status: accepted
created: 2026-03-27
spec: sse-connection-optimization-02-fetch-transport
superseded-by: null
---

# 206. Use fetch() Instead of EventSource for SSE Connections

## Status

Accepted

## Context

`SSEConnection` wraps the browser `EventSource` API for persistent SSE streams. However, `EventSource` is fundamentally limited: it is HTTP/1.1-only (cannot use HTTP/2 multiplexing), cannot send custom headers (no `Authorization`, no `X-Client-Id`), is GET-only, provides opaque error events with no status codes, and has uncontrolled retry behavior. The `SSEConnection` class already reimplements reconnection, heartbeat watchdog, and visibility optimization — bypassing most of `EventSource`'s built-in features. Meanwhile, the `sendMessage()` flow in `HttpTransport` already uses `fetch()` + `ReadableStream` + `parseSSEStream` successfully for streaming SSE responses.

## Decision

Replace `EventSource` internals inside `SSEConnection` with `fetch()` + `ReadableStream` + `AbortController`, keeping the public API (`connect`, `disconnect`, `destroy`, `enableVisibilityOptimization`, `getState`) identical. One `AbortController` is created per connection attempt and aborted wherever `EventSource.close()` was previously called. The existing `parseSSEStream` async generator is extended to handle `id:`, `retry:`, comment lines, and multi-line `data:` per the SSE spec, and reused for the persistent stream parsing loop.

## Consequences

### Positive

- Unlocks HTTP/2 multiplexing when behind a reverse proxy (Caddy, nginx) — two SSE streams share one TCP connection instead of two from the browser's 6-per-origin pool
- Enables custom request headers (`X-Client-Id`, `Authorization`, `Last-Event-ID`)
- Provides richer error information (HTTP status codes, response headers) instead of opaque `EventSource` error events
- Unifies the SSE transport pattern — both `sendMessage()` (bounded streams) and `SSEConnection` (persistent streams) use `fetch` + `parseSSEStream`
- Zero consumer changes — public API is unchanged

### Negative

- Test mock strategy must change from `MockEventSource` to `MockFetch` + `TransformStream` — all 25+ existing tests need mock updates (though assertions remain)
- Slightly more code for `AbortController` lifecycle management compared to `EventSource.close()`
- `fetch()` does not auto-reconnect like `EventSource` — but `SSEConnection` already reimplements reconnection, so this is not a functional loss
