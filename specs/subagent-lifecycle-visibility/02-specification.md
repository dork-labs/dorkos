---
slug: subagent-lifecycle-visibility
number: 137
created: 2026-03-16
status: specification
---

# Subagent Lifecycle Visibility

**Status:** Specification
**Authors:** Claude Code, 2026-03-16
**Ideation:** `specs/subagent-lifecycle-visibility/01-ideation.md`
**Audit ref:** `.temp/agent-sdk-audit.md` items #5, #6, #7

---

## Overview

Surface the three subagent lifecycle SDK messages — `task_started`, `task_progress`, `task_notification` — in the DorkOS chat UI. Currently all three are silently dropped by `sdk-event-mapper.ts`. Users have zero visibility when Claude spawns Task subagents, what they're doing, or when they finish.

The solution adds end-to-end support: server-side event mapping, shared Zod schemas, and a client-side collapsible inline block (SubagentBlock) that shows subagent description, live progress metrics, and completion summary.

## Background / Problem Statement

When Claude Code uses the Task tool to spawn subagents (very common for complex work — research, code exploration, parallel execution), the SDK emits three system message subtypes that provide lifecycle visibility. DorkOS drops all three silently because `sdk-event-mapper.ts` only checks for `subtype === 'init'` and ignores other system subtypes.

**User impact:** During complex sessions, users see the main agent pause for seconds or minutes while subagents work invisibly. There's no indication that parallel work is happening, no way to understand what the agent is doing, and no signal when subagent work completes. This undermines DorkOS's core value proposition — multi-agent coordination visibility.

## Goals

- Users see an inline indicator when a subagent spawns, showing its description and a spinner
- Users see live progress metrics (tool count, last tool used, duration) updating as the subagent works
- Users see a completion state with the subagent's summary text when it finishes
- The SubagentBlock follows existing ToolCallCard patterns for visual consistency
- All new event types have Zod schemas with OpenAPI metadata
- Existing streaming, tool call rendering, and task list panel behavior are unaffected

## Non-Goals

