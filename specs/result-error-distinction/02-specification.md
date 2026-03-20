---
slug: result-error-distinction
number: 138
created: 2026-03-16
status: specified
---

# Result Error/Success Distinction

**Status:** Specified
**Authors:** Claude Code, 2026-03-16
**Ideation:** `specs/result-error-distinction/01-ideation.md`

---

## Overview

The `result` SDK message handler in `sdk-event-mapper.ts:117` treats success and error subtypes identically — both produce `session_status` + `done` StreamEvents. When the SDK signals a failed query (context overflow, turn limit, budget exceeded, execution error), the user sees "Done" instead of an error message. This spec fixes the mapper to distinguish error results, extends the shared schema with error categorization, and renders categorized error messages inline in the chat stream with a retry affordance for transient failures.

## Background / Problem Statement

The Claude Agent SDK emits `result` messages with a `subtype` field that distinguishes `'success'` from four error subtypes: `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, and `error_max_structured_output_retries`. The mapper at `sdk-event-mapper.ts:117-138` never reads `subtype` — it always yields `session_status` + `done`. Error information in `result.errors[]` is silently discarded.

**User impact:** When an agent hits a turn limit, API error, or budget cap, the user sees the session complete normally. No error message, no explanation, no recovery affordance. This is P1 item #5 from the Agent SDK audit.

## Goals

- Distinguish SDK result success from error in the event mapper
- Propagate categorized error details through the `ErrorEventSchema`
- Render errors inline in the assistant message stream (not the existing banner)
- Provide a retry button for `execution_error` (the only retryable category)
- Show collapsible raw error details for debugging
- Keep the existing error banner for transport-level errors (network, SESSION_LOCKED)
- Add comprehensive test coverage for all result subtypes

## Non-Goals

- Rate limit handling (spec #136)
- Extended thinking visibility
- Subagent lifecycle visibility (spec #137)
- Full type safety refactoring of the mapper (`as Record<string, unknown>` cleanup)
- InferenceIndicator "failed" state (nice-to-have, not required)
- Specialized tool renderers

## Technical Dependencies

- `@anthropic-ai/claude-agent-sdk` — provides `SDKMessage` with `result` type and `subtype` field
- `zod` — schema extension for `ErrorEventSchema` and `ErrorPartSchema`
- `motion/react` — animation for collapsible error details
- No new external dependencies required

## Detailed Design

### 1. Schema Changes (`packages/shared/src/schemas.ts`)

#### 1a. Error Category Enum

Add an error category enum after the existing `ErrorEventSchema` (line ~209):

```typescript
export const ErrorCategorySchema = z
  .enum(['max_turns', 'execution_error', 'budget_exceeded', 'output_format_error'])
  .openapi('ErrorCategory');

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
```

#### 1b. Extend ErrorEventSchema

Add `category` and `details` fields to `ErrorEventSchema` (line 202):

```typescript
export const ErrorEventSchema = z
  .object({
    message: z.string(),
    code: z.string().optional(),
    category: ErrorCategorySchema.optional(),
    details: z.string().optional(),
  })
  .openapi('ErrorEvent');
```

- `category` — one of the four error categories, used by the client to select heading/copy/action
- `details` — raw error text from `result.errors[]` for the collapsible details disclosure

#### 1c. Add ErrorPartSchema

Add a new `ErrorPartSchema` to the Message Part Types section (after `SubagentPartSchema`, line ~415):

```typescript
export const ErrorPartSchema = z
  .object({
    type: z.literal('error'),
    message: z.string(),
    category: ErrorCategorySchema.optional(),
    details: z.string().optional(),
  })
  .openapi('ErrorPart');

