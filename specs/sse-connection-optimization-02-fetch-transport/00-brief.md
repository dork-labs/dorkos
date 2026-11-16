---
slug: sse-connection-optimization-02-fetch-transport
number: 188
created: 2026-03-27
status: brief
project: sse-connection-optimization
phase: 2
---

# Phase 2: Fetch-Based SSE Transport

**Project:** SSE Connection Optimization
**Phase:** 2 of 2
**Depends on:** Phase 1 (consolidated SSE endpoint exists at `/api/events`)
**Enables:** Future HTTP/2 adoption (fetch uses HTTP/2 when available, unlike EventSource which is HTTP/1.1-only)

---

## Problem

After Phase 1, the client still uses `EventSource` for SSE connections. The `EventSource` browser API is fundamentally limited to HTTP/1.1 — it cannot use HTTP/2 multiplexing even when the server supports it. This means each `EventSource` still consumes a dedicated TCP connection from the browser's per-origin pool.

While Phase 1 reduces connections from 4-5 to 2 (which resolves the immediate tool approval bug), the remaining `EventSource` connections still cannot benefit from HTTP/2 if/when a reverse proxy (e.g., Caddy) is placed in front of Express. Additionally, `EventSource` has inherent limitations:

- Cannot send custom headers (no `Authorization`, no `X-Client-Id`)
- Cannot use POST (GET-only)
- No control over retry behavior (browser auto-reconnects with a fixed strategy)
- Limited error information on failure

The `SSEConnection` class already reimplements reconnection, heartbeat watchdog, and visibility optimization on top of `EventSource` — the browser's built-in features are largely bypassed anyway.

## Scope

Replace `EventSource` with `fetch()` + `ReadableStream` for all SSE connections. The `sendMessage` flow already uses this pattern (`parseSSEStream` in `sse-parser.ts`), so the approach is proven in the codebase.

**In scope:**

- Refactor `SSEConnection` class to use `fetch()` with `ReadableStream` instead of `EventSource`
- Reuse the existing `parseSSEStream` utility from `sse-parser.ts` for SSE parsing
- Maintain all existing resilience features (exponential backoff, heartbeat watchdog, visibility optimization)
- Add custom header support (e.g., `X-Client-Id` for session tracking)
- Ensure the unified stream from Phase 1 and the session sync stream both use the new transport
- Verify HTTP/2 multiplexing works when a reverse proxy is present (Caddy test)

**Out of scope:**