- Recursive subagent nesting (v1 is single-level — grandchild subagents are invisible)
- JSONL history reconstruction of subagent blocks (follow-up work — v1 is live streaming only)
- Streaming subagent text output inline (the SDK provides structured metrics, not raw text)
- `tool_progress` events (separate audit item #8)
- Extended thinking blocks (separate audit items #2c, #2g)

## Technical Dependencies

- `@anthropic-ai/claude-agent-sdk` v0.2.58+ (already installed) — provides `SDKTaskStartedMessage`, `SDKTaskProgressMessage`, `SDKTaskNotificationMessage` types
- `motion/react` (already installed) — expand/collapse animations matching ToolCallCard
- `lucide-react` (already installed) — status icons (Loader2, Check, X, ChevronDown)
- `zod` (already installed) — schema definitions

## Detailed Design

### SDK Type Analysis

The Claude Agent SDK (v0.2.58) defines three system message types with richer data than initially expected:

```typescript
// SDKTaskStartedMessage
{
  type: 'system',
  subtype: 'task_started',
  task_id: string,        // unique task identifier
  tool_use_id?: string,   // correlates to the Task tool call
  description: string,    // user-facing description (e.g., "Explore codebase for feature X")
  task_type?: string,     // optional task type classification
  session_id: string,     // subagent's session ID
  uuid: string,
}

// SDKTaskProgressMessage
{
  type: 'system',
  subtype: 'task_progress',
  task_id: string,
  tool_use_id?: string,
  description: string,    // same description from task_started
  usage: {
    total_tokens: number, // tokens consumed so far
    tool_uses: number,    // number of tool calls made
    duration_ms: number,  // elapsed time in milliseconds
  },
  last_tool_name?: string, // most recently used tool (e.g., "Read", "Grep")
  session_id: string,
  uuid: string,
}

// SDKTaskNotificationMessage
{
  type: 'system',
  subtype: 'task_notification',
  task_id: string,
  tool_use_id?: string,
  status: 'completed' | 'failed' | 'stopped',
  output_file: string,   // path to subagent output file
  summary: string,       // subagent's completion summary text
  usage?: {
    total_tokens: number,
    tool_uses: number,
    duration_ms: number,
  },
  session_id: string,
  uuid: string,
}
```

**Key insight:** `task_progress` provides structured metrics (tool count, last tool name, duration), not raw streaming content blocks. This simplifies the implementation significantly — no content block parsing needed.

### Layer 1: Shared Schemas (`packages/shared/src/schemas.ts`)

#### New StreamEvent Types

Add three values to `StreamEventTypeSchema`:

```typescript
export const StreamEventTypeSchema = z.enum([
  // ... existing 16 types ...
  'subagent_started',
  'subagent_progress',
  'subagent_done',
]);
```

#### New Event Schemas

```typescript
export const SubagentStartedEventSchema = z
  .object({
    taskId: z.string(),
    subagentSessionId: z.string(),
    toolUseId: z.string().optional(),
    description: z.string(),
  })
  .openapi('SubagentStartedEvent');

export type SubagentStartedEvent = z.infer<typeof SubagentStartedEventSchema>;

export const SubagentProgressEventSchema = z
  .object({
    taskId: z.string(),
    toolUses: z.number().int(),
    lastToolName: z.string().optional(),
    durationMs: z.number().int(),
  })
  .openapi('SubagentProgressEvent');

export type SubagentProgressEvent = z.infer<typeof SubagentProgressEventSchema>;

export const SubagentDoneEventSchema = z
  .object({
    taskId: z.string(),
    status: z.enum(['completed', 'failed', 'stopped']),
    summary: z.string().optional(),
    toolUses: z.number().int().optional(),
    durationMs: z.number().int().optional(),
  })
  .openapi('SubagentDoneEvent');

export type SubagentDoneEvent = z.infer<typeof SubagentDoneEventSchema>;
```

Add all three to `StreamEventSchema`'s data union.

#### New MessagePart Type

```typescript
const SubagentStatusSchema = z.enum(['running', 'complete', 'error']);

export const SubagentPartSchema = z
  .object({
    type: z.literal('subagent'),
    taskId: z.string(),
    description: z.string(),
    status: SubagentStatusSchema,
    toolUses: z.number().int().optional(),
    lastToolName: z.string().optional(),
    durationMs: z.number().int().optional(),
    summary: z.string().optional(),
  })
  .openapi('SubagentPart');

export type SubagentPart = z.infer<typeof SubagentPartSchema>;
```

Add `SubagentPartSchema` to the `MessagePartSchema` discriminated union:

```typescript
export const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  SubagentPartSchema,
]);
```

#### Type Re-exports

Add to `packages/shared/src/types.ts`:

```typescript
export type {
  SubagentStartedEvent,
  SubagentProgressEvent,
  SubagentDoneEvent,
  SubagentPart,
} from './schemas.js';
```

### Layer 2: Server Event Mapping (`apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`)

Add three new branches in `mapSdkMessage`, after the existing `system/init` check (line 29) and before the `stream_event` check (line 33). Use the SDK's discriminated union types for narrowing instead of `as Record<string, unknown>`:

```typescript
// After the system/init return on line 29:

if (message.type === 'system' && 'subtype' in message) {
  if (message.subtype === 'task_started') {
    yield {
      type: 'subagent_started',
      data: {
        taskId: message.task_id,
        subagentSessionId: message.session_id,
        toolUseId: message.tool_use_id,
        description: message.description,
      },
    };
    return;
  }

  if (message.subtype === 'task_progress') {
    yield {
      type: 'subagent_progress',
      data: {
        taskId: message.task_id,
        toolUses: message.usage.tool_uses,
        lastToolName: message.last_tool_name,
        durationMs: message.usage.duration_ms,
      },
    };
    return;
  }

  if (message.subtype === 'task_notification') {
    yield {
      type: 'subagent_done',
      data: {
        taskId: message.task_id,
        status: message.status,
        summary: message.summary,
        toolUses: message.usage?.tool_uses,
        durationMs: message.usage?.duration_ms,
      },
    };
    return;
  }
}
```

**Note:** The existing `system/init` check (lines 19-30) uses `message.subtype === 'init'` which will still match first. The new checks handle the three additional subtypes. Other system subtypes (status, compact_boundary, etc.) continue to fall through silently — they are separate audit items.

### Layer 3: Client Stream Handler (`apps/client/src/layers/features/chat/model/stream-event-handler.ts`)

#### Import New Types

```typescript
import type {
  // ... existing imports ...
  SubagentStartedEvent,
  SubagentProgressEvent,
  SubagentDoneEvent,
} from '@dorkos/shared/types';
```

#### New Switch Cases

Add three cases to the `handleStreamEvent` switch statement:

```typescript
case 'subagent_started': {
  const { taskId, description } = data as SubagentStartedEvent;
  currentPartsRef.current.push({
    type: 'subagent',
    taskId,
    description,
    status: 'running',
  });
  updateAssistantMessage(assistantId);
  break;
}

case 'subagent_progress': {
  const progress = data as SubagentProgressEvent;
  const subagentPart = findSubagentPart(progress.taskId);
  if (subagentPart) {
    subagentPart.toolUses = progress.toolUses;
    subagentPart.lastToolName = progress.lastToolName;
    subagentPart.durationMs = progress.durationMs;
  }
  updateAssistantMessage(assistantId);
  break;
}

case 'subagent_done': {
  const done = data as SubagentDoneEvent;
  const subagentPartDone = findSubagentPart(done.taskId);
  if (subagentPartDone) {
    subagentPartDone.status = done.status === 'completed' ? 'complete' : 'error';
    subagentPartDone.summary = done.summary;
    if (done.toolUses !== undefined) subagentPartDone.toolUses = done.toolUses;
    if (done.durationMs !== undefined) subagentPartDone.durationMs = done.durationMs;
  }
  updateAssistantMessage(assistantId);
  break;
}
```

#### Helper Function

Add alongside existing `findToolCallPart`:

```typescript
function findSubagentPart(taskId: string) {
  for (let i = currentPartsRef.current.length - 1; i >= 0; i--) {
    const part = currentPartsRef.current[i];
    if (part.type === 'subagent' && part.taskId === taskId) {
      return part;
    }
  }
  return undefined;
}
```

#### Update `deriveFromParts()`

SubagentParts should be skipped in the text/toolCalls derivation (they are neither text nor tool calls):

```typescript
export function deriveFromParts(parts: MessagePart[]): {
  content: string;
  toolCalls: ToolCallState[];
} {
  const textSegments: string[] = [];
  const toolCalls: ToolCallState[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      textSegments.push(part.text);
    } else if (part.type === 'tool_call') {
      toolCalls.push({
        /* ... existing mapping ... */
      });
    }
    // SubagentParts are intentionally skipped — they render via their own component
  }
  return { content: textSegments.join('\n'), toolCalls };
}
```

### Layer 4: Client Component (`apps/client/src/layers/features/chat/ui/SubagentBlock.tsx`)

New file following ToolCallCard patterns:

```tsx
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Check, X, ChevronDown } from 'lucide-react';
import type { SubagentPart } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { toolStatus } from './message/message-variants';

interface SubagentBlockProps {
  part: SubagentPart;
}

/** Format duration from milliseconds to human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Build a tool usage summary string from subagent progress metrics. */
function buildToolSummary(part: SubagentPart): string | null {
  const segments: string[] = [];
  if (part.toolUses) {
    segments.push(`${part.toolUses} tool ${part.toolUses === 1 ? 'call' : 'calls'}`);
  }
  if (part.durationMs) {
    segments.push(formatDuration(part.durationMs));
  }
  return segments.length > 0 ? segments.join(' · ') : null;
}

/** Collapsible inline block displaying a subagent's lifecycle status. */
export function SubagentBlock({ part }: SubagentBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    running: (
      <Loader2
        className={cn('size-(--size-icon-xs) animate-spin', toolStatus({ status: 'running' }))}
      />
    ),
    complete: <Check className={cn('size-(--size-icon-xs)', toolStatus({ status: 'complete' }))} />,
    error: <X className={cn('size-(--size-icon-xs)', toolStatus({ status: 'error' }))} />,
  }[part.status];

  const toolSummary = buildToolSummary(part);
  const hasExpandableContent = toolSummary || part.summary || part.lastToolName;

  return (
    <div
      className="bg-muted/50 hover:border-border rounded-msg-tool shadow-msg-tool hover:shadow-msg-tool-hover mt-px border text-sm transition-all duration-150 first:mt-1"
      data-testid="subagent-block"
      data-task-id={part.taskId}
      data-status={part.status}
    >
      <button
        onClick={() => hasExpandableContent && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1"
        aria-expanded={hasExpandableContent ? expanded : undefined}
        aria-label={`Subagent: ${part.description}`}
      >
        {statusIcon}
        <span className="text-3xs truncate font-mono">{part.description}</span>
        {toolSummary && (
          <span className="text-3xs text-muted-foreground ml-1 shrink-0">{toolSummary}</span>
        )}
        {hasExpandableContent && (
          <motion.div
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="ml-auto"
          >
            <ChevronDown className="size-(--size-icon-xs)" />
          </motion.div>
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && hasExpandableContent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-1 border-t px-3 pt-1 pb-3">
              {part.lastToolName && part.status === 'running' && (
                <p className="text-3xs text-muted-foreground">
                  Last tool: <span className="font-mono">{part.lastToolName}</span>
                </p>
              )}
              {part.summary && (
                <pre className="overflow-x-auto text-xs whitespace-pre-wrap">{part.summary}</pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

### Layer 5: Client Dispatch (`apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`)

Add SubagentBlock rendering in the parts iteration:

```tsx
import { SubagentBlock } from '../SubagentBlock';

// In the parts.map callback, add before the final AutoHideToolCall fallback:
if (part.type === 'subagent') {
  return <SubagentBlock key={part.taskId} part={part} />;
}
```

No auto-hide behavior — subagent blocks are high-signal and should remain visible.

## User Experience

### Collapsed State (Default)

```
┌──────────────────────────────────────────────────────┐
│ ⟳ Explore codebase for feature X    3 tool calls · 5s  ▾│
└──────────────────────────────────────────────────────┘
```

- Spinner icon while running, checkmark when complete, X on error
- Description from the Task tool's description argument
- Tool count and elapsed time update live via `task_progress` events
- Chevron toggle to expand (only if there's expandable content)

### Expanded State

```
┌──────────────────────────────────────────────────────┐
│ ✓ Explore codebase for feature X    3 tool calls · 5s  ▴│
│─────────────────────────────────────────────────────── │
│ Last tool: Read                                        │
│ Found 7 relevant files across server and client.       │
│ Key components: sdk-event-mapper.ts, schemas.ts...     │
└──────────────────────────────────────────────────────┘
```

- "Last tool" line shows during running state (from `last_tool_name`)
- Summary text appears when subagent completes (from `task_notification.summary`)

### State Transitions

1. **Spawned:** `task_started` → block appears with spinner + description
2. **Working:** `task_progress` (may fire multiple times) → tool count and duration update
3. **Done:** `task_notification` → spinner → checkmark/X, summary becomes available

### Visual Consistency

SubagentBlock uses identical styling to ToolCallCard:

- Same `bg-muted/50`, `rounded-msg-tool`, `shadow-msg-tool` classes
- Same `text-3xs font-mono` for the label
- Same `motion/react` AnimatePresence expand/collapse pattern
- Same chevron rotation spring animation
- Same `toolStatus` CVA variants for status icon coloring

## Testing Strategy

### Server Tests (`apps/server/src/services/runtimes/claude-code/__tests__/`)

#### SDK Scenario Builders (`sdk-scenarios.ts`)

Add three new builder functions following existing patterns:

```typescript
/** Yield a task_started system message. */
export function sdkTaskStarted(taskId: string, description: string): SDKTaskStartedMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    description,
    session_id: `subagent-${taskId}`,
    uuid: crypto.randomUUID(),
  };
}

