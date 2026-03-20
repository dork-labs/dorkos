---
title: 'SDK Result Error State UX Patterns — Categorization, Display, and Retry Affordance'
date: 2026-03-16
type: implementation
status: active
tags: [error-handling, ux, sdk, stream-events, chat-ui, retry, error-categorization]
feature_slug: result-error-distinction
searches_performed: 8
sources_count: 14
---

# SDK Result Error State UX Patterns

## Research Summary

The Claude Agent SDK emits four distinct `result` error subtypes (`error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`), each requiring a different user-facing treatment. Best-in-class AI chat interfaces display errors inline in the conversation flow — not as toasts or modals — and offer a contextual retry affordance when recovery is possible. The existing `ErrorEvent` schema already has `message` and `code` fields; adding a `category` field enables the client to branch on error type for appropriate display and recovery copy.

---

## Key Findings

### 1. SDK Error Subtypes Are Exhaustive and Well-Defined

The `SDKResultMessage` union has exactly four error subtypes:

| Subtype                               | Meaning                                                                     | `errors: string[]` content              |
| ------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| `error_max_turns`                     | Agent hit the `maxTurns` cap                                                | Human-readable message about turn limit |
| `error_during_execution`              | Runtime exception — API error, permission denial, invalid key, server fault | Varies; may include HTTP status details |
| `error_max_budget_usd`                | Agent hit the `maxBudgetUsd` cap                                            | Cost summary                            |
| `error_max_structured_output_retries` | Structured output schema validation failed repeatedly                       | Validation error details                |

Additionally, the `SDKAssistantMessage` has an `error?` field typed as `'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown'` — these can appear mid-stream, before a `result` message. The `SDKRateLimitEvent` is also a distinct message type with `status: 'allowed' | 'allowed_warning' | 'rejected'`, indicating the session was rate-limited (handled in ADR-0136 as a separate `rate_limit` StreamEvent).

### 2. The Current Error Path Is Completely Bypassed

In `sdk-event-mapper.ts:117-138`, the `result` handler unconditionally yields `session_status` then `done` regardless of `subtype`. The `errors` array on error result messages is never read. The fix is a two-branch guard:

```typescript
if (message.type === 'result') {
  // Always emit session_status (cost/usage is still valid on error results)
  yield { type: 'session_status', data: { ... } };

  if (result.subtype === 'error_max_turns'
      || result.subtype === 'error_during_execution'
      || result.subtype === 'error_max_budget_usd'
      || result.subtype === 'error_max_structured_output_retries') {
    yield {
      type: 'error',
      data: {
        message: (result.errors as string[])?.[0] ?? 'The agent encountered an error.',
        code: result.subtype,
      },
    };
  } else {
    yield { type: 'done', data: { sessionId } };
  }
}
```

### 3. The Existing `ErrorEventSchema` Already Supports a `code` Field

```typescript
export const ErrorEventSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});
```

The `code` field maps directly to the SDK subtype string. No schema change is required to carry the category to the client. However, the client currently ignores `code` entirely — the `stream-event-handler.ts` only reads `message` on the `error` event (line 263-264).

### 4. Current Client Error Display Is Minimal

The error banner in `ChatPanel.tsx:336-340`:

```tsx
{
  error && (
    <div className="mx-4 mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
      {error}
    </div>
  );
}
```

- Positioned above the chat input, below message list
- Raw `error` string dumped directly — SDK error messages are often technical
- No retry button
- No categorization, no suggested action
- Status set to `'error'`, which prevents new messages from being sent (the `ChatStatus` type already has `'error'`)

---

## Detailed Analysis

### Error Categorization Taxonomy

Three axes matter for display and recovery decisions:

**By recoverability:**

| Category              | Subtypes / Codes                                                                   | Retryable?                                          | User action                         |
| --------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| **Hard Limit**        | `error_max_turns`                                                                  | No — retrying with same config will hit limit again | Start new session or increase limit |
| **Budget Exhausted**  | `error_max_budget_usd`                                                             | No — same issue will recur                          | Check cost settings                 |
| **Execution Failure** | `error_during_execution` (API error, server fault, permission denial, invalid key) | Maybe — depends on sub-cause                        | Varies by sub-cause; see below      |
| **Validation Loop**   | `error_max_structured_output_retries`                                              | Maybe — prompt may help                             | Rephrase request                    |