export type ErrorPart = z.infer<typeof ErrorPartSchema>;
```

#### 1d. Extend MessagePartSchema

Add `ErrorPartSchema` to the discriminated union (line 417):

```typescript
export const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  SubagentPartSchema,
  ErrorPartSchema,
]);
```

### 2. Server Mapper Changes (`apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`)

#### 2a. Error Category Mapping

Add a helper function before the `mapSdkMessage` generator (or at module scope):

```typescript
/** Map SDK result subtypes to user-facing error categories. */
function mapErrorCategory(subtype: string): ErrorCategory {
  switch (subtype) {
    case 'error_max_turns':
      return 'max_turns';
    case 'error_during_execution':
      return 'execution_error';
    case 'error_max_budget_usd':
      return 'budget_exceeded';
    case 'error_max_structured_output_retries':
      return 'output_format_error';
    default:
      return 'execution_error';
  }
}
```

#### 2b. Result Handler Branch

Replace the result handler (lines 117-138) with error/success branching:

```typescript
if (message.type === 'result') {
  const result = message as Record<string, unknown>;
  const usage = result.usage as Record<string, unknown> | undefined;
  const modelUsageMap = result.modelUsage as
    | Record<string, Record<string, unknown>>
    | undefined;
  const firstModelUsage = modelUsageMap ? Object.values(modelUsageMap)[0] : undefined;

  // Always emit session_status with final cost/token/model data
  yield {
    type: 'session_status',
    data: {
      sessionId,
      model: result.model as string | undefined,
      costUsd: result.total_cost_usd as number | undefined,
      contextTokens: usage?.input_tokens as number | undefined,
      contextMaxTokens: firstModelUsage?.contextWindow as number | undefined,
    },
  };

  // Emit error event if the result is an error subtype
  const subtype = result.subtype as string | undefined;
  if (subtype && subtype !== 'success') {
    const errors = result.errors as string[] | undefined;
    const category = mapErrorCategory(subtype);
    yield {
      type: 'error',
      data: {
        message: errors?.[0] ?? 'An unexpected error occurred.',
        code: subtype,
        category,
        details: errors?.join('\n'),
      },
    };
  }

  // Always emit done to trigger client cleanup
  yield {
    type: 'done',
    data: { sessionId },
  };
}
```

**Key design decisions:**

- `session_status` always emits first — even failed queries have cost/token data worth capturing
- `error` emits between `session_status` and `done` — the client needs error info before cleanup
- `done` always emits — it resets streaming state (timers, token counters, text streaming flag) and this cleanup is required regardless of success/error
- `subtype !== 'success'` catches all four error subtypes plus any future ones (defensive)

### 3. Client Stream Event Handler Changes (`apps/client/src/layers/features/chat/model/stream-event-handler.ts`)

#### 3a. Modify Error Case

Update the `'error'` case (line 276) to append an `ErrorPart` to the current assistant message AND set the banner error state (for backward compatibility with transport errors that don't have parts):

```typescript
case 'error': {
  const errorData = data as ErrorEvent;
  // For categorized SDK errors, render inline in the message stream
  if (errorData.category) {
    currentPartsRef.current.push({
      type: 'error',
      message: errorData.message,
      category: errorData.category,
      details: errorData.details,
    });
    updateAssistantMessage(assistantId);
  } else {
    // Transport-level errors without category — use existing banner
    setError(errorData.message);
  }
  setStatus('error');
  break;
}
```

**Why this works:** SDK result errors always have `category` (set by the mapper). Transport errors from the `catch` block in `use-chat-session.ts` don't go through the stream event handler at all — they call `setError()` directly. The `category` check cleanly separates the two paths.

### 4. New Component: ErrorMessageBlock (`apps/client/src/layers/features/chat/ui/ErrorMessageBlock.tsx`)

Create a new component in the chat feature's `ui/` directory:

```typescript
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertCircle, ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { ErrorCategory } from '@dorkos/shared/types';

