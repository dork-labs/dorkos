---
slug: mcp-tool-result-streaming
number: 172
created: 2026-03-23
status: specified
---

# Fix MCP Tool Results Missing During Streaming

## Overview

MCP tool results are never delivered to the client during live streaming sessions. The `ToolCallCard` UI shows an empty body (no input, no result) for MCP tools like `mcp__dorkos__mesh_list`, while built-in SDK tools (Read, Bash, etc.) display results correctly. Reloading the page (which loads from JSONL transcript) shows the full data, proving the SDK records MCP results but the streaming pipeline drops them.

**Root cause:** The `sdk-event-mapper.ts` only emits `tool_result` SSE events when a `tool_use_summary` SDK message arrives. The Claude Code Agent SDK emits `tool_use_summary` for built-in tools only — MCP tool results arrive in `SDKUserMessage` events (type: `'user'`) containing `tool_result` content blocks, which the mapper currently ignores.

**Secondary issue:** MCP tools with empty `{}` input show no input in streamed cards because the Anthropic API emits no `input_json_delta` events for empty inputs. The JSONL stores the reconstructed `'{}'` from `block.input`, which is not available during streaming.

## Technical Design

### Fix 1: Process `SDKUserMessage` for MCP tool results

Add a handler in `sdk-event-mapper.ts` for `message.type === 'user'` that:

1. Iterates `message.message.content` looking for `tool_result` blocks
2. Skips tool IDs already resolved via `tool_use_summary` (deduplication)
3. Extracts result text using the same logic as `extractToolResultContent()` in `transcript-parser.ts`
4. Yields `tool_result` SSE events for unresolved tool calls

**Deduplication:** Add `resolvedResultIds: Set<string>` to `ToolState`. When `tool_use_summary` fires for built-in tools, add each `toolUseId` to this set. When processing `SDKUserMessage`, skip any `tool_use_id` already in the set.

**Replay guard:** Skip `SDKUserMessage` events that have `isReplay: true` (session resume replays should not re-emit results).

### Fix 2: Backfill empty MCP tool input from `SDKAssistantMessage`

Add a handler for `message.type === 'assistant'` that:

1. Iterates `message.message.content` looking for `tool_use` blocks
2. For each block with a tracked `toolCallId`, emits a `tool_call_delta` with `JSON.stringify(block.input)` if no input was previously streamed
3. This fills the gap where `input_json_delta` events never fired for empty-input MCP tools

**Tracking:** Add `toolInputReceived: Set<string>` to `ToolState`. Set the flag in the `input_json_delta` handler. Only emit the backfill delta if the tool ID is NOT in `toolInputReceived`.

### Data flow after fix

```
SDK stream
  ├─ stream_event: content_block_start → tool_call_start SSE (unchanged)
  ├─ stream_event: input_json_delta    → tool_call_delta SSE (unchanged)
  ├─ stream_event: content_block_stop  → tool_call_end SSE (unchanged)
  ├─ assistant message                 → tool_call_delta SSE [NEW: input backfill]
  ├─ user message (tool_result blocks) → tool_result SSE [NEW: MCP results]
  ├─ tool_use_summary                  → tool_result SSE (unchanged, built-in only)
  └─ result                            → session_status + done SSE (unchanged)
```

### Files changed

