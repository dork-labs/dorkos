---
slug: error-categorization-retry
number: 139
created: 2026-03-16
status: specification
---

# Error Categorization & Retry Affordance — Specification

## Overview

Enhance the transport-level error banner in ChatPanel with categorized copy, icons, and a retry button for transient failures. SDK-level error categorization (inline `ErrorMessageBlock` with retry) is already implemented via P1 #5 (result-error-distinction). This spec covers the **remaining gaps**: transport errors shown in the raw red banner at `ChatPanel.tsx:349-353`.

### Prerequisites

- P1 #5 (result-error-distinction) — already implemented

### Non-Goals

- Automatic retry for any error type
- Input draft preservation on error
- Error analytics/telemetry
- Redesigning the inline `ErrorMessageBlock` (already done)
- Rate limit display (separate P0 concern, already has `isRateLimited`/`rateLimitRetryAfter` props)

---

## Design

### Error Surface Model

Two distinct error surfaces, each for a different error class:

| Surface                      | Error Class                              | Examples                                                                 | Retry?                     |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| **Inline ErrorMessageBlock** | SDK result errors (have `category`)      | `max_turns`, `execution_error`, `budget_exceeded`, `output_format_error` | Yes, for `execution_error` |
| **Transport error banner**   | Transport/network errors (no `category`) | Network failure, server 500, session locked, timeout                     | Yes, for transient errors  |

The inline path is done. This spec covers the banner path only.

### Transport Error Categories

Introduce a client-side `TransportErrorInfo` type (not a shared schema — these are client-only presentation concerns):

```typescript
/** Client-side transport error classification for banner display. */
interface TransportErrorInfo {
  heading: string;
  message: string;
  retryable: boolean;
  autoDismissMs?: number;
}
```

Classification logic in `use-chat-session.ts` catch block:

| Error Signal                                               | Category | Heading             | Message                                                            | Retryable | Auto-dismiss                 |
| ---------------------------------------------------------- | -------- | ------------------- | ------------------------------------------------------------------ | --------- | ---------------------------- |
| `err.code === 'SESSION_LOCKED'`                            | locked   | "Session in use"    | "Another client is sending a message. Try again in a few seconds." | No        | 5s (`SESSION_BUSY_CLEAR_MS`) |
| `err.message` contains "fetch" or "network" or `TypeError` | network  | "Connection failed" | "Could not reach the server. Check your connection and try again." | Yes       | No                           |
| HTTP status 500-599                                        | server   | "Server error"      | "The server encountered an error. Try again."                      | Yes       | No                           |
| HTTP status 408 or timeout                                 | timeout  | "Request timed out" | "The server took too long to respond. Try again."                  | Yes       | No                           |
| Default                                                    | unknown  | "Error"             | `err.message` (raw, as fallback)                                   | No        | No                           |

### Banner Component Enhancement

Replace the raw `<div>` at `ChatPanel.tsx:349-353` with a structured `TransportErrorBanner` component (inline in ChatPanel or extracted to a small component in the same file).

**Visual design:**

```
┌─────────────────────────────────────────────────────────┐
│  ⚠  Connection failed                          [Retry] │
│     Could not reach the server. Check your connection.  │
└─────────────────────────────────────────────────────────┘
```

- Same border/background pattern as existing banner (`border-destructive/30 bg-destructive/5`) but with structure
- `AlertTriangle` icon (matches `ErrorMessageBlock`)
- Heading in `font-medium text-sm`
- Message in `text-sm text-muted-foreground`
- Retry button (outline variant, small) on the right — only when `retryable: true`
- Auto-dismiss for `SESSION_LOCKED` (already has timer via `sessionBusy` state)

### Retry Behavior

The banner retry button calls the same `handleRetry` already in ChatPanel (line 196-201): find last user message, call `submitContent`. No new retry logic needed.

### State Changes

**`use-chat-session.ts` catch block** — change `error` state from `string | null` to `TransportErrorInfo | null`:

```typescript
// Before:
setError((err as Error).message);

// After:
setError(classifyTransportError(err));
```

The `classifyTransportError` function lives in `use-chat-session.ts` as a module-level helper (not exported — internal to the hook).

**`ChatPanel.tsx`** — update the banner to read structured error info instead of raw string.

---

## Implementation

### Phase 1: Transport Error Classification (S effort)

**File: `apps/client/src/layers/features/chat/model/use-chat-session.ts`**

1. Add `TransportErrorInfo` interface (above hook, not exported)
2. Add `classifyTransportError(err: unknown): TransportErrorInfo` helper
3. Change `error` state type from `string | null` to `TransportErrorInfo | null`
4. Replace `setError((err as Error).message)` with `setError(classifyTransportError(err))`

**File: `apps/client/src/layers/features/chat/model/chat-types.ts`**

5. Export `TransportErrorInfo` type so ChatPanel can consume it

### Phase 2: Banner Enhancement (S effort)

**File: `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`**

1. Replace the raw banner `<div>` (lines 349-353) with structured display:
   - Icon (`AlertTriangle`)
   - `error.heading` in `font-medium`
   - `error.message` in `text-muted-foreground`
   - Conditional retry button when `error.retryable`
2. Retry button calls existing `handleRetry` callback

### Phase 3: Tests (S effort)

**File: `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-error.test.ts`** (new)

1. Test `classifyTransportError` with each error signal:
   - SESSION_LOCKED → locked category, not retryable
   - Network error → network category, retryable
   - Server 500 → server category, retryable
   - Timeout → timeout category, retryable
   - Unknown → unknown category, not retryable, raw message preserved

**File: `apps/client/src/layers/features/chat/ui/__tests__/ChatPanel.test.tsx`** (update if exists, or test via ErrorMessageBlock tests)

2. Test banner renders heading/message from structured error
3. Test retry button appears only for retryable errors
4. Test retry button calls handleRetry

---

## Testing Strategy

| Test                                | Type        | What It Validates                                                            |
| ----------------------------------- | ----------- | ---------------------------------------------------------------------------- |
| `classifyTransportError` unit tests | Unit        | Each error signal maps to correct category, heading, message, retryable flag |
| Banner rendering                    | Component   | Structured error info renders correctly, retry button conditional            |
| Retry click                         | Component   | Button calls handleRetry which re-sends last user message                    |
| SESSION_LOCKED behavior             | Integration | Existing auto-clear timer still works with new structured error              |

---

## Migration

No migration needed. The `error` state type changes from `string | null` to `TransportErrorInfo | null`, which is internal to `use-chat-session.ts` and consumed only by `ChatPanel.tsx`. Both files change in the same PR.

---

## Risks

| Risk                                                 | Mitigation                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Type change breaks other consumers of `error`        | Grep for all `error` destructured from `useChatSession` — only ChatPanel uses it |
| Classification heuristics miss edge cases            | Default "unknown" category preserves raw message as fallback                     |
| Retry on network error while server is actually down | Retry is manual and user-initiated — "honest by design"                          |
