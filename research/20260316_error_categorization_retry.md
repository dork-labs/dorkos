---
title: 'Error Categorization and Retry Affordance — Chat UI Best Practices and Implementation Recommendation'
date: 2026-03-16
type: implementation
status: active
tags: [error-handling, retry, chat-ui, ux, streaming, sse, error-categorization, inline-errors]
feature_slug: error-categorization-retry
searches_performed: 0
sources_count: 1
---

# Error Categorization and Retry Affordance

## Research Summary

A full prior-art research report exists at `research/20260316_sdk_result_error_ux_patterns.md` and
covers this topic exhaustively. The codebase has already absorbed the foundational changes described
there: `ErrorCategorySchema` and `ErrorPartSchema` are live in `packages/shared/src/schemas.ts`, and
`stream-event-handler.ts` branches on `errorData.category` to route SDK result errors inline (as
`ErrorPart` in the message stream) vs transport-level errors to the banner. This report synthesizes
those findings into the three-part answer requested (Potential Solutions, Considerations, Recommendation)
and adds a direct code-state audit.

---

## Current State (Source-Verified, 2026-03-16)

### What is already implemented

**`packages/shared/src/schemas.ts` (lines 223–238, 476–485)**

```typescript
export const ErrorCategorySchema = z
  .enum(['max_turns', 'execution_error', 'budget_exceeded', 'output_format_error'])
  .openapi('ErrorCategory');

export const ErrorEventSchema = z
  .object({
    message: z.string(),
    code: z.string().optional(),
    category: ErrorCategorySchema.optional(),
    details: z.string().optional(),
  })
  .openapi('ErrorEvent');

export const ErrorPartSchema = z
  .object({
    type: z.literal('error'),
    message: z.string(),
    category: ErrorCategorySchema.optional(),
    details: z.string().optional(),
  })
  .openapi('ErrorPart');
```

`ErrorPart` is included in the `MessagePartSchema` discriminated union — the data model is fully
wired for inline error parts in assistant messages.

**`apps/client/src/layers/features/chat/model/stream-event-handler.ts` (lines 337–355)**

```typescript
case 'error': {
  const errorData = data as ErrorEvent;
  // SDK result errors with a category render inline in the message stream
  if (errorData.category) {
    currentPartsRef.current.push({
      type: 'error',
      message: errorData.message,
      category: errorData.category,
      details: errorData.details,
    });
    updateAssistantMessage(assistantId);
  } else {
    // Transport-level errors (no category) use the banner
    setError(errorData.message);
  }
  setStatus('error');
  break;
}
```

The routing logic is correct: categorized errors become inline `ErrorPart` nodes; uncategorized
errors fall back to the existing banner.

### What is NOT yet implemented

1. **`ErrorMessageBlock` UI component** — `ErrorPart` items in the `parts` array are not yet
   rendered in `AssistantMessageContent.tsx`. No component exists to display them with category-
   appropriate copy, icons, or a retry button.

2. **Retry action** — there is no `handleRetry` callback wired from `useChatSession` to the UI.
   When status is `'error'`, the chat input is blocked but no affordance lets the user re-send
   the last message without re-typing it.

3. **Server-side `sdk-event-mapper.ts` branching** — the server mapper that reads `SDKResultMessage`
   subtypes may not yet be emitting `error` events with `category` populated. This is the upstream
   gate; without it, the client-side routing in `stream-event-handler.ts` never fires for SDK result
   errors (it only fires if the event arrives with a `category` field set).

These three gaps are the entire remaining implementation surface.

---

## Potential Solutions

### Approach 1: Inline Error Message Block (Recommended)

Render a distinct `ErrorMessageBlock` component inside the existing `MessagePart` render switch in
`AssistantMessageContent.tsx`. The component appears at the end of the assistant message stream,
exactly where the failure happened.

**Structure:**

```
┌─────────────────────────────────────────────────────┐
│  ⚠  Agent stopped unexpectedly                      │
│     An error occurred during execution.             │
│     ▶ Details  (collapsed disclosure)               │
│                                                     │
│  [ Retry ]                                          │
└─────────────────────────────────────────────────────┘
```

- Left border accent in `text-destructive` / `border-destructive/30` using existing DorkOS token
- Lucide icon (`AlertCircle`, `Hash`, `DollarSign`, `FileWarning`) per category
- Heading + sub-text copy per category (see taxonomy below)
- Retry button only for `execution_error`
- `<details>` / shadcn `Collapsible` for raw error message (`details` field)
- No banner above input for SDK result errors; banner reserved for infrastructure errors only

