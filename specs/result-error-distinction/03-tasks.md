# Result Error/Success Distinction — Task Breakdown

**Spec:** `specs/result-error-distinction/02-specification.md`
**Generated:** 2026-03-16
**Mode:** Full

---

## Phase 1: Schema Foundation (2 tasks)

### 1.1 — Add ErrorCategorySchema and extend ErrorEventSchema

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Add `ErrorCategorySchema` enum (`max_turns`, `execution_error`, `budget_exceeded`, `output_format_error`) to `packages/shared/src/schemas.ts`. Extend `ErrorEventSchema` with optional `category` and `details` fields. Both get `.openapi()` annotations.

### 1.2 — Add ErrorPartSchema and extend MessagePartSchema discriminated union

**Size:** Small | **Priority:** High | **Dependencies:** 1.1

Add `ErrorPartSchema` with `type: 'error'`, `message`, optional `category`, optional `details` to the Message Part Types section. Add it to the `MessagePartSchema` discriminated union alongside `TextPartSchema`, `ToolCallPartSchema`, and `SubagentPartSchema`.

---

## Phase 2: Server (2 tasks)

### 2.1 — Add mapErrorCategory helper and branch result handler in sdk-event-mapper

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Add `mapErrorCategory()` function mapping SDK subtypes to `ErrorCategory` values. Replace the result handler in `sdk-event-mapper.ts` to emit `session_status` → `error` (if error subtype) → `done` instead of always `session_status` → `done`.

### 2.2 — Add SDK event mapper tests for all result subtypes

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1

Seven test cases covering: success result (2 events), error_during_execution (3 events with correct category), error_max_turns, error_max_budget_usd, error_max_structured_output_retries, empty errors array fallback, session status data present on error.

---

## Phase 3: Client (4 tasks)

### 3.1 — Update stream-event-handler error case to append ErrorPart for categorized errors

**Size:** Small | **Priority:** High | **Dependencies:** 1.1, 1.2 | **Parallel with:** 3.2

Modify the `'error'` case in `stream-event-handler.ts`: if `errorData.category` exists, push an `ErrorPart` to the message parts array and call `updateAssistantMessage`. Otherwise, fall through to the existing `setError()` banner path. Always call `setStatus('error')`.

### 3.2 — Create ErrorMessageBlock component

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 3.1

New component at `apps/client/src/layers/features/chat/ui/ErrorMessageBlock.tsx`. Renders a red-tinted card with AlertCircle icon, category-specific heading/description from `ERROR_COPY` map, collapsible "Details" disclosure with `AnimatePresence`, and a "Retry" button (only for `execution_error` + `onRetry` present).

### 3.3 — Add onRetry to MessageContext and thread from ChatPanel

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2

Extend `MessageContextValue` with `onRetry: (() => void) | undefined`. Create `handleRetry` in ChatPanel (finds last user message, calls `submitContent`). Thread through `MessageProvider`. Update `useMemo` deps.

### 3.4 — Integrate ErrorMessageBlock into AssistantMessageContent rendering loop

**Size:** Small | **Priority:** High | **Dependencies:** 3.2, 3.3

Add `part.type === 'error'` branch in `AssistantMessageContent`'s `parts.map()` loop. Render `ErrorMessageBlock` with `category`, `message`, `details`, and `onRetry` from `useMessageContext()`.

---

## Phase 4: Testing (2 tasks)

### 4.1 — Add ErrorMessageBlock component tests

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.2 | **Parallel with:** 4.2

Seven test cases: category heading/description rendering, retry button visibility for execution_error only, retry button absent without onRetry, collapsible details toggle, onRetry callback invocation, fallback UI without category, no details button when details is undefined.

### 4.2 — Add stream-event-handler tests for categorized vs uncategorized errors

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.1 | **Parallel with:** 4.1

Two test cases: categorized error appends ErrorPart (no banner), uncategorized error calls setError (no ErrorPart). Both verify `setStatus('error')` is always called.

---

## Summary

| Phase                | Tasks  | Parallel Opportunities                   |
| -------------------- | ------ | ---------------------------------------- |
| 1. Schema Foundation | 2      | 1.1 + 1.2 (partial — 1.2 depends on 1.1) |
| 2. Server            | 2      | Sequential (2.2 depends on 2.1)          |
| 3. Client            | 4      | 3.1 + 3.2 can run in parallel            |
| 4. Testing           | 2      | 4.1 + 4.2 can run in parallel            |
| **Total**            | **10** |                                          |

**Critical path:** 1.1 → 2.1 → 2.2 (server) and 1.1 → 1.2 → 3.1/3.3 → 3.4 (client), converging at 3.4.

**Estimated total effort:** ~4-6 hours for a developer familiar with the codebase.
