---
slug: sse-connection-optimization-02-fetch-transport
number: 188
created: 2026-03-27
status: ideation
---

# Phase 2: Fetch-Based SSE Transport

**Slug:** sse-connection-optimization-02-fetch-transport
**Author:** Claude Code
**Date:** 2026-03-27
**Branch:** preflight/sse-connection-optimization-02-fetch-transport

---

## Source Brief

`specs/sse-connection-optimization-02-fetch-transport/00-brief.md` — detailed brief with problem statement, deliverables, key decisions, open questions, and acceptance criteria. All specific details preserved below.

---

## 1) Intent & Assumptions

- **Task brief:** Replace `EventSource` with `fetch()` + `ReadableStream` inside `SSEConnection`, preserving its public API. This unlocks custom headers, HTTP/2 multiplexing (when behind a reverse proxy), and better error handling — while removing the `EventSource` limitations that the class already works around. Additionally, add refetch-on-reconnect: when `SSEConnection` transitions from `reconnecting` → `connected`, invalidate relevant TanStack Query caches to eliminate stale data after any disconnect window.
- **Assumptions:**
  - Phase 1 (spec #187) is complete — unified `/api/events` endpoint exists and `SSEConnection` is the sole SSE primitive
  - `parseSSEStream` from `sse-parser.ts` is proven for fetch-based SSE (used in `sendMessage` and `scan` flows)
  - The server-side SSE implementation requires zero changes — SSE is SSE regardless of client transport
  - `SSEConnection` consumers only use the public API (`connect`, `disconnect`, `destroy`, `getState`, `enableVisibilityOptimization`)
- **Out of scope:**
  - Adding HTTP/2 to Express directly (use Caddy as reverse proxy)
  - WebSocket or WebTransport migration
  - Server-side changes (no event IDs, no replay buffer)
  - Adding Caddy to `pnpm dev` workflow

---

## 2) Pre-reading Log

- `apps/client/src/layers/shared/lib/transport/sse-connection.ts` (265 lines): Full `EventSource`-based resilience class — state machine (4 states), exponential backoff with full jitter, heartbeat watchdog (45s), page visibility optimization (30s grace), disconnected threshold (5 failures), stability window (10s reset). Public API: `connect()`, `disconnect()`, `destroy()`, `enableVisibilityOptimization()`, `getState()`, `getFailedAttempts()`, `getLastEventAt()`.
- `apps/client/src/layers/shared/lib/transport/sse-parser.ts` (54 lines): `async function* parseSSEStream<T>()` — handles named events (`event:` field), `data:` fields with JSON parsing, multi-chunk streaming with TextDecoder `stream: true`, infinite streams (while-true loop, break on reader done). **Gaps:** no `id:` field, no `retry:` field, no comment line pass-through (`: keepalive`), single `data:` line only (SSE spec allows multi-line).
- `apps/client/src/layers/shared/lib/transport/http-transport.ts` (596 lines): `sendMessage()` at lines 278–319 already uses `fetch() + parseSSEStream` pattern — the exact pattern we're adopting for `SSEConnection`. `scan()` at lines 500–521 uses same pattern.
- `apps/client/src/layers/shared/lib/transport/http-client.ts` (65 lines): Shows `AbortSignal.any()` pattern for combining timeout + caller signals. Established codebase precedent.
- `apps/client/src/layers/shared/model/use-sse-connection.ts` (113 lines): React hook wrapper. Uses `useRef` for handler stabilization, creates/destroys `SSEConnection` in `useEffect`. Only uses public API — no changes needed.
- `apps/client/src/layers/shared/model/event-stream-context.tsx` (243 lines): Singleton `SSEConnection` for unified `/api/events` stream. Module-level singleton handles HMR/StrictMode correctly. Calls `enableVisibilityOptimization()` on mount. Only uses public API — no changes needed.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Shows `AbortController` lifecycle pattern — create per operation, store in ref, abort on cancel.
- `apps/client/src/layers/shared/lib/constants.ts` (lines 44–61): `SSE_RESILIENCE` constants — `HEARTBEAT_TIMEOUT_MS: 45_000`, `BACKOFF_BASE_MS: 500`, `BACKOFF_CAP_MS: 30_000`, `VISIBILITY_GRACE_MS: 30_000`, `DISCONNECTED_THRESHOLD: 5`, `STABILITY_WINDOW_MS: 10_000`.
- `apps/client/src/layers/shared/lib/transport/__tests__/sse-connection.test.ts` (592 lines): Comprehensive behavior-level test suite. Mocks `EventSource` via `vi.stubGlobal`. Tests cover all resilience features. Will need mock strategy update (EventSource mock → fetch mock) but assertions should remain.
- `specs/sse-connection-optimization-01-consolidate/02-specification.md`: Phase 1 spec — established SSEConnection as unified primitive, created `/api/events` endpoint.
- `specs/sse-resilience-connection-health/02-specification.md`: Original SSE resilience spec — defined the state machine, backoff, heartbeat, visibility patterns.
- `research/20260324_sse_resilience_production_patterns.md`: Prior research on SSE resilience patterns.
- `research/20260327_sse_multiplexing_unified_stream.md`: Prior research on unified SSE stream architecture.
- `research/20260327_fetch_sse_transport_migration.md`: Research produced during this ideation — covers AbortController lifecycle, retry behavior, Last-Event-ID, bundle impact, Caddy strategy, approach comparison.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/shared/lib/transport/sse-connection.ts` — **Refactor target.** Replace `EventSource` internals with `fetch()` + `ReadableStream`.
- `apps/client/src/layers/shared/lib/transport/sse-parser.ts` — **Extend.** Add `id:` field, `retry:` field, and comment line pass-through. Grows from ~54 to ~120 lines.
- `apps/client/src/layers/shared/lib/transport/http-transport.ts` — **Reference pattern.** `sendMessage()` already uses `fetch + parseSSEStream`.
- `apps/client/src/layers/shared/lib/transport/http-client.ts` — **Reference pattern.** `AbortSignal.any()` for signal composition.
- `apps/client/src/layers/shared/lib/constants.ts` — `SSE_RESILIENCE` timing constants. No changes needed.

**Consumers:**

- `apps/client/src/layers/shared/model/event-stream-context.tsx` — Singleton for `/api/events`. Uses public API only. **Minor addition:** wire refetch-on-reconnect via `onStateChange` to invalidate TanStack Query caches on `reconnecting` → `connected` transition.
- `apps/client/src/layers/shared/model/use-sse-connection.ts` — Hook wrapper. Uses public API only. No changes needed.

**Shared Dependencies:**

- `@dorkos/shared/types` — `ConnectionState` type
- `@/layers/shared/lib/constants` — `SSE_RESILIENCE` timing

**Data Flow (After Refactor):**

1. **Unified stream:** `EventStreamProvider` → singleton `SSEConnection.connect()` → `fetch('/api/events')` → `parseSSEStream(reader)` → event handlers dispatched
2. **Session sync:** `useSSEConnection` hook → `SSEConnection.connect()` → `fetch('/api/sessions/:id/stream')` → `parseSSEStream(reader)` → sync handlers
3. **Message streaming (unchanged):** `HttpTransport.sendMessage()` → `fetch(POST)` → `parseSSEStream(reader)` → stream events

**Potential Blast Radius:**

- **Direct:** 2 files modified (`sse-connection.ts`, `sse-parser.ts`)
- **Consumer:** 1 file gets minor addition (`event-stream-context.tsx` — wire refetch-on-reconnect)
- **Tests:** 1 test file needs mock strategy update (`sse-connection.test.ts` — EventSource mock → fetch mock), 1 new test for refetch-on-reconnect behavior
- **Indirect:** 0 files (no EventSource usage elsewhere, public API unchanged)

---

## 4) Root Cause Analysis

Not applicable — this is a refactoring task, not a bug fix.

---

## 5) Research

Research report: `research/20260327_fetch_sse_transport_migration.md`

**Potential Solutions:**

**1. Approach A: Minimal Refactor (Recommended)**

- Description: Replace `EventSource` internals inside existing `SSEConnection` class. Public API stays identical. One `AbortController` per connection attempt.
- Pros:
  - Zero consumer changes — drop-in replacement
  - Unlocks custom headers (`X-Client-Id`, `Authorization`)
  - Enables HTTP/2 multiplexing when behind reverse proxy
  - Follows established `fetch + parseSSEStream` pattern from `sendMessage()`
  - Better error information (HTTP status codes, response headers)
- Cons:
  - Test mocks need updating (EventSource → fetch)
  - Slightly more code for AbortController lifecycle management
- Complexity: Low
- Maintenance: Low

**2. Approach B: FetchSSETransport Abstraction**

- Description: Create a new transport abstraction layer to allow swapping between EventSource, fetch, and future WebTransport.
- Pros: Clean abstraction for future transports
- Cons: Premature — WebTransport isn't production-ready until 2027+. Hexagonal pattern belongs at server boundary, not in client connection management.
- Complexity: Medium
- Maintenance: Medium

**3. Approach C: Extend parseSSEStream into Full SSE Client**

- Description: Make the async generator manage reconnection, state machine, and watchdog timers.
- Pros: Functional composition
- Cons: Wrong model — timers don't compose naturally with async generators. State machine (`connecting/connected/reconnecting/disconnected`) would need reconstruction above the generator with increased hook complexity.
- Complexity: High
- Maintenance: High

**Recommendation:** Approach A (Minimal Refactor). Same public API, swap internals, zero consumer changes. Follows the proven pattern already in the codebase.

---

## 6) Decisions

| #   | Decision                        | Choice                                                           | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Implementation approach         | Minimal Refactor (Approach A)                                    | Zero consumer changes, follows established `fetch + parseSSEStream` pattern, lowest complexity                                                                                                                                                                                                                                                                                                                                                 |
| 2   | AbortController lifecycle       | One controller per connection attempt                            | Create in `connect()`, abort wherever `es.close()` was called, never reuse. Matches codebase patterns in `use-chat-session.ts` and `http-client.ts`                                                                                                                                                                                                                                                                                            |
| 3   | SSE `retry:` field behavior     | Implement as floor — `max(clientBackoff, serverRetryMs)`         | Tiny code cost (~4 lines). Respects server pacing intent during load shedding while preserving jitter distribution. Requires extending `parseSSEStream` to parse `retry:` fields                                                                                                                                                                                                                                                               |
| 4   | Last-Event-ID tracking          | Implement now, memory-only                                       | Zero consumer impact, ~5 lines in `SSEConnection` + small `parseSSEStream` extension. Forward-compatible — avoids second migration when server adds event IDs. Memory-only storage (no localStorage — IDs are per-server-lifetime)                                                                                                                                                                                                             |
| 5   | Server-side event IDs           | Out of scope                                                     | Adding `id:` fields is trivial but meaningless without a replay buffer (ring buffer strategy, size policy, per-endpoint decisions). Separate spec. Client tracking is forward-compatible                                                                                                                                                                                                                                                       |
| 6   | Bundle impact                   | Zero new bytes                                                   | `parseSSEStream` already bundled. Swapping `EventSource` (browser API) for `fetch` (browser API). Parser grows ~54→~120 lines — negligible                                                                                                                                                                                                                                                                                                     |
| 7   | Caddy in dev workflow           | Out of `pnpm dev`, optional docker-compose                       | Fetch-based SSE works identically on HTTP/1.1. HTTP/2 is a deployment concern. Provide `docker-compose.caddy.yml` for on-demand verification                                                                                                                                                                                                                                                                                                   |
| 8   | `parseSSEStream` extensions     | Add `id:`, `retry:`, comment line pass-through                   | Comment lines (`: keepalive`) are operationally important — without them, server heartbeat comments won't reset the watchdog timer. Multi-line `data:` concatenation is also needed per SSE spec                                                                                                                                                                                                                                               |
| 9   | External dependencies           | None — no `eventsource-parser`                                   | Existing `parseSSEStream` is proven. Extend in-place rather than adding bundle weight for the same functionality                                                                                                                                                                                                                                                                                                                               |
| 10  | Visibility optimization mapping | `abort()` replaces `close()`                                     | Grace timer logic unchanged. `this.eventSource.readyState === EventSource.CLOSED` becomes `this.abortController?.signal.aborted`. `closeEventSource()` becomes `this.abortController?.abort()`                                                                                                                                                                                                                                                 |
| 11  | Refetch-on-reconnect            | Invalidate TanStack Query caches on `reconnecting` → `connected` | SSE events are cache invalidation signals — if any are missed during a disconnect window, the UI shows stale data. Invalidating queries on reconnect guarantees zero stale data after any disconnect, regardless of whether events were lost. ~10 lines in `event-stream-context.tsx` using the existing `onStateChange` callback + `queryClient.invalidateQueries()`. Simpler, more complete, and more reliable than server-side event replay |