The `error_during_execution` case is the broadest and least homogeneous. Within it:

- **API errors / server faults**: Often transient (5xx); retry after delay is reasonable
- **Authentication / billing**: Requires config change; retry will always fail
- **Permission denials**: Agent ran out of approvals; retry only works if permissions are granted

Without inspecting the `errors[0]` string content, the client cannot distinguish these sub-cases. The pragmatic approach is to treat `error_during_execution` as "potentially retryable" and let the user decide, while surfacing the raw SDK message in an expandable detail region.

**By frequency (from SDK docs and community issues):**

- `error_during_execution` is most common (API overload, context overflow during execution, auth issues)
- `error_max_turns` is common for long autonomous tasks with default `maxTurns`
- `error_max_budget_usd` is rare unless `maxBudgetUsd` is configured
- `error_max_structured_output_retries` is rare (only when `outputFormat` is set)

**User-recognizable categories (for copy writing):**

| User-facing category | Maps to                               | Icon                            |
| -------------------- | ------------------------------------- | ------------------------------- |
| Turn limit reached   | `error_max_turns`                     | `RotateCcw` or `Hash`           |
| Budget limit reached | `error_max_budget_usd`                | `DollarSign` or `AlertTriangle` |
| Agent error          | `error_during_execution`              | `AlertCircle`                   |
| Output format error  | `error_max_structured_output_retries` | `FileWarning`                   |

### Error Display Patterns — Industry Survey

**Inline-in-stream (recommended):** The pattern most consistent with AI chat UX is rendering the error as a special message item in the chat timeline, not as a banner above the input. ChatGPT, GitHub Copilot Chat, and Cursor all surface errors as styled message bubbles at the bottom of the conversation. The user sees the error in context — immediately after the last message that triggered it — rather than disconnected from the conversation.

Benefits over banner-above-input:

- The error stays visible as the user scrolls — a banner disappears when the list scrolls
- The user knows exactly which turn failed
- The retry button is co-located with the failed turn

**The Vercel AI SDK pattern:** The `useChat()` hook exposes an `error` object and recommends a "Regenerate" button that calls `reload()` to retry the last request while keeping history intact. This is the standard recoverable-error pattern.

**Context overflow — silent compaction:** The OpenClaw issue tracker documents the ideal pattern for context overflow: silently compact and retry. If retry succeeds, the user sees nothing. Only surface the error if retries are exhausted. This is not directly applicable here since we cannot auto-retry an `error_max_turns` result, but the principle — "don't surface what the system can recover from" — is important.

**Severity-appropriate placement:**

- **Inline error message**: For session-terminating errors (`error_max_turns`, `error_during_execution`)
- **Banner above input**: Only for infrastructure-level errors that affect the whole session before it starts (CONNECTION_FAILED, SESSION_LOCKED — already handled)
- **Toast**: For transient, auto-dismissing notifications (not appropriate for a failed agent run)
- **Modal**: Only for destructive or irreversible state (not appropriate here)

**Icon + color + text, never color alone:** Smart Interface Design Patterns and Pencil & Paper both emphasize accessibility — never use color as the only error indicator. A `AlertCircle` icon (Lucide) paired with the red variant is the correct pattern for DorkOS's design system.

### Retry Affordance Design per Category

**`error_max_turns` — No retry, offer new session or continuation:**
The agent completed its allotted turns and stopped. Retrying with the same prompt and same session will hit the limit again immediately (turn count does not reset mid-session). The affordance should be:

- "Continue in new session" button that opens a follow-up prompt pre-filled with context
- No raw retry button

**`error_during_execution` — Contextual retry:**
This is the "unknown" category. The user can reasonably try again for transient failures (API overload, temporary server fault). The affordance:

- "Retry" button that re-sends the last user message
- Expandable "Details" section showing the raw `errors[0]` string for debugging
- If the error string contains recognizable auth keywords ("authentication", "API key", "invalid key"), suppress retry and show a settings link instead

**`error_max_budget_usd` — No retry, link to settings:**
Budget is exhausted. A retry will immediately fail for the same reason. The affordance:

- No retry button
- Informational message: "This session hit its cost limit."
- In a future enhancement: link to budget settings

**`error_max_structured_output_retries` — No retry, rephrase suggestion:**
The structured output schema could not be satisfied. Retrying the same prompt will likely fail again. The affordance:

