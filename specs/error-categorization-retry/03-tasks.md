# Error Categorization & Retry — Task Breakdown

**Spec:** `specs/error-categorization-retry/02-specification.md`
**Generated:** 2026-03-16
**Mode:** Full decomposition

---

## Phase 1: Foundation

### Task 1.1 — Add TransportErrorInfo type and classifyTransportError helper

**Size:** Medium | **Priority:** High | **Dependencies:** None

Add the `TransportErrorInfo` type to `chat-types.ts` and implement the `classifyTransportError` helper in `use-chat-session.ts`. Update the hook's `error` state from `string | null` to `TransportErrorInfo | null`. Also update `stream-event-handler.ts` to match the new `setError` signature.

**Files changed:**

- `apps/client/src/layers/features/chat/model/chat-types.ts` — new `TransportErrorInfo` interface
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — `classifyTransportError` helper, state type change, catch block update
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — `setError` signature update, construct `TransportErrorInfo` in error handler

**Classification rules:**

| Error Signal                                      | Heading               | Retryable |
| ------------------------------------------------- | --------------------- | --------- |
| `code === 'SESSION_LOCKED'`                       | "Session in use"      | No        |
| `TypeError` or message contains "fetch"/"network" | "Connection failed"   | Yes       |
| HTTP 500-599                                      | "Server error"        | Yes       |
| HTTP 408 or message contains "timeout"            | "Request timed out"   | Yes       |
| Default                                           | "Error" (raw message) | No        |

---

## Phase 2: Banner Enhancement

### Task 2.1 — Replace raw error banner with structured TransportErrorBanner

**Size:** Small | **Priority:** High | **Dependencies:** 1.1

Replace the raw `<div>` error banner in `ChatPanel.tsx` with a structured layout: `AlertTriangle` icon, heading, message, and conditional retry button. Uses `border-destructive/30 bg-destructive/5` styling. Retry button calls existing `handleRetry` (re-sends last user message). Also ensure SESSION_LOCKED auto-dismiss clears the error state.

**Files changed:**

- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — banner replacement, imports for `AlertTriangle` and `Button`
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — clear error in sessionBusy timer

---

## Phase 3: Tests

### Task 3.1 — Add unit tests for classifyTransportError

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 3.2

Export `classifyTransportError` with `@internal` tag. Create 13 unit tests covering every error signal: SESSION_LOCKED, TypeError, network keyword, fetch keyword, HTTP 500/502/503, HTTP 408, timeout keyword, unknown, non-Error values, null, and priority ordering.

**Files changed:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — export `classifyTransportError`
- `apps/client/src/layers/features/chat/model/__tests__/classify-transport-error.test.ts` — new test file

### Task 3.2 — Add component tests for TransportErrorBanner in ChatPanel

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1 | **Parallel with:** 3.1

7 component tests verifying: banner not rendered when no error, heading/message display for network and server errors, retry button conditional visibility, retry click calls submitContent with last user message, session locked display without retry.

**Files changed:**

- `apps/client/src/layers/features/chat/ui/__tests__/TransportErrorBanner.test.tsx` — new test file

---

## Dependency Graph

```
1.1 Foundation: Type + classifier + state change
 ├── 2.1 Banner: Structured UI in ChatPanel
 │    └── 3.2 Tests: Component tests for banner
 └── 3.1 Tests: Unit tests for classifyTransportError
```

## Summary

| Phase                  | Tasks | Total Effort     |
| ---------------------- | ----- | ---------------- |
| 1 — Foundation         | 1     | Medium           |
| 2 — Banner Enhancement | 1     | Small            |
| 3 — Tests              | 2     | Small + Medium   |
| **Total**              | **4** | **~S-M overall** |