/** Yield a task_progress system message. */
export function sdkTaskProgress(
  taskId: string,
  toolUses: number,
  durationMs: number,
  lastToolName?: string
): SDKTaskProgressMessage {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: taskId,
    description: 'test task',
    usage: { total_tokens: 1000, tool_uses: toolUses, duration_ms: durationMs },
    last_tool_name: lastToolName,
    session_id: `subagent-${taskId}`,
    uuid: crypto.randomUUID(),
  };
}

/** Yield a task_notification system message. */
export function sdkTaskNotification(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string
): SDKTaskNotificationMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    output_file: '/tmp/output.txt',
    summary,
    usage: { total_tokens: 2000, tool_uses: 5, duration_ms: 3000 },
    session_id: `subagent-${taskId}`,
    uuid: crypto.randomUUID(),
  };
}
```

#### Mapper Tests (`sdk-event-mapper.test.ts`)

Add test cases:

1. **task_started yields subagent_started** — verifies taskId, description, subagentSessionId mapping
2. **task_progress yields subagent_progress** — verifies toolUses, lastToolName, durationMs extraction from usage object
3. **task_notification (completed) yields subagent_done** — verifies status='completed' maps to 'completed', summary extracted
4. **task_notification (failed) yields subagent_done with error** — verifies status='failed' maps correctly
5. **Unknown system subtypes still yield nothing** — existing test (line 308-319) should continue to pass for subtypes other than init/task_started/task_progress/task_notification

### Client Tests

#### SubagentBlock Component Test (`apps/client/src/layers/features/chat/ui/__tests__/SubagentBlock.test.tsx`)

1. **Renders running state** — spinner icon, description text, no summary
2. **Renders complete state** — check icon, description text
3. **Renders error state** — X icon, description text
4. **Shows tool summary when metrics present** — "3 tool calls · 5s" format
5. **Expands on click to show details** — summary text visible after click
6. **Does not expand when no expandable content** — no chevron, click is no-op
7. **formatDuration formats correctly** — <1s, seconds, minutes

#### Stream Handler Test (`apps/client/src/layers/features/chat/model/__tests__/stream-event-handler.test.ts`)

If tests exist for the stream event handler, add cases for:

1. **subagent_started creates SubagentPart** — part pushed to currentPartsRef
2. **subagent_progress updates existing SubagentPart** — toolUses, lastToolName, durationMs updated
3. **subagent_done transitions SubagentPart to complete** — status set, summary added
4. **deriveFromParts skips SubagentParts** — content string and toolCalls array unaffected

## Performance Considerations

- **task_progress fires multiple times** per subagent (on each tool call). Each fires `updateAssistantMessage`, triggering a React re-render. This is the same pattern as `tool_call_delta` and is acceptable for the expected frequency (one event per subagent tool call, typically 5-20 per subagent session).
- **SubagentBlock expanded content** is behind AnimatePresence — collapsed subagents have minimal DOM impact (just the header button).
- **No text streaming** into SubagentBlock — unlike streaming text which can trigger 100+ re-renders per second, subagent progress events arrive at tool-call frequency (one per 1-10 seconds).

## Security Considerations

- Subagent `description`, `summary`, and `last_tool_name` are displayed as-is from the SDK. These originate from Claude's own output (not user input), so XSS risk is negligible.
- `output_file` path from `task_notification` is not displayed in the UI and not exposed to the client (intentionally omitted from the schema).

## Documentation

- Update `contributing/api-reference.md` to document the three new StreamEvent types in the SSE events table
- No user-facing documentation needed — the feature is self-explanatory (blocks appear automatically when subagents are spawned)

## Implementation Phases

### Phase 1: Schema + Server Mapping

1. Add schemas to `packages/shared/src/schemas.ts`
2. Add type re-exports to `packages/shared/src/types.ts`
3. Add mapper branches to `sdk-event-mapper.ts`
4. Add SDK scenario builders and mapper tests

### Phase 2: Client Integration

5. Add switch cases to `stream-event-handler.ts`
6. Update `deriveFromParts()` to handle subagent type
7. Create `SubagentBlock.tsx` component
8. Add SubagentBlock dispatch in `AssistantMessageContent.tsx`
9. Add SubagentBlock component tests

### Phase 3: Verification

10. Manual testing with a real Claude Code session that spawns subagents
11. Verify auto-scroll behavior works correctly with SubagentBlock height changes
12. Verify no regression in existing tool call rendering

## Open Questions

No open questions — all decisions were resolved during ideation:

1. **Rendering approach** → Collapsible inline block (like ToolCallCard)
2. **Detail level** → Structured metrics (tool count, duration, last tool) + completion summary
3. **Nesting depth** → Single level only for v1
4. **History support** → Deferred to follow-up work

## Related ADRs

- **ADR-0114**: Client-only `_partId` for streaming key stability — establishes the pattern for client-only fields on message parts. SubagentPart uses `taskId` as the React key instead (already unique from the SDK).
- **ADR-0093**: queueMicrotask for SSE event batching — documents the `tool_result` deferred rendering pattern. SubagentBlock events don't need this because they don't produce adjacent orphan text parts.

## References

- SDK type definitions: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` lines 1790-1832
- Audit document: `.temp/agent-sdk-audit.md` items #5 (task_started), #6 (task_progress), #7 (task_notification)
- ToolCallCard component: `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — reference implementation for the SubagentBlock visual pattern
- SDK scenario test builders: `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts` — pattern for new builder functions