**Pros:**

- Error stays visible as user scrolls (banner above input disappears when list scrolls)
- Error is co-located with the turn that failed — user immediately understands context
- Retry button is adjacent to the error — no cognitive distance
- Matches ChatGPT, GitHub Copilot, and Cursor's established pattern
- Leverages the `ErrorPart` data model already in place

**Cons:**

- Requires a new component (`ErrorMessageBlock`) and its integration into the part renderer
- Adds complexity to `AssistantMessageContent.tsx` (though isolated to a new `case 'error':` branch)

**Complexity:** Low–medium. ~80 lines of new component code; ~5 lines integrating it.

---

### Approach 2: Banner Above Input (Current Pattern, Enhanced)

Keep the existing `<div>` banner in `ChatPanel.tsx` but upgrade it to branch on `errorCategory`
state, show a retry button, and use category-appropriate copy.

**Pros:**

- Minimal structural change — only extends existing code
- Banner placement is familiar (toasts and banners above the input box are a common pattern)

**Cons:**

- Banner disappears from view when the user scrolls up to re-read the conversation
- No visual connection between the error and the turn that failed
- Mixing infrastructure errors (banner) and SDK result errors (also banner) muddies the signal
  — rate limit messages, connection failures, and context overflow all look identical
- The `errorCategory` must be stored separately in chat state since the banner path currently
  only stores `error: string | null`; chat-types must be extended
- Banner-above-input is the pattern DorkOS already has and is the exact thing users complain
  about (opaque, no retry)

**Complexity:** Low (fewer structural changes), but semantically weaker.

---

### Approach 3: Toast Notification

Use shadcn `Sonner` (already in the project) to fire a toast for session-terminating errors.

**Pros:**

- Zero layout changes; works with existing infrastructure

**Cons:**

- Toasts are auto-dismissing — error disappears after a few seconds
- Toasts are semantically "non-blocking informational notifications," not terminal failures
- No persistent retry affordance
- Violates the principle that session-terminating errors are not transient
- Industry consensus (Smart Interface Design Patterns, Pencil & Paper UX research) explicitly
  recommends against toasts for actionable errors requiring user recovery

**Complexity:** Lowest to implement; highest UX cost.

---

### Approach 4: Hybrid — Inline Message + Restored Input (Best UX)

Approach 1 (inline `ErrorMessageBlock`) combined with restoring the user's last message to the
input box on `execution_error` so they can edit and re-send without a separate retry button.

**Mechanism:**

- On `setStatus('error')` for `execution_error`, also call `setDraftContent(lastUserMessage.content)`
  to pre-populate the input
- The inline `ErrorMessageBlock` shows the error but no explicit "Retry" button — the restored
  input IS the retry affordance (user clicks Send or presses Enter)
- For categories without retry (`max_turns`, `budget_exceeded`, `output_format_error`), the input
  stays empty as today

**Pros:**

- The recovered draft is the most natural retry mechanism — the user can edit before re-sending
- Eliminates a dedicated Retry button (follows "less, but better" — Dieter Rams principle)
- Inline message still provides the error explanation and context

**Cons:**

- Restoring draft requires threading `lastUserMessage.content` from `useChatSession` to `ChatInput`
- The input must be enabled even when `status === 'error'` for this to work (currently blocked)
- The UX contract changes: the user must re-send, not just click a single Retry button

**Complexity:** Medium — requires `useChatSession` to track draft restoration on error, and
`ChatInput` to accept/render a restored draft value.

---

## Error Categorization Taxonomy

### Category Definitions

| Category              | SDK Trigger                                                          | User Experience                                                |
| --------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `max_turns`           | `SDKResultMessage.subtype === 'error_max_turns'`                     | Agent ran out of turns — config-limited, not a failure         |
| `execution_error`     | `SDKResultMessage.subtype === 'error_during_execution'`              | Runtime exception — API error, server fault, permission denial |
| `budget_exceeded`     | `SDKResultMessage.subtype === 'error_max_budget_usd'`                | Cost limit hit — config-limited                                |
| `output_format_error` | `SDKResultMessage.subtype === 'error_max_structured_output_retries'` | Structured output schema could not be satisfied                |

Additionally, `SDKAssistantMessage.error` can carry mid-stream errors (`'authentication_failed'`,
`'billing_error'`, `'rate_limit'`, `'invalid_request'`, `'server_error'`, `'unknown'`). These map
to `execution_error` for display purposes, with auth-keyword heuristic for the authentication sub-case.