- No retry button
- Suggest rephrasing: "Try a different phrasing or simplify the request."

### Error Message Copy Guidelines

Principles (from Pencil & Paper and Smart Interface Design Patterns):

1. What happened — tied to the user's action, not generic "Error occurred"
2. Why it happened — accessible language, no jargon
3. What to do next — concrete action or honest "nothing can be done"

**Templates per category:**

`error_max_turns`:

> "The agent reached its turn limit."
> Sub-line: "It ran for [N] turns without completing. Start a new session to continue."
> Action: "Start new session" (secondary); no retry

`error_during_execution` (general):

> "The agent stopped due to an error."
> Sub-line: Show `errors[0]` in a collapsed "Details" disclosure
> Action: "Retry" (primary if error does not look like auth issue)

`error_during_execution` (auth/key detected from errors string):

> "Authentication failed. Check your API key in settings."
> Sub-line: none needed
> Action: "Open settings" (primary); no retry

`error_max_budget_usd`:

> "The agent hit its cost limit."
> Sub-line: "Total cost: $[total_cost_usd]. Increase the budget limit to continue."
> Action: none (settings link in future enhancement)

`error_max_structured_output_retries`:

> "The agent couldn't produce the required output format."
> Sub-line: "Try rephrasing your request or using a less complex output structure."
> Action: no retry

**Voice alignment with brand:** Confident, minimal, honest. No apology phrases ("Sorry for the inconvenience"). No vague phrases ("Something went wrong" is acceptable only as last resort). Always tell the user exactly what stopped and what they can do.

---

## Recommended Approach

### Architecture: Add `category` to ErrorEvent

Extend `ErrorEventSchema` with an optional `category` discriminator:

```typescript
export const ErrorCategorySchema = z.enum([
  'max_turns',
  'execution_error',
  'budget_exceeded',
  'output_format_error',
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const ErrorEventSchema = z
  .object({
    message: z.string(),
    code: z.string().optional(),
    category: ErrorCategorySchema.optional(),
  })
  .openapi('ErrorEvent');
```

Mapping in `sdk-event-mapper.ts`:

```typescript
function sdkSubtypeToCategory(subtype: string): ErrorCategory {
  switch (subtype) {
    case 'error_max_turns':
      return 'max_turns';
    case 'error_max_budget_usd':
      return 'budget_exceeded';
    case 'error_max_structured_output_retries':
      return 'output_format_error';
    default:
      return 'execution_error';
  }
}
```

### UI: Inline Error Message (not banner above input)

Render a `ErrorMessageItem` component in the message list timeline, appended after the last assistant message when the stream ends in error. This component:

- Is visually distinct from regular messages (red-tinted left border or icon badge)
- Shows category-appropriate icon + heading + sub-text
- Shows a retry button only for `execution_error` category
- Shows a collapsed `Details` disclosure with the raw `code` and SDK error string
- Does NOT replace the banner; the banner (above input) should be removed in favor of this inline approach

### State: Clear error on next send

The `ChatStatus = 'idle' | 'streaming' | 'error'` already models the three states. When the user submits a new message, error state should clear and status should return to `'idle'` before streaming begins. This already happens implicitly when a new `handleSubmit` is called — verify this in `use-chat-session.ts`.

### Retry: Re-send last user message

For `execution_error` category, the retry action is equivalent to clicking "send" on the last user message again. This can be implemented as:

```typescript
submitContent(lastUserMessage.content);
```

where `lastUserMessage` is the last message in the list with `role === 'user'`.

---

## Error Message Templates (Final)

| Category                          | Heading                      | Sub-text                                                                          | Action               |
| --------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- | -------------------- |
| `max_turns`                       | "Turn limit reached"         | "The agent ran for its maximum number of turns. Start a new session to continue." | "New session" button |
| `execution_error`                 | "Agent stopped unexpectedly" | "An error occurred during execution. [Details]"                                   | "Retry" button       |
| `execution_error` (auth keywords) | "Authentication error"       | "Check your API key in settings."                                                 | "Open settings" link |
| `budget_exceeded`                 | "Cost limit reached"         | "This session exceeded its budget of $X."                                         | None                 |
| `output_format_error`             | "Output format error"        | "The agent couldn't satisfy the required output format. Try rephrasing."          | None                 |

---

