---
slug: tool-progress-streaming
number: 139
created: 2026-03-16
status: specified
---

# Tool Progress Streaming — Specification

## Overview

Handle `tool_progress` SDK messages that are currently silently dropped by `sdk-event-mapper.ts`. When Claude executes long-running tools (Bash commands, file searches, large reads), the SDK emits `tool_progress` events with intermediate text output. This spec maps those events through the full pipeline — server mapper → shared schemas → client handler → ToolCallCard UI — so users see progressive tool output instead of a static spinner.

**Audit reference:** Matrix item #8 in `.temp/agent-sdk-audit.md` (P1 — tool progress invisible).

## Technical Design

### Architecture

The change follows the established SDK → StreamEvent → client pipeline:

```
SDK: tool_progress { tool_use_id, content }
  ↓
Server: sdk-event-mapper.ts yields { type: 'tool_progress', data: { toolCallId, content } }
  ↓
Transport: SSE delivers event to client
  ↓
Client: stream-event-handler.ts finds matching ToolCallPart, appends to progressOutput
  ↓
UI: ToolCallCard auto-expands and renders streaming monospace output (truncated at ~5KB)
```

### Event Design

**New StreamEvent type: `tool_progress`**

A dedicated event type (not extending `tool_call_delta`) for semantic clarity. Follows the precedent set by `subagent_started`/`subagent_progress`/`subagent_done` — each distinct lifecycle concern gets its own event type.

**New Zod schema: `ToolProgressEventSchema`**

```typescript
export const ToolProgressEventSchema = z
  .object({
    toolCallId: z.string(),
    content: z.string(),
  })
  .openapi('ToolProgressEvent');
```

**New field on `ToolCallPartSchema`: `progressOutput`**

```typescript
progressOutput: z.string().optional();
```

Accumulates intermediate output during tool execution. Cleared when `tool_result` arrives (result replaces progress).

### Result Transition

When `tool_result` arrives for a tool call that has `progressOutput`:

1. Set `result` to the tool_result value
2. Clear `progressOutput` (set to `undefined`)
3. The result becomes the canonical display — progress was a preview

This keeps the final state clean and avoids showing redundant content (SDK results typically contain the same output that was streamed via progress).

### Auto-Expand Behavior

When the first `tool_progress` event arrives for a tool call:

- The ToolCallCard auto-expands to show the streaming output
- Progress renders in a scrollable monospace `<pre>` block (same styling as result)
- After completion, normal auto-hide behavior applies (if enabled)

### Truncation

Progress output is truncated at 5,120 bytes (~5KB) in the UI:

- Display the first 5KB of accumulated output
- Show a "Show full output ({size})" disclosure below the truncated preview
- Clicking expands to show all output (still in monospace `<pre>`)
- Truncation is UI-only — the full `progressOutput` string is preserved in state

This prevents the browser freeze risk identified in audit P2 #1 from affecting progress output.

## Implementation Phases

### Phase 1: Shared Schemas (`packages/shared/src/schemas.ts`)

**1a. Add `tool_progress` to `StreamEventTypeSchema` enum**

Add `'tool_progress'` to the enum array (after `'tool_result'`, before `'approval_required'`).

**1b. Add `ToolProgressEventSchema`**

Define the new schema after `ToolCallEventSchema`:

```typescript
export const ToolProgressEventSchema = z
  .object({
    toolCallId: z.string(),
    content: z.string(),
  })
  .openapi('ToolProgressEvent');

export type ToolProgressEvent = z.infer<typeof ToolProgressEventSchema>;
```

**1c. Add `ToolProgressEventSchema` to `StreamEventSchema` data union**

Add `ToolProgressEventSchema` to the `z.union([...])` array in `StreamEventSchema`.

**1d. Add `progressOutput` field to `ToolCallPartSchema`**

Add `progressOutput: z.string().optional()` to the `ToolCallPartSchema` object.

**1e. Add `progressOutput` field to `HistoryToolCallSchema`**

