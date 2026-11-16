# SSE Connection Optimization Phase 2 — Task Breakdown

**Spec:** `specs/sse-connection-optimization-02-fetch-transport/02-specification.md`
**Generated:** 2026-03-27
**Mode:** Full decomposition

---

## Phase 1: Parser Extensions

### Task 1.1 — Extend `parseSSEStream` to full SSE spec compliance

**Size:** Medium | **Priority:** High | **Dependencies:** None

**Files:**

- `apps/client/src/layers/shared/lib/transport/sse-parser.ts` (modify)
- `apps/client/src/layers/shared/lib/transport/__tests__/sse-parser.test.ts` (create)

**Summary:** Rewrite `parseSSEStream` from its current simplified line-by-line approach (handles only `event:` and `data:`) to a spec-compliant field accumulation algorithm supporting:

- `id:` field — stored and yielded as `event.id`, persists across events per SSE spec
- `retry:` field — parsed as integer ms, yielded as `event.retry`
- Comment lines (`:` prefix) — yielded as `{ type: 'comment', data: text, comment: true }`
- Multi-line `data:` — accumulated in array, joined with `\n` before JSON parse
- Empty line dispatch — spec-compliant event dispatch on blank line
- Colon-space optional — `data:value` and `data: value` both valid
- NULL byte rejection in `id:` values
- Stream-end flush for pending events

**Tests (12 cases):**

1. Yields `id` field from SSE stream
2. `id` persists across events until changed
3. `id` with NULL byte is ignored
4. Yields `retry` field as integer ms
5. Ignores non-numeric retry values
6. Yields comment lines with `comment: true`
7. Concatenates multi-line data with newline
8. Dispatches on empty line (spec-compliant)
9. Handles field with no space after colon
10. Existing sendMessage streaming regression test
11. Flushes pending event on stream end
12. Skips malformed lines without colon

---

## Phase 2: SSEConnection Refactor

### Task 2.1 — Replace EventSource with fetch + ReadableStream in SSEConnection

**Size:** Large | **Priority:** High | **Dependencies:** 1.1

**Files:**

- `apps/client/src/layers/shared/lib/transport/sse-connection.ts` (modify)

**Summary:** Complete refactor of `SSEConnection` internals:

| Change                   | Detail                                                            |
| ------------------------ | ----------------------------------------------------------------- |
| `EventSource` removed    | Replaced with `fetch()` + `ReadableStream` + `AbortController`    |
| `onError` type           | `Event` → `Error` (includes HTTP status info)                     |
| `headers` option         | New option, flows to `fetch()` headers                            |
| `lastEventId` tracking   | Memory-only, sent as `Last-Event-ID` header on reconnect          |
| `serverRetryMs` tracking | Consumed from parser `retry:` events, used as backoff floor       |
| Comment handling         | Watchdog reset without handler dispatch                           |
| `closeEventSource()`     | Renamed to `closeConnection()`, calls `controller.abort()`        |
| Visibility optimization  | `abortController.signal.aborted` replaces `readyState === CLOSED` |

Public API is identical. No consumer changes required.

---

### Task 2.2 — Rewrite SSEConnection test suite for fetch-based mock strategy

**Size:** Large | **Priority:** High | **Dependencies:** 2.1

**Files:**

- `apps/client/src/layers/shared/lib/transport/__tests__/sse-connection.test.ts` (rewrite)

**Summary:** Replace `MockEventSource` class with `createMockSSEStream()` helper using `TransformStream` + `vi.stubGlobal('fetch', ...)`. Migrate all 25+ existing behavioral tests to async patterns. Add 9 new tests:

1. Sends custom headers in fetch request
2. Sends `Last-Event-ID` header on reconnect
3. Honors server `retry:` as backoff floor
4. Resets watchdog on comment lines
5. Handles HTTP error responses (4xx/5xx)
6. Handles fetch network error (`TypeError: Failed to fetch`)
7. Aborts fetch on `disconnect()`
8. Aborts fetch on visibility hide after grace period
9. Creates new `AbortController` on each `connect()`

**Key mock pattern change:**

```
OLD: conn.connect(); MockEventSource.latest().simulateOpen();
NEW: conn.connect(); await vi.advanceTimersToNextTimerAsync();
```

---

## Phase 3: Refetch-on-Reconnect

### Task 3.1 — Wire refetch-on-reconnect cache invalidation in event-stream-context

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1 | **Parallel with:** 4.1

**Files:**

- `apps/client/src/layers/shared/lib/query-client.ts` (create — extract from main.tsx)
- `apps/client/src/main.tsx` (modify — import queryClient from shared)
- `apps/client/src/layers/shared/model/event-stream-context.tsx` (modify)
- `apps/client/src/layers/shared/model/__tests__/event-stream-context.test.tsx` (modify)

**Summary:** When `SSEConnection` transitions from `reconnecting` -> `connected`, invalidate all TanStack Query caches via `queryClient.invalidateQueries()`. This eliminates stale data from disconnect windows.

**Approach:**

1. Extract `queryClient` to `shared/lib/query-client.ts` to avoid circular imports
2. Add `previousConnectionState` module-level tracking with HMR preservation
3. Lazy `import()` of query-client in `onStateChange` callback
4. Only triggers on `reconnecting` -> `connected` (not initial connection)

**Tests (3 cases):**

1. Invalidates queries on `reconnecting` -> `connected` transition
2. Does NOT invalidate on initial `connecting` -> `connected`
3. Does NOT invalidate on `connected` -> `connected` (no-op)

---

## Phase 4: HTTP/2 Verification

### Task 4.1 — Add Caddy reverse proxy configuration for HTTP/2 verification

**Size:** Small | **Priority:** Low | **Dependencies:** 2.1 | **Parallel with:** 3.1

**Files:**

- `docker-compose.caddy.yml` (create at repo root)
- `Caddyfile.dev` (create at repo root)

**Summary:** Optional Caddy reverse proxy config for verifying HTTP/2 multiplexing with fetch-based SSE. Caddy terminates TLS (self-signed) and proxies to the Express dev server on port 6242. Includes `flush_interval -1` for SSE streaming. Not required for normal development or CI.

**Verification procedure** (documented in compose file comments):

1. `pnpm dev` — start Express + Vite
2. `docker compose -f docker-compose.caddy.yml up` — start Caddy
3. Open `https://localhost` in Chrome
4. DevTools Network tab → enable Protocol + Connection ID columns
5. Verify SSE streams show `h2` and share one Connection ID

---

## Dependency Graph

```
1.1 (parseSSEStream)
 └─→ 2.1 (SSEConnection refactor)
      ├─→ 2.2 (SSEConnection tests)
      ├─→ 3.1 (refetch-on-reconnect)  ←── can parallel with 4.1
      └─→ 4.1 (Caddy HTTP/2)          ←── can parallel with 3.1
```

## Size Summary

| Task | Size   | Est. Lines Changed                         |
| ---- | ------ | ------------------------------------------ |
| 1.1  | Medium | ~170 (parser rewrite + new test file)      |
| 2.1  | Large  | ~200 (full class refactor)                 |
| 2.2  | Large  | ~400 (test rewrite + 9 new tests)          |
| 3.1  | Medium | ~80 (new module + context changes + tests) |
| 4.1  | Small  | ~25 (two config files)                     |