- Adding HTTP/2 to the Express server directly (Express doesn't support it; use Caddy)
- WebSocket or WebTransport migration
- Changes to the server-side SSE implementation (the server doesn't need to change — SSE is SSE regardless of client transport)

## Deliverables

### 1. Refactor `SSEConnection` to Use `fetch()`

**Problem:** `SSEConnection` wraps `EventSource`, which is HTTP/1.1-only and lacks custom header support.

**Solution:**

- Replace `new EventSource(url)` with `fetch(url)` + `response.body.getReader()`
- Parse the SSE stream using the existing `parseSSEStream` generator from `sse-parser.ts`
- Maintain the same public API (`connect()`, `disconnect()`, `destroy()`, `getState()`)
- Preserve all resilience behavior: exponential backoff with jitter, heartbeat watchdog, visibility optimization
- Add optional `headers` parameter to constructor for custom headers
- Handle connection errors and stream termination the same way `EventSource.onerror` does today

**Key source files:**

- `apps/client/src/layers/shared/lib/transport/sse-connection.ts` — The class to refactor
- `apps/client/src/layers/shared/lib/transport/sse-parser.ts` — `parseSSEStream` generator (already handles SSE parsing for `sendMessage`)
- `apps/client/src/layers/shared/lib/constants.ts` — `SSE_RESILIENCE` timing constants

### 2. Verify `parseSSEStream` Compatibility

**Problem:** `parseSSEStream` was built for the `sendMessage` streaming flow. It may need adjustments for persistent streams (which don't end with a response completion).

**Solution:**

- Audit `parseSSEStream` for assumptions about stream termination
- Ensure it handles infinite streams (persistent SSE) as well as bounded streams (message response)
- Add named event support if not already present (`event:` field in SSE spec — `EventSource` handles this natively, `parseSSEStream` may not)
- Write tests for edge cases: reconnection mid-stream, server-sent `retry:` field, multi-line `data:` fields

**Key source files:**

- `apps/client/src/layers/shared/lib/transport/sse-parser.ts`
- `apps/client/src/layers/shared/lib/transport/__tests__/` — Existing SSE tests

### 3. HTTP/2 Verification

**Problem:** The whole point of replacing `EventSource` with `fetch()` is to unlock HTTP/2 multiplexing. This needs to be verified end-to-end.

**Solution:**

- Create a minimal Caddy config that reverse-proxies to Express with HTTP/2
- Verify that two concurrent `fetch()`-based SSE streams multiplex over a single TCP connection
- Document the Caddy configuration for production use
- Measure connection count before and after (Chrome DevTools → Network → Connection ID column)

## Key Decisions (Settled)

1. **Refactor, not replace** — `SSEConnection` keeps its public API. Consumers don't need to change. The transport layer underneath switches from `EventSource` to `fetch()`.
2. **Reuse `parseSSEStream`** — The existing SSE parser is proven. Extend it if needed rather than writing a new one.
3. **No `eventsource-parser` dependency** — We already have a working SSE parser. Adding a dependency for the same functionality adds bundle size with no benefit. If `parseSSEStream` needs named event support, add it directly.
4. **Caddy for HTTP/2** — Don't try to add HTTP/2 to Express. Use Caddy as a reverse proxy. It's zero-config, auto-TLS, and the industry standard for this pattern.

## Open Questions (For /ideate)

1. **AbortController lifecycle** — `fetch()` requires explicit `AbortController` management for cancellation. How should this integrate with `disconnect()` and `destroy()`? What about page visibility (abort on hide, reconnect on show)?
2. **Retry behavior** — `EventSource` has a built-in `retry:` directive from the server. Should the fetch-based implementation honor SSE `retry:` fields, or stick with the existing `SSEConnection` backoff logic?
3. **Last-Event-ID** — `EventSource` automatically sends `Last-Event-ID` on reconnect. Should the fetch-based implementation replicate this? The current server-side SSE doesn't use event IDs, but it could be useful for relay message delivery guarantees.
4. **Bundle impact** — Does removing `EventSource` and using `fetch()` affect bundle size? `EventSource` is a browser API (zero bundle cost). `fetch()` is also a browser API, but the SSE parser adds code. Likely negligible but worth measuring.
5. **Caddy in dev vs prod** — Should Caddy be part of the dev workflow (`pnpm dev` spins up Caddy), or only recommended for production? Adding it to dev increases setup complexity.

## Reference Material

### Existing implementation

- `apps/client/src/layers/shared/lib/transport/sse-parser.ts` — Proven SSE parser for fetch streams
- `apps/client/src/layers/shared/lib/transport/sse-connection.ts` — Full resilience class to refactor
- `apps/client/src/layers/shared/lib/transport/http-transport.ts` — `sendMessage` uses fetch + parseSSEStream (lines 291-318)

### Existing specs

- `specs/sse-connection-optimization-01-consolidate/` (spec #187) — Phase 1 prerequisite
- `specs/sse-resilience-connection-health/` (spec #174) — SSE resilience infrastructure

### External references

- [`eventsource-parser`](https://github.com/rexxars/eventsource-parser) — Reference implementation of SSE parsing for fetch streams (used by Vercel AI SDK). Design reference, not a dependency.
- [Caddy](https://caddyserver.com/) — Reverse proxy for HTTP/2 termination

## Acceptance Criteria

- [ ] `SSEConnection` uses `fetch()` + `ReadableStream` instead of `EventSource`
- [ ] `SSEConnection` public API is unchanged — no consumer changes required
- [ ] Custom headers can be passed to `SSEConnection` constructor
- [ ] All existing `SSEConnection` tests pass without modification (behavior-level tests)
- [ ] `parseSSEStream` handles persistent (infinite) streams and named events
- [ ] Reconnection with exponential backoff works correctly with fetch-based transport
- [ ] Heartbeat watchdog detects stale connections and triggers reconnection
- [ ] Page visibility optimization works (disconnect on hide, reconnect on show)
- [ ] HTTP/2 multiplexing verified with Caddy reverse proxy (two streams share one TCP connection)
- [ ] Caddy configuration documented for production deployment
- [ ] No behavioral regression in tunnel sync, extension hot-reload, relay events, or session sync