### Retryability

| Category              | Auto-retry | Manual retry | Rationale                                       |
| --------------------- | ---------- | ------------ | ----------------------------------------------- |
| `max_turns`           | No         | No           | Retrying hits the same turn limit immediately   |
| `execution_error`     | No         | Yes          | Transient server errors may clear; user decides |
| `budget_exceeded`     | No         | No           | Budget is exhausted; retry fails immediately    |
| `output_format_error` | No         | No           | Same prompt will produce same schema failure    |

**Why no auto-retry for any category:** These are all `result`-level terminations, not transient
mid-stream blips. The `rate_limit` stream event (handled separately via ADR-0136) is the correct
place for backoff-and-retry. Auto-retrying a terminated session would spawn a new SDK run silently,
which violates the "honest by design" principle — users must consent to re-runs.

### Copy Templates (Brand-Aligned)

Confident, minimal, technical — no apology language, no marketing phrases.

| Category                          | Heading                      | Sub-text                                                                          | Action                                   |
| --------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------- |
| `max_turns`                       | "Turn limit reached"         | "The agent ran for its maximum number of turns. Start a new session to continue." | None (or "New session" secondary button) |
| `execution_error` (general)       | "Agent stopped unexpectedly" | "An error occurred during execution." + `[Details]` collapsible                   | "Retry" button (or restored input draft) |
| `execution_error` (auth detected) | "Authentication error"       | "Check your API key in settings."                                                 | "Open settings" link                     |
| `budget_exceeded`                 | "Cost limit reached"         | "This session exceeded its budget of $X."                                         | None                                     |
| `output_format_error`             | "Output format error"        | "The agent couldn't satisfy the required output format. Try rephrasing."          | None                                     |

Auth detection heuristic: if `details` or `message` contains any of `['authentication', 'api key',
'invalid key', 'unauthorized', '401']` (case-insensitive), render the auth sub-variant.

### Visual System

| Category                 | Icon (Lucide) | Color token                                                          |
| ------------------------ | ------------- | -------------------------------------------------------------------- |
| `max_turns`              | `Hash`        | `text-muted-foreground` / `border-border` — informational, not error |
| `execution_error`        | `AlertCircle` | `text-destructive` / `border-destructive/30`                         |
| `execution_error` (auth) | `KeyRound`    | `text-destructive` / `border-destructive/30`                         |
| `budget_exceeded`        | `DollarSign`  | `text-warning` / `border-warning/30` (amber)                         |
| `output_format_error`    | `FileWarning` | `text-muted-foreground` / `border-border` — informational            |

**Never color alone** — icon + color together, per WCAG and smart interface design patterns.

---

## Security and Performance Considerations

### Raw Error String Exposure

The `details` field (SDK `errors[0]` string) may contain sensitive information: API key fragments,
internal endpoint URLs, internal error codes. Display only in a collapsed `<details>` disclosure
that the user must explicitly expand. Never log to analytics or structured telemetry.

### Retry Debounce

Manual retry should be debounced (500ms min) to prevent accidental double-sends from rapid
clicking. The retry fires `submitContent(lastUserMessage.content)` — no separate API call needed.

### Status Recovery After Error

