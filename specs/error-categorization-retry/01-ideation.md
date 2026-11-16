---
slug: error-categorization-retry
number: 139
created: 2026-03-16
status: ideation
---

# Error Categorization & Retry Affordance

**Slug:** error-categorization-retry
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/error-categorization-retry

---

## 1) Intent & Assumptions

- **Task brief:** Add error categorization and retry affordance to the chat error display. Categorize errors (transient vs permanent, user-actionable vs system), show human-readable messages, and offer a retry button for transient failures that re-sends the last user message. This is P2 punch list item #17 from the Agent SDK audit.
- **Assumptions:**
  - P1 #5 (result error/success conflation) has been substantially implemented — `ErrorMessageBlock`, `ErrorCategorySchema`, `handleRetry`, and `MessageContext.onRetry` all exist in the codebase
  - This spec focuses on **gap analysis** — documenting what's done and specifying remaining work
  - Rate limit display (P0 #1) is a separate concern handled by its own implementation
  - The retry button (not input draft restoration) is the single retry affordance
- **Out of scope:**
  - Automatic retry for any error type (users must consent — "honest by design")
  - Input draft preservation on error (retry button is sufficient)
  - Error analytics/telemetry
  - Specialized recovery flows (e.g., auto-compact on context overflow)
  - Full UX redesign of error surfaces

## 2) Pre-reading Log

- `specs/result-error-distinction/02-specification.md`: Full spec for P1 #5 — the foundational work that this feature depends on. Covers schema changes, mapper logic, component design, and test patterns.
- `packages/shared/src/schemas.ts`: `ErrorCategorySchema` (4 values), `ErrorPartSchema` (type/message/category/details), `ErrorEventSchema` (extended with category/details). Already committed.
- `packages/shared/src/types.ts`: Re-exports `ErrorCategory`, `ErrorPart`, `ErrorEvent`.
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: `mapErrorCategory()` helper implemented. Result handler branches on `subtype`, emits `error` event with category/details for non-success results.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Error case checks `errorData.category` — categorized errors append `ErrorPart` inline, uncategorized errors set banner.
- `apps/client/src/layers/features/chat/ui/ErrorMessageBlock.tsx`: Fully implemented — `ERROR_COPY` maps categories to heading/subtext/retryable, collapsible details, conditional retry button.
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Renders `ErrorMessageBlock` for `part.type === 'error'` with `onRetry` from `MessageContext`.
- `apps/client/src/layers/features/chat/ui/message/MessageContext.tsx`: `onRetry?: () => void` already in `MessageContextValue`.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: `handleRetry` callback (line 196-201) finds last user message and calls `submitContent`. Also has rate limit props (`isRateLimited`, `rateLimitRetryAfter`). Banner error display at line 349-353.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: `executeSubmission()` and `submitContent()` handle message sending. `error` state is set for transport-level failures.
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-event-mapper.test.ts`: 7 tests covering result error subtypes.
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-error.test.ts`: 3 tests for categorized/uncategorized error handling.
- `apps/client/src/layers/features/chat/ui/__tests__/ErrorMessageBlock.test.tsx`: Component tests for rendering, retry, details disclosure.
- `.temp/agent-sdk-audit.md`: Comprehensive audit. P2 #3 (UX items) = "Error display lacks retry". P0 #1 = rate limit blindness. P1 #5 = result error/success conflation.
- `research/20260316_sdk_result_error_ux_patterns.md`: Prior research on error UX patterns for LLM chat interfaces.
- `contributing/design-system.md`: Calm Tech design language — card radius 16px, animation 100-300ms, semantic colors.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/chat/ui/ErrorMessageBlock.tsx` — Inline error block with category copy, retry, details
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Orchestrates error display (banner + inline via MessageList)
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — Routes error parts to ErrorMessageBlock
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Processes error events into inline parts or banner
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — Maps SDK result errors to categorized StreamEvents

**Shared Dependencies:**

- `packages/shared/src/schemas.ts` — ErrorCategorySchema, ErrorPartSchema, ErrorEventSchema
- `packages/shared/src/types.ts` — Type re-exports
- `apps/client/src/layers/features/chat/ui/message/MessageContext.tsx` — onRetry threading

**Data Flow:**
SDK result (error subtype) → `sdk-event-mapper.ts` (mapErrorCategory) → `error` StreamEvent with category/details → SSE → `stream-event-handler.ts` → ErrorPart in message parts → `AssistantMessageContent` → `ErrorMessageBlock` (with retry via MessageContext)

Transport error → `use-chat-session.ts` (catch block) → `error` string state → ChatPanel banner (line 349-353)

**Feature Flags/Config:** None.

**Potential Blast Radius:**

- Direct: 2-3 files (ChatPanel banner enhancement, possibly use-chat-session error categorization)
- Indirect: None significant — the inline path is fully wired
- Tests: 1-2 test files may need updates

## 4) Root Cause Analysis

N/A — this is a feature, not a bug fix.

## 5) Research

Research from `research/20260316_error_categorization_retry.md` and `research/20260316_sdk_result_error_ux_patterns.md`:

**1. Inline ErrorMessageBlock (Already Implemented)**

- Description: Render errors as a special message part inside the assistant turn with category-specific copy and retry
- Pros: Co-located with failure, persistent on scroll, matches ChatGPT/Claude.ai/Cursor patterns
- Cons: N/A (already built)
- Complexity: Done

**2. Enhanced Banner for Transport Errors**

- Description: Upgrade the raw red banner (ChatPanel line 349-353) with categorized copy, icons, and optional retry
- Pros: Transport errors are session-level (not message-level), banner is appropriate surface
- Cons: Two error surfaces to maintain (banner + inline)
- Complexity: S

**3. Input Draft Restoration**

- Description: Populate chat input with failed message text so users can edit before retry
- Pros: More honest, user sees what they're retrying
- Cons: Two retry paths is confusing, adds complexity
- Complexity: M
- Decision: **Rejected** — retry button is the single affordance

**4. Auto-Retry for Transient Errors**

- Description: Automatically retry on rate limit or network blip without user action
- Pros: Reduces friction
- Cons: Violates "honest by design" principle, users should consent to re-runs
- Decision: **Rejected**

**Recommendation:** Gap analysis approach — the inline path is done, focus on enhancing the banner for transport-level errors and ensuring all error paths are categorized.

## 6) Decisions

| #   | Decision        | Choice                                   | Rationale                                                                                                                                                                                                                     |
| --- | --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Spec scope      | Gap analysis only                        | SDK-level error categorization + retry is already implemented via P1 #5. This spec documents what's done and specifies remaining transport-error gaps.                                                                        |
| 2   | Retry mechanism | Retry button only (no input restoration) | One retry affordance is simpler. The inline retry button already re-sends the last message. Two paths (button + input draft) would be confusing.                                                                              |
| 3   | Banner fate     | Keep for transport errors, enhance       | Transport/network errors (connection refused, 500, timeout) are session-level, not message-level. The banner is the right surface — they don't belong inline in the conversation. Enhance with icons and human-readable copy. |
| 4   | Auto-retry      | No auto-retry for any category           | "Honest by design" — users must consent to re-runs. Agent execution costs money and time.                                                                                                                                     |

---

## Gap Analysis: What's Done vs What Remains

### Already Implemented (P1 #5 Work)

| Area                                                           | Status | Evidence                                                                                |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `ErrorCategorySchema` (4 SDK categories)                       | Done   | `schemas.ts` — `max_turns`, `execution_error`, `budget_exceeded`, `output_format_error` |
| `ErrorPartSchema` in `MessagePartSchema` union                 | Done   | `schemas.ts` — type/message/category/details                                            |
| `ErrorEventSchema` extended with category/details              | Done   | `schemas.ts`                                                                            |
| `mapErrorCategory()` in SDK mapper                             | Done   | `sdk-event-mapper.ts`                                                                   |
| Result handler branches on success/error                       | Done   | `sdk-event-mapper.ts`                                                                   |
| Stream event handler routes categorized errors to inline parts | Done   | `stream-event-handler.ts`                                                               |
| `ErrorMessageBlock` component                                  | Done   | `ErrorMessageBlock.tsx` — full copy, retry, details                                     |
| `AssistantMessageContent` renders error parts                  | Done   | `AssistantMessageContent.tsx:137-147`                                                   |
| `MessageContext.onRetry`                                       | Done   | `MessageContext.tsx`                                                                    |
| `ChatPanel.handleRetry`                                        | Done   | `ChatPanel.tsx:196-201`                                                                 |
| Server + client + component tests                              | Done   | 3 test files with 10+ tests                                                             |

### Remaining Gaps

| #   | Gap                                  | Current Behavior                                        | Desired Behavior                                                                                 | Effort |
| --- | ------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| 1   | **Transport error banner is raw**    | Red banner shows raw error string (`ChatPanel:349-353`) | Enhanced banner with icon, categorized copy (network, timeout, locked)                           | S      |
| 2   | **Transport errors not categorized** | `use-chat-session.ts` sets `error` as raw string        | Categorize transport errors (network, server error, session locked) with human-readable messages | S      |
| 3   | **No retry on transport errors**     | Banner has no retry button — user must re-type or wait  | Add retry button for transient transport errors (network failures)                               | S      |
| 4   | **SESSION_LOCKED auto-clear**        | 3s auto-clear with no context                           | Show "Another client is active" with remaining wait time                                         | XS     |
| 5   | **Audit update**                     | P2 #3 listed as not started                             | Mark as substantially complete, note remaining gaps                                              | XS     |