| File                                                                       | Change                                                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/runtimes/claude-code/agent-types.ts`             | Add `resolvedResultIds: Set<string>` and `toolInputReceived: Set<string>` to `ToolState` interface and `createToolState()` |
| `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`        | Add handlers for `user` and `assistant` message types; mark resolved IDs in `tool_use_summary` handler                     |
| `apps/server/src/services/core/__tests__/sdk-event-mapper.test.ts`         | Add test cases for MCP tool results, deduplication, input backfill, replay guard                                           |
| `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts` | Add `sdkMcpToolCall` scenario builder                                                                                      |

### Files NOT changed

| File                      | Why                                                                 |
| ------------------------- | ------------------------------------------------------------------- |
| `stream-tool-handlers.ts` | `handleToolResult` already processes `tool_result` events correctly |
| `ToolCallCard.tsx`        | Already renders results when `toolCall.result` is truthy            |
| `stream-event-handler.ts` | Already routes `tool_result` → `handleToolResult`                   |
| `schemas.ts`              | `tool_result` is already a valid `StreamEvent` type                 |

## Implementation Phases

### Phase 1: Extend ToolState (agent-types.ts)

Add two new tracking sets to the `ToolState` interface:

```typescript
/** Tool IDs whose results were already delivered via tool_use_summary. */
resolvedResultIds: Set<string>;
/** Tool IDs that received at least one input_json_delta during streaming. */
toolInputReceived: Set<string>;
```

Update `createToolState()` to initialize both as `new Set<string>()`.

### Phase 2: Mark resolved IDs in tool_use_summary handler (sdk-event-mapper.ts)

In the existing `tool_use_summary` handler (line 294), add `toolState.resolvedResultIds.add(toolUseId)` inside the loop before yielding:

```typescript
if (message.type === 'tool_use_summary') {
  const summary = message as { summary: string; preceding_tool_use_ids: string[] };
  for (const toolUseId of summary.preceding_tool_use_ids) {
    toolState.resolvedResultIds.add(toolUseId); // NEW
    yield {
      type: 'tool_result',
      data: { ... },
    };
  }
  return;
}
```

### Phase 3: Track input_json_delta reception (sdk-event-mapper.ts)

In the `input_json_delta` handler (line 228), add tracking:

```typescript
} else if (delta?.type === 'input_json_delta' && toolState.inTool) {
  toolState.toolInputReceived.add(toolState.currentToolId); // NEW
  // ... existing logic
}
```

### Phase 4: Add assistant message handler for input backfill (sdk-event-mapper.ts)

Insert before the `tool_use_summary` handler (before line 293):

```typescript
// Backfill tool input from completed assistant message (for MCP tools with empty input)
if (message.type === 'assistant') {
  const content = (message as Record<string, unknown>).message;
  const contentBlocks = (content as Record<string, unknown>)?.content;
  if (Array.isArray(contentBlocks)) {
    for (const block of contentBlocks as Array<Record<string, unknown>>) {
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        !toolState.toolInputReceived.has(block.id) &&
        toolState.toolNameById.has(block.id)
      ) {
        const inputStr = JSON.stringify(block.input ?? {});
        yield {
          type: 'tool_call_delta',
          data: {
            toolCallId: block.id,
            toolName: toolState.toolNameById.get(block.id) ?? '',
            input: inputStr,
            status: 'running',
          },
        };
      }
    }
  }
  return;
}
```

### Phase 5: Add user message handler for MCP tool results (sdk-event-mapper.ts)

Insert after the assistant handler, before `tool_use_summary`:

```typescript
// Extract tool results from user messages (MCP tools deliver results here, not via tool_use_summary)
if (message.type === 'user') {
  // Skip replay messages during session resume
  if ((message as Record<string, unknown>).isReplay) return;

  const content = (message as Record<string, unknown>).message;
  const contentBlocks = (content as Record<string, unknown>)?.content;
  if (Array.isArray(contentBlocks)) {
    for (const block of contentBlocks as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        // Skip tools already resolved via tool_use_summary (built-in tools)
        if (toolState.resolvedResultIds.has(block.tool_use_id)) continue;

        const resultText = extractToolResultText(block.content);
        if (resultText) {
          yield {
            type: 'tool_result',
            data: {
              toolCallId: block.tool_use_id,
              toolName: toolState.toolNameById.get(block.tool_use_id) ?? '',
              result: resultText,
              status: 'complete',
            },
          };
        }
      }
    }
  }
  return;
}
```

The `extractToolResultText` helper mirrors `extractToolResultContent` from `transcript-parser.ts`:

```typescript
/** Extract text from a tool_result content field. */
function extractToolResultText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text as string)
    .join('\n');
}
```

This is a file-local helper, not a shared import from `transcript-parser.ts`, because `transcript-parser.ts` uses a `ContentBlock` type from its own module scope while the event mapper works with loosely-typed SDK message objects.

### Phase 6: Tests (sdk-event-mapper.test.ts + sdk-scenarios.ts)

**New test cases in `sdk-event-mapper.test.ts`:**

1. **MCP tool result via user message** — An `SDKUserMessage` with `tool_result` blocks yields `tool_result` SSE events
2. **Deduplication** — A `tool_use_summary` followed by a `user` message for the same tool ID yields only ONE `tool_result`
3. **Input backfill** — An `assistant` message with a `tool_use` block (where no `input_json_delta` was received) yields a `tool_call_delta` with the serialized input
4. **Input backfill skipped** — When `input_json_delta` was received, the `assistant` message does NOT yield an additional delta
5. **Replay guard** — A `user` message with `isReplay: true` yields no events
6. **Mixed tool call** — A session with both built-in and MCP tool calls yields correct results for both

**New scenario builder in `sdk-scenarios.ts`:**

Add `sdkMcpToolCall(toolName: string, toolId: string, input: object, resultContent: string)` that returns the full event sequence: `content_block_start` → optional `input_json_delta` → `content_block_stop` → `assistant` message → `user` message with `tool_result`.

## Acceptance Criteria

1. MCP tool results appear in the `ToolCallCard` during live streaming (not just on page reload)
2. MCP tool input (`'{}'` for parameterless tools) displays in the expanded card during streaming
3. Built-in tool results continue to work correctly (no regression)
4. No duplicate `tool_result` events for built-in tools (deduplication verified by test)
5. Session resume/replay does not re-emit stale tool results
6. All existing `sdk-event-mapper.test.ts` tests continue to pass
7. At least 6 new test cases covering MCP results, deduplication, input backfill, replay guard

## Non-Functional Requirements

- Zero client-side changes — the fix is entirely server-side
- No new SSE event types — reuses existing `tool_result` and `tool_call_delta`
- No filesystem I/O in the streaming path — all data comes from the SDK message stream
- The `extractToolResultText` helper is file-local (not shared) to avoid coupling between modules

## Out of Scope

- Tool result size truncation (large MCP results may be 10KB+; follow-up if needed)
- Changes to the Claude Code Agent SDK
- Changes to `ToolCallCard.tsx` or any client-side component
- Obsidian plugin testing (same Transport interface; should work once server emits correctly)

## Open Questions

_None — all design decisions resolved during ideation._