`setStatus('error')` blocks new sends. The existing `handleSubmit` path already resets status
to `'streaming'` on new send — no explicit "clear error" action needed before retry. Verify this
holds when retry calls `submitContent` directly (bypassing `handleSubmit`'s status reset).

### SSE Stream Cleanup

On retry, the previous SSE connection must be fully closed before opening a new one. The existing
`abortControllerRef.current?.abort()` call at the top of `executeSubmission` handles this.
No additional cleanup needed.

### Context Overflow Ambiguity

Context window overflow during execution maps to `error_during_execution`, not a distinct subtype.
If `details` contains "context window" or "too many tokens", a context-specific message ("The
conversation context is too long. Compact the session before continuing.") is preferable over the
generic execution error copy. This is a heuristic — validate against actual SDK error strings
before shipping.

### Performance: No Cost to Inline Rendering

`ErrorPart` is pushed to `currentPartsRef` once, at session termination. No per-event processing
overhead. The `updateAssistantMessage` call after pushing triggers a single React re-render.
No streaming impact.

---

## Recommendation

### Chosen Approach: Approach 1 (Inline `ErrorMessageBlock`) with Approach 4's Input Restoration

**Inline error message in the assistant turn** is the correct placement — consistent with
industry practice (ChatGPT, GitHub Copilot, Cursor), persistent on scroll, co-located with
the failed turn. The `ErrorPart` data model is already in place.

**Input restoration on `execution_error`** is the recommended retry mechanism over an explicit
Retry button. It is more honest (user sees what they're resending and can edit it), aligns with
the "less, but better" design language, and avoids a dedicated Retry button that implies a
single correct recovery path when the user may want to modify the prompt.

**Retain the banner** for transport-level errors that don't have a `category` — these represent
infrastructure failures (connection lost, session locked) that are not turn-specific and belong
above the input.

### Full Implementation Checklist

1. **`apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`**
   - Branch the `result` handler on `subtype`
   - Yield `{ type: 'error', data: { message, code: subtype, category, details: errors[0] } }` for all four error subtypes
   - Yield `{ type: 'done' }` only for `subtype === 'success'`
   - Map `SDKAssistantMessage.error` field to `execution_error` category mid-stream

2. **`apps/client/src/layers/features/chat/ui/message/ErrorMessageBlock.tsx`** (new file)
   - Props: `{ message: string; category: ErrorCategory; details?: string; onRetry?: () => void }`
   - Render heading + sub-text from copy table
   - Render Lucide icon per category
   - Render Retry button if `onRetry` is defined AND category is `execution_error`
   - Render `<Collapsible>` with `details` field if present
   - Auth detection heuristic on `message`/`details` to switch to auth sub-variant

3. **`apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`**
   - Add `case 'error':` branch in the parts render switch
   - Pass `onRetry` callback from parent (only for `execution_error` category)

4. **`apps/client/src/layers/features/chat/model/chat-types.ts`**
   - Add `lastUserMessage: string | null` to chat state (needed for retry)
   - Populated in `executeSubmission` just before the POST fires

5. **`apps/client/src/layers/features/chat/model/use-chat-session.ts`**
   - Track `lastUserMessage` in state
   - Expose `handleRetry` or draft-restoration callback alongside the chat state
   - On `execution_error`, restore draft to `lastUserMessage` content

6. **Tests**
   - `sdk-event-mapper.test.ts`: cases for all four error subtypes emitting correct `category`
   - `stream-event-handler.test.ts`: categorized error pushes `ErrorPart`; uncategorized uses banner
   - `ErrorMessageBlock.test.tsx`: renders correct copy and retry visibility per category
   - `AssistantMessageContent.test.tsx`: `ErrorPart` renders `ErrorMessageBlock`

### What NOT to Build

- No auto-retry for any category (violates "honest by design" — user must consent to re-runs)
- No toast for session-terminating errors (toasts are for transient, self-resolving events)
- No modal for errors (overkill for recoverable state, adds unnecessary blocking UX)
- No "New session" button on `max_turns` in this iteration — the error copy ("Start a new session
  to continue") is sufficient; wiring a button adds scope without clear demand signal

---

## Contradictions and Disputes

None. The prior research (`20260316_sdk_result_error_ux_patterns.md`), current schema state, and
industry UX patterns are fully consistent. The only design choice with room for debate is
"Retry button" vs "restored input draft" for `execution_error`. The restored draft approach wins
on the "less, but better" filter and the "honest by design" filter — but the explicit Retry button
is also defensible if the team prefers discoverability over minimalism.

---

## Research Gaps

- **SDK `errors[0]` string content for each subtype is not officially documented.** The auth
  detection heuristic (`['authentication', 'api key', 'invalid key', 'unauthorized', '401']`)
  should be validated by running actual error scenarios before shipping. A false negative (auth
  error not detected) shows a Retry button that will fail; a false positive (non-auth error
  detected as auth) hides the Retry button unnecessarily. The false negative is the more harmful
  case.

- **Context overflow string content is not documented.** Treat `error_during_execution` generically
  until actual SDK output is captured and the strings are confirmed.

- **`error_max_structured_output_retries` trigger frequency is unknown in practice.** Low priority
  for initial implementation — handle it correctly but do not optimize for it.

---

## Sources

- `research/20260316_sdk_result_error_ux_patterns.md` — full prior-art research covering SDK error
  subtypes, industry UX patterns (ChatGPT, GitHub Copilot, Cursor, Vercel AI SDK), error display
  placement taxonomy, and copy guidelines
- `packages/shared/src/schemas.ts` (source-read) — confirmed `ErrorCategorySchema`, `ErrorPartSchema`,
  `ErrorEventSchema` with `category` field are live
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (source-read) — confirmed
  `case 'error'` branching on `errorData.category`; inline path for categorized errors; banner path
  for uncategorized errors