Add `progressOutput: z.string().optional()` for history consistency. (Progress output isn't persisted in JSONL, but the schema should be symmetric.)

### Phase 2: Server Mapper (`apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`)

**2a. Add `tool_progress` branch**

After the `tool_use_summary` handler (line 114) and before the `result` handler (line 117), add:

```typescript
// Handle tool progress (intermediate output from long-running tools)
if (message.type === 'tool_progress') {
  const progress = message as { tool_use_id: string; content: string };
  yield {
    type: 'tool_progress',
    data: {
      toolCallId: progress.tool_use_id,
      content: progress.content,
    },
  };
  return;
}
```

This is a direct mapping — no state tracking needed. The `tool_use_id` maps to `toolCallId` to match our naming convention.

### Phase 3: Client Handler (`apps/client/src/layers/features/chat/model/stream-event-handler.ts`)

**3a. Import `ToolProgressEvent` type**

Add `ToolProgressEvent` to the import from `@dorkos/shared/types`.

**3b. Add `tool_progress` switch case**

After the `tool_call_delta` case (line 188) and before `tool_call_end` (line 190):

```typescript
case 'tool_progress': {
  const tp = data as ToolProgressEvent;
  const existing = findToolCallPart(tp.toolCallId);
  if (existing) {
    existing.progressOutput = (existing.progressOutput || '') + tp.content;
  } else {
    console.warn('[stream] tool_progress: unknown toolCallId', tp.toolCallId);
  }
  updateAssistantMessage(assistantId);
  break;
}
```

**3c. Update `tool_result` case to clear `progressOutput`**

In the `tool_result` handler (line 201-218), after setting `existing.result`, add:

```typescript
existing.progressOutput = undefined;
```

This implements the "replace progress with result" transition.

**3d. Update `deriveFromParts` to include `progressOutput`**

In the `deriveFromParts` function (line 41-61), add `progressOutput: part.progressOutput` to the toolCalls mapping.

### Phase 4: Client Types (`apps/client/src/layers/features/chat/model/chat-types.ts`)

**4a. Add `progressOutput` to `ToolCallState`**

```typescript
export interface ToolCallState {
  // ... existing fields
  /** Intermediate output from tool_progress events (cleared when result arrives) */
  progressOutput?: string;
}
```

### Phase 5: ToolCallCard UI (`apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`)

**5a. Add auto-expand on progress**

Add a `useEffect` that auto-expands the card when `progressOutput` first becomes truthy:

```typescript
const hasProgress = !!toolCall.progressOutput;

useEffect(() => {
  if (hasProgress && !expanded) {
    setExpanded(true);
  }
}, [hasProgress]); // eslint-disable-line react-hooks/exhaustive-deps
```

Note: `expanded` is intentionally omitted from deps — we only want to expand once when progress first arrives, not re-expand if the user manually collapses.

**5b. Add truncation constant**

```typescript
const PROGRESS_TRUNCATE_BYTES = 5120;
```

**5c. Render progress output**

Between the `ToolArgumentsDisplay` block and the `result` block, add progress rendering:

```tsx
{
  toolCall.progressOutput && !toolCall.result && (
    <ProgressOutput content={toolCall.progressOutput} />
  );
}
```

**5d. Create `ProgressOutput` component**

A small internal component (same file or extracted if it grows):

```tsx
function ProgressOutput({ content }: { content: string }) {
  const [showFull, setShowFull] = useState(false);
  const isTruncated = content.length > PROGRESS_TRUNCATE_BYTES;
  const displayContent =
    isTruncated && !showFull ? content.slice(0, PROGRESS_TRUNCATE_BYTES) : content;

  return (
    <div className="mt-2 border-t pt-2">
      <pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{displayContent}</pre>
      {isTruncated && !showFull && (
        <button
          onClick={() => setShowFull(true)}
          className="text-muted-foreground hover:text-foreground mt-1 text-xs underline"
        >
          Show full output ({(content.length / 1024).toFixed(1)}KB)
        </button>
      )}
    </div>
  );
}
```

**Key rendering logic:**

- Progress shows only while `progressOutput` exists AND `result` is absent
- When `tool_result` arrives, `progressOutput` is cleared → progress block unmounts, result block mounts
- The `<pre>` block has `max-h-48 overflow-y-auto` for scroll containment
- Truncation is at 5,120 bytes with a clickable disclosure

### Phase 6: AutoHideToolCall Pass-Through

**6a. Pass `progressOutput` through to ToolCallCard**

In `AssistantMessageContent.tsx`, the `AutoHideToolCall` component constructs the `toolCall` prop (lines 66-72). Add `progressOutput`:

```typescript
<ToolCallCard
  toolCall={{
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input || '',
    result: part.result,
    progressOutput: part.progressOutput,
    status: part.status,
  }}
  defaultExpanded={expandToolCalls}
/>
```

**6b. Update `AutoHideToolCall` part type**

Add `progressOutput?: string` to the `part` type in the `AutoHideToolCall` props interface.

## Testing

### Server Tests (`apps/server/src/services/core/__tests__/sdk-event-mapper.test.ts`)

**Test 1: tool_progress emits tool_progress StreamEvent**

```typescript
describe('tool_progress messages', () => {
  it('emits tool_progress with toolCallId and content', async () => {
    const events = await collectEvents(
      mapSdkMessage(
        {
          type: 'tool_progress',
          tool_use_id: 'tc-1',
          content: 'Installing dependencies...\n',
        } as unknown,
        makeSession(),
        'session-1',
        makeToolState()
      )
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_progress');
    expect((events[0].data as Record<string, unknown>).toolCallId).toBe('tc-1');
    expect((events[0].data as Record<string, unknown>).content).toBe(
      'Installing dependencies...\n'
    );
  });
});
```

### Client Handler Tests

**Test 2: tool_progress accumulates progressOutput on existing tool call**

Verify that `progressOutput` accumulates across multiple events and is cleared on `tool_result`.

### ToolCallCard Component Tests

**Test 3: Auto-expands when progressOutput arrives**

Render a ToolCallCard with `status: 'running'` and no progressOutput, then re-render with progressOutput. Verify the card expands.

**Test 4: Truncates at ~5KB with disclosure**

Render with progressOutput exceeding 5KB. Verify truncated content and "Show full output" button.

**Test 5: Progress replaced by result**

Render with progressOutput, then update with result and no progressOutput. Verify result displays and progress is gone.

## Files Changed

| File                                                                          | Change                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/schemas.ts`                                              | Add `tool_progress` to enum, add `ToolProgressEventSchema`, add to `StreamEventSchema` union, add `progressOutput` to `ToolCallPartSchema` and `HistoryToolCallSchema` |
| `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`           | Add `tool_progress` branch                                                                                                                                             |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts`          | Add `tool_progress` switch case, clear `progressOutput` on `tool_result`                                                                                               |
| `apps/client/src/layers/features/chat/model/chat-types.ts`                    | Add `progressOutput` to `ToolCallState`                                                                                                                                |
| `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`                    | Add auto-expand, `ProgressOutput` component with truncation                                                                                                            |
| `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` | Pass `progressOutput` through `AutoHideToolCall` to `ToolCallCard`                                                                                                     |
| `apps/server/src/services/core/__tests__/sdk-event-mapper.test.ts`            | Add `tool_progress` test case                                                                                                                                          |

## Acceptance Criteria

1. **Pipeline complete:** `tool_progress` SDK messages flow from mapper → SSE → client handler → UI without being dropped
2. **Accumulation:** Multiple `tool_progress` events for the same tool call accumulate into a single `progressOutput` string
3. **Auto-expand:** ToolCallCard auto-expands when first progress content arrives
4. **Streaming feel:** Progress content updates in real-time as events arrive (no batching delay)
5. **Result transition:** When `tool_result` arrives, progress is replaced by the final result
6. **Truncation:** Progress output exceeding ~5KB is truncated with a "Show full output" disclosure
7. **Auto-hide:** After tool completion, normal auto-hide behavior applies (if enabled by user setting)
8. **No regression:** Existing tool call lifecycle (start → delta → end → result) is unaffected
9. **Tests pass:** All existing tests pass + new tests for tool_progress mapper, handler, and component

## Non-Requirements

- No ANSI color rendering in progress output (P3 scope — specialized tool renderers)
- No per-tool progress formatting (Bash vs Read vs Grep) — all progress renders as monospace text
- No truncation of existing `tool_result` display — that's a separate P2 audit item
- No persistence of progressOutput in JSONL history — progress is transient streaming state
