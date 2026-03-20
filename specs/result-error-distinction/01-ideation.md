---
slug: result-error-distinction
number: 115
created: 2026-03-16
status: ideation
---

# Result Error/Success Distinction

**Slug:** result-error-distinction
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/result-error-distinction

---

## 1) Intent & Assumptions

- **Task brief:** The `result` SDK message handler in `sdk-event-mapper.ts:117` treats success and error subtypes identically — both produce a `done` StreamEvent. SDK-level failures (context overflow, API errors, permission denials, turn limits, budget limits) are silently swallowed. Users see "Done" when the agent actually failed. Fix the mapper to distinguish error results, propagate error details through the StreamEvent schema, and display meaningful categorized error states inline in the chat stream with a retry affordance.
- **Assumptions:**
  - The existing `ErrorEventSchema` in `packages/shared/src/schemas.ts` can be extended with a `category` field
  - The existing `error` StreamEvent type is the correct vehicle (no new event type needed)
  - The client's `stream-event-handler.ts` already has a code path for `error` events
  - Error display moves from the current banner-above-input to inline in the message stream
- **Out of scope:**
  - Rate limit handling (separate P0 punch list item #1, spec #136)
  - Extended thinking visibility (separate P1 item)
  - Subagent lifecycle visibility (separate P0 items #2-3, spec #137)
  - Full type safety refactoring of the mapper (P3 item)
  - Specialized tool renderers

## 2) Pre-reading Log

**Source:** `.temp/agent-sdk-audit.md` (Agent SDK Implementation Audit, 2026-03-16)

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts:117-138`: Result message handler — extracts model, cost, tokens, context window. **Does not check `subtype`**. Both success and error yield `session_status` + `done`.
- `packages/shared/src/schemas.ts:29-47`: StreamEvent type inventory. `error` type exists with `ErrorEventSchema` (has `message` and `code` fields). `done` type exists with `DoneEventSchema`.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts:268-313`: Client handler for `session_status` and `done`. Done triggers cleanup (reset streaming state, elapsed time, token count). No error distinction.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: Contains error banner display above input — inline red banner, no animation, low prominence.
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.test.ts`: Test suite with 88 tests. Line 308-319 tests that unknown types yield nothing.
- `apps/client/src/layers/features/chat/ui/InferenceIndicator.tsx`: Streaming status with rotating verbs. Has waiting states for approval/question. No error/failed state.

## 3) Codebase Map

**Source:** `.temp/agent-sdk-audit.md`

- **Primary components/modules:**
  - `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — Maps SDK messages to StreamEvents. The `result` handler at line 117 is the core fix site.
  - `packages/shared/src/schemas.ts` — Zod schemas for all StreamEvent types. `ErrorEventSchema` needs `category` field.
  - `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Client-side event handler. Needs to route `error` events with category to produce inline error message parts.
  - `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Currently renders error banner. Needs migration to inline error rendering.
- **Shared dependencies:**
  - `packages/shared/src/schemas.ts` — shared between server and client
  - `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Zustand store with error state and `submitContent` (for retry)
- **Data flow:** `SDK result message` → `sdk-event-mapper.ts` → yields `error` StreamEvent → SSE → `stream-event-handler.ts` → updates message parts with error block → `AssistantMessageContent.tsx` renders inline error → retry button calls `submitContent()`
- **Feature flags/config:** None
- **Potential blast radius:**
  - Direct: 4 files (mapper, schemas, stream-event-handler, ChatPanel/new ErrorMessageBlock component)
  - Indirect: InferenceIndicator (may want a "failed" state), test files for mapper
  - Tests: `sdk-event-mapper.test.ts` needs new test cases for error subtypes

## 4) Root Cause Analysis

- **Repro steps:**
  1. Start a session with an agent that will hit an error (e.g., exceed max turns, or cause an API error)
  2. Observe the SDK emits `{ type: 'result', subtype: 'error', errors: [...] }`
  3. The mapper at line 117 does not check `subtype` — proceeds to yield `session_status` + `done`
  4. Client receives `done`, cleans up streaming state, shows normal completion
- **Observed vs Expected:**
  - Observed: User sees "Done" with no error indication
  - Expected: User sees an inline error message with category-specific copy and a retry button (for retryable errors)
- **Evidence:** `sdk-event-mapper.ts:117` — the handler reads `type === 'result'` but never reads `subtype`. The entire error path is absent.
- **Root-cause hypotheses:**
  1. **Missing conditional branch** (confidence: 100%) — The mapper simply never checks `result.subtype`. This is not a logic error; the branch was never written.
- **Decision:** Root cause is a missing `if (subtype === 'error')` branch. The fix is straightforward.

## 5) Research

**Source:** Research agent investigation (2026-03-16) + `.temp/agent-sdk-audit.md`

### SDK Error Subtypes

The SDK defines four result error subtypes:

| SDK Subtype                           | User Category     | Retryable                           | Frequency                             |
| ------------------------------------- | ----------------- | ----------------------------------- | ------------------------------------- |
| `error_max_turns`                     | Turn limit        | No                                  | Common for long autonomous runs       |
| `error_during_execution`              | Execution failure | Yes (transient) / No (auth/billing) | Most common                           |
| `error_max_budget_usd`                | Budget exhausted  | No                                  | Rare unless `maxBudgetUsd` configured |
| `error_max_structured_output_retries` | Output format     | No                                  | Rare                                  |

Within `error_during_execution`, sub-cases are detectable by inspecting the `errors[]` string array:

- API overload / 5xx: transient, retryable
- Authentication/key failure: config problem, not retryable
- Context window exceeded: needs new session

### Industry Error Display Patterns

Best-in-class AI chat interfaces (ChatGPT, GitHub Copilot Chat, Cursor) render errors **inline in the message timeline** — as a styled message block appended after the last assistant content — not as a banner above the input.

Key characteristics:

- Icon + muted red/amber tint
- Three-layer copy: what happened / why / what to do next
- Retry button co-located with the failed turn
- Collapsible details disclosure for raw error text
- Error persists in scroll history

### Recommended Approach

1. **`sdk-event-mapper.ts`**: Branch on `result.subtype`; for `'error'`, yield `error` event with `code` = subtype, `category` mapped from subtype, `message` from `errors[0]` or generic copy. Yield `done` only for `'success'`.
2. **`ErrorEventSchema`**: Add optional `category` field: `z.enum(['max_turns', 'execution_error', 'budget_exceeded', 'output_format_error'])`.
3. **`stream-event-handler.ts`**: On `error` event, append an `error` message part to the current assistant message (new part type) instead of/in addition to setting banner state.
4. **New `ErrorMessageBlock.tsx`**: Inline error component with category-specific heading, sub-text, optional retry button, collapsible raw details.
5. **Retry**: Only for `execution_error` — retry button re-sends `lastUserMessage.content` via `submitContent()`.

### Error Message Templates

| Category              | Heading                      | Sub-text                                                    | Action              |
| --------------------- | ---------------------------- | ----------------------------------------------------------- | ------------------- |
| `max_turns`           | "Turn limit reached"         | "The agent ran for its maximum number of turns."            | "Start new session" |
| `execution_error`     | "Agent stopped unexpectedly" | "An error occurred during execution." + collapsible details | "Retry" button      |
| `budget_exceeded`     | "Cost limit reached"         | "This session exceeded its budget."                         | None                |
| `output_format_error` | "Output format error"        | "The agent couldn't satisfy the required output format."    | None                |

## 6) Decisions

| #   | Decision               | Choice                          | Rationale                                                                                                                                                                          |
| --- | ---------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Error display location | Inline in message stream        | Matches industry best practice (ChatGPT, Cursor). Error persists in scroll history, co-located with the failed turn. Moves visibility from 3/5 to 5/5.                             |
| 2   | Retry affordance       | Retry button on the error block | Re-sends last user message for retryable errors. Non-retryable errors get category-appropriate alternative actions (e.g., "Start new session"). Matches ChatGPT/Claude.ai pattern. |
| 3   | Error categorization   | 3-4 user-facing categories      | Group SDK subtypes into max_turns, execution_error, budget_exceeded, output_format_error. Each gets tailored copy and action. Balances helpfulness with simplicity.                |