/** User-facing copy for each error category. */
const ERROR_COPY: Record<ErrorCategory, { heading: string; description: string }> = {
  max_turns: {
    heading: 'Turn limit reached',
    description: 'The agent ran for its maximum number of turns.',
  },
  execution_error: {
    heading: 'Agent stopped unexpectedly',
    description: 'An error occurred during execution.',
  },
  budget_exceeded: {
    heading: 'Cost limit reached',
    description: 'This session exceeded its budget.',
  },
  output_format_error: {
    heading: 'Output format error',
    description: "The agent couldn't produce the required output format.",
  },
};

/** Whether an error category supports retry. */
const RETRYABLE_CATEGORIES: Set<ErrorCategory> = new Set(['execution_error']);

interface ErrorMessageBlockProps {
  category?: ErrorCategory;
  message: string;
  details?: string;
  onRetry?: () => void;
}

/**
 * Inline error block rendered in the assistant message stream.
 * Shows category-specific heading, description, optional retry button,
 * and collapsible raw error details.
 */
export function ErrorMessageBlock({ category, message, details, onRetry }: ErrorMessageBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const copy = category ? ERROR_COPY[category] : null;
  const canRetry = category && RETRYABLE_CATEGORIES.has(category) && onRetry;

  return (
    <div className="my-2 rounded-xl border border-red-500/20 bg-red-500/5 p-4 dark:border-red-400/20 dark:bg-red-400/5">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500 dark:text-red-400" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            {copy?.heading ?? 'Error'}
          </p>
          <p className="text-sm text-muted-foreground">
            {copy?.description ?? message}
          </p>

          {/* Collapsible details */}
          {details && (
            <button
              type="button"
              onClick={() => setDetailsOpen(!detailsOpen)}
              className="mt-2 flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground"
            >
              <ChevronDown
                className={cn('size-3 transition-transform', detailsOpen && 'rotate-180')}
              />
              Details
            </button>
          )}
          <AnimatePresence>
            {detailsOpen && details && (
              <motion.pre
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                className="overflow-hidden whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs text-muted-foreground"
              >
                {details}
              </motion.pre>
            )}
          </AnimatePresence>

          {/* Retry button */}
          {canRetry && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="mt-3 gap-1.5"
            >
              <RotateCcw className="size-3.5" />
              Retry
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Design system compliance:**

- `rounded-xl` (16px card radius per design system)
- `p-4` (16px padding, on 8pt grid)
- `my-2` (8px vertical margin)
- `text-sm` for body text, `text-xs` for details
- Muted red tint via `bg-red-500/5` — subtle, not alarming
- `border-red-500/20` — visible but not dominant
- Dark mode variants with `dark:` prefix
- Motion animation for collapsible details using project's `motion/react` library
- Lucide icons (already used throughout the client)

### 5. AssistantMessageContent Changes (`apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`)

#### 5a. Import ErrorMessageBlock

Add import at top of file:

```typescript
import { ErrorMessageBlock } from '../ErrorMessageBlock';
```

#### 5b. Add Error Part Rendering

In the `parts.map()` render loop (line ~118), add a branch for `part.type === 'error'` before the subagent check:

```typescript
if (part.type === 'error') {
  return (
    <ErrorMessageBlock
      key={`error-${i}`}
      category={part.category}
      message={part.message}
      details={part.details}
      onRetry={onRetry}
    />
  );
}
```

#### 5c. Thread onRetry Prop

`AssistantMessageContent` needs access to the retry function. Get it from `MessageContext`:

```typescript
const {
  sessionId,
  isStreaming,
  activeToolCallId,
  onToolRef,
  focusedOptionIndex,
  onToolDecided,
  onRetry,
} = useMessageContext();
```

This requires adding `onRetry` to the `MessageContext` type and threading it from `ChatPanel` → `MessageList` → `MessageContext`.

**`onRetry` implementation in ChatPanel:**

```typescript
const lastUserMessage = useMemo(
  () => [...messages].reverse().find((m) => m.role === 'user'),
  [messages]
);

const handleRetry = useCallback(() => {
  if (lastUserMessage?.content) {
    void submitContent(lastUserMessage.content);
  }
}, [lastUserMessage, submitContent]);
```

Pass `handleRetry` into the message context provider. The `ErrorMessageBlock` receives it via the rendering chain and only shows the retry button for `execution_error` category.

### 6. Summary of Error Flow Paths

After this change, there are two distinct error display paths:

| Error Source                   | Path                                                                                                                                            | Display                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| SDK result error               | `sdk-event-mapper` → `error` StreamEvent (with `category`) → `stream-event-handler` → `ErrorPart` in message parts → `ErrorMessageBlock` inline | Inline in message stream               |
| Transport error (network, SSE) | `use-chat-session.ts` catch block → `setError()` → `ChatPanel` banner                                                                           | Banner above input                     |
| SESSION_LOCKED                 | `use-chat-session.ts` catch block → `setSessionBusy()` → busy indicator                                                                         | Session busy indicator (3s auto-clear) |

## User Experience

### Success Path (unchanged)

Agent completes → "Done" state → session status shows cost/tokens → input re-enables.

### Error Path (new)

Agent fails → inline error block appears at the end of the assistant message:

- Red-tinted card with icon + category heading + description
- Collapsible "Details" disclosure with raw error text
- "Retry" button (only for `execution_error`)
- Session status still shows cost/tokens (partial work was done)
- Input re-enables (user can send a new message or click Retry)

### Category-Specific UX

| Category              | What User Sees                         | Available Actions                            |
| --------------------- | -------------------------------------- | -------------------------------------------- |
| `max_turns`           | "Turn limit reached" — muted red card  | Send new message, start new session          |
| `execution_error`     | "Agent stopped unexpectedly" + details | **Retry button**, send new message           |
| `budget_exceeded`     | "Cost limit reached"                   | Send new message (budget resets per session) |
| `output_format_error` | "Output format error"                  | Send new message with different phrasing     |

## Testing Strategy

### Unit Tests: SDK Event Mapper (`sdk-event-mapper.test.ts`)

Add a new `describe('result messages')` block:

**Test 1: Success result yields session_status + done**

```typescript
it('yields session_status and done for success result', async () => {
  const events = await collectEvents(
    makeResultMessage('success'),
    SESSION_ID,
    makeSession(),
    makeToolState()
  );
  expect(events).toHaveLength(2);
  expect(events[0].type).toBe('session_status');
  expect(events[1].type).toBe('done');
});
```

**Test 2: Error result yields session_status + error + done**

```typescript
it('yields session_status, error, and done for error result', async () => {
  const events = await collectEvents(
    makeResultMessage('error_during_execution', ['API overloaded']),
    SESSION_ID,
    makeSession(),
    makeToolState()
  );
  expect(events).toHaveLength(3);
  expect(events[0].type).toBe('session_status');
  expect(events[1]).toMatchObject({
    type: 'error',
    data: {
      message: 'API overloaded',
      code: 'error_during_execution',
      category: 'execution_error',
      details: 'API overloaded',
    },
  });
  expect(events[2].type).toBe('done');
});
```

**Test 3-5: One test per remaining error subtype** (`error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`) — verify correct category mapping.

**Test 6: Error result with no errors array**

```typescript
it('uses fallback message when errors array is empty', async () => {
  const events = await collectEvents(
    makeResultMessage('error_during_execution', []),
    SESSION_ID,
    makeSession(),
    makeToolState()
  );
  const errorEvent = events.find((e) => e.type === 'error');
  expect((errorEvent?.data as ErrorEvent).message).toBe('An unexpected error occurred.');
});
```

**Test 7: Session status includes cost/tokens even on error**

```typescript
it('includes session status data even when result is error', async () => {
  const events = await collectEvents(
    makeResultMessage('error_max_turns', ['Max turns']),
    SESSION_ID,
    makeSession(),
    makeToolState()
  );
  const statusEvent = events[0];
  expect((statusEvent.data as SessionStatusEvent).costUsd).toBeDefined();
});
```

Add a `makeResultMessage` helper to the test file (or to `sdk-scenarios.ts`):

```typescript
function makeResultMessage(subtype: string, errors?: string[]): SDKMessage {
  return {
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    errors: errors ?? [],
    model: 'claude-sonnet-4-6',
    total_cost_usd: 0.001,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } },
    session_id: SESSION_ID,
  } as SDKMessage;
}
```

### Unit Tests: Stream Event Handler

**Test: Categorized error appends ErrorPart to message parts**

- Send an `error` event with `category: 'execution_error'`
- Verify an `ErrorPart` is appended to the current assistant message's parts
- Verify `setError()` is NOT called (no banner)
- Verify `setStatus('error')` IS called

**Test: Uncategorized error sets banner state**

- Send an `error` event without `category`
- Verify `setError()` IS called
- Verify no `ErrorPart` is appended

### Component Tests: ErrorMessageBlock

**Test: Renders category heading and description**

- Render with `category: 'max_turns'`
- Verify "Turn limit reached" heading and description text

**Test: Shows retry button only for execution_error**

- Render with `category: 'execution_error'` and `onRetry` prop
- Verify retry button is present
- Render with `category: 'max_turns'` and `onRetry` prop
- Verify retry button is NOT present

**Test: Collapsible details**

- Render with `details: 'raw error text'`
- Verify details are hidden by default
- Click "Details" button
- Verify details are visible

**Test: Retry button calls onRetry**

- Render with `category: 'execution_error'` and mock `onRetry`
- Click retry button
- Verify `onRetry` was called

## Performance Considerations

- **Minimal impact.** The mapper change adds one string comparison (`subtype !== 'success'`) to the result handler — negligible.
- **ErrorMessageBlock is lightweight.** No virtualization needed — at most one error part per message.
- **The `details` collapsible uses `AnimatePresence` with `height: 'auto'`** — same pattern used by existing ToolCallCard expand/collapse.

## Security Considerations

- **Error messages from SDK are displayed to the user.** The `details` field contains raw error strings from the SDK's `errors[]` array. These should not contain secrets, but we render them in a `<pre>` tag (not as HTML) to prevent injection.
- **No new user input surfaces.** The retry button re-sends an existing user message — no new input vector.

## Documentation

- Update `contributing/api-reference.md` if `ErrorEventSchema` changes affect the OpenAPI spec
- The `ErrorCategory` type and `ErrorPartSchema` will be auto-documented via Zod's `.openapi()` annotations

## Implementation Phases

### Phase 1: Full Implementation (Single Phase)

All changes ship together — the scope is small enough for a single phase:

1. **Schema** — Add `ErrorCategorySchema`, extend `ErrorEventSchema`, add `ErrorPartSchema`, update `MessagePartSchema`
2. **Server mapper** — Add `mapErrorCategory` helper, branch on `subtype` in result handler
3. **Client handler** — Update error case to append `ErrorPart` for categorized errors
4. **ErrorMessageBlock component** — New component with category-specific copy, retry button, collapsible details
5. **AssistantMessageContent** — Add error part rendering branch, thread `onRetry`
6. **Tests** — Mapper tests for all subtypes, handler test, component tests

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

- **ADR-0043**: Agent storage (file-first pattern) — not directly related but establishes the "source of truth" design philosophy
- **ADR-0136**: Rate limit as distinct stream event — parallel work that adds a similar new event type; coordinate to avoid merge conflicts in `schemas.ts`

## References

- Ideation: `specs/result-error-distinction/01-ideation.md`
- Audit: `.temp/agent-sdk-audit.md` (matrix item #4)
- Research: `research/20260316_sdk_result_error_ux_patterns.md`
- Rate limit spec: `specs/handle-rate-limit-event/02-specification.md` (parallel pattern)
- SDK scenarios: `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts` (lines 190-209, existing error result builder)