## Retry Affordance Design (Summary)

| Category              | Auto-retry | Manual retry | Retry semantics                                  |
| --------------------- | ---------- | ------------ | ------------------------------------------------ |
| `max_turns`           | No         | No           | Turn count won't reset; retry is futile          |
| `execution_error`     | No         | Yes (button) | Re-sends last user message; clears error state   |
| `budget_exceeded`     | No         | No           | Budget is exhausted; retry will immediately fail |
| `output_format_error` | No         | No           | Same prompt will likely produce same failure     |

Auto-retry is not recommended for any of these: they are all result-level terminations, not transient mid-stream failures. The SDK rate limit (`SDKRateLimitEvent`) is handled separately (ADR-0136) and is the appropriate place for auto-retry with backoff.

---

## Implementation Checklist

1. **`packages/shared/src/schemas.ts`** — Add `ErrorCategorySchema` enum; add `category` optional field to `ErrorEventSchema`
2. **`apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`** — Branch `result` handler on `subtype`; yield `error` event with `code` and `category`; yield `done` only for `subtype: 'success'`
3. **`apps/client/src/layers/features/chat/model/stream-event-handler.ts`** — Read `code` and `category` from error event; store both in chat state alongside `message`
4. **`apps/client/src/layers/features/chat/model/chat-types.ts`** — Extend state to carry `errorCategory?: ErrorCategory` and `errorCode?: string` alongside `error: string | null`
5. **`apps/client/src/layers/features/chat/ui/`** — Replace banner div in `ChatPanel.tsx` with an `ErrorMessageItem` component rendered inside `MessageList`; implement category-branched copy and conditional retry button
6. **Tests** — Add `sdk-event-mapper.test.ts` cases for all four error subtypes; add `stream-event-handler` test for error category propagation; add `ChatPanel` test for retry button visibility per category

---

## Research Gaps

- The exact string content of `errors[0]` for each subtype is not publicly documented. The auth-detection heuristic (checking for "authentication", "API key" keywords) is based on SDK source inspection in community issues, not official docs. This should be validated against actual SDK output before shipping.
- Context window overflow during execution (hitting the 200K token limit mid-run) maps to `error_during_execution`, not a distinct subtype. The SDK does not currently distinguish this case at the result level. If the `errors[0]` string contains "context window" or "too many tokens", this could be surfaced as a distinct "Context overflow" category with a "compact and retry" suggestion — but this requires string matching on undocumented error messages.
- No public documentation exists for `error_max_structured_output_retries` triggering conditions or frequency in practice.

---

## Sources & Evidence

- [TypeScript Agent SDK Reference — SDKResultMessage type definition](https://platform.claude.com/docs/en/agent-sdk/typescript) — authoritative source for all four error subtypes and the `errors: string[]` field
- [SDKAssistantMessage error field values](https://platform.claude.com/docs/en/agent-sdk/typescript) — `'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown'`
- [Vercel AI SDK UI: Error Handling — regenerate pattern](https://ai-sdk.dev/docs/ai-sdk-ui/error-handling)
- [Context overflow error messages leaking to chat (OpenClaw issue)](https://github.com/openclaw/openclaw/issues/11317) — "silently retry; only surface if all retries fail" principle
- [Error Message UX, Handling & Feedback](https://www.pencilandpaper.io/articles/ux-pattern-analysis-error-feedback) — inline vs toast vs modal placement; three-layer information architecture
- [Error Messages UX — Smart Interface Design Patterns](https://smart-interface-design-patterns.com/articles/error-messages-ux/) — icon + color, never color alone; recovery affordance taxonomy
- [OpenAI Codex context window overflow issue](https://github.com/openai/codex/issues/3997) — "wasteful retries for context overflow" — confirms that blindly retrying after context overflow is anti-pattern
- [Cursor rate limit error UX patterns](https://apidog.com/blog/fix-api-key-rate-limit-cursor-ai/) — 429 includes retry-after; 529 is server-side; different UX needed per code

## Search Methodology

- Searches performed: 8
- Most productive search terms: "SDK result error subtype", "AI chat interface error message UX 2025", "context window overflow error UX retry affordance", "error categorization taxonomy AI API retryable"
- Primary sources: Anthropic official SDK docs (authoritative), Vercel AI SDK docs (pattern reference), GitHub issues on open-source AI tools (real-world UX problems)
