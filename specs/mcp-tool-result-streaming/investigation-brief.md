# Investigation: MCP Tool Results Missing During Streaming

## Problem

When MCP tools (e.g., `mcp__dorkos__mesh_list`) execute during a streaming session, the client never receives the tool result data. The `ToolCallCard` UI component shows an empty body when expanded — no input arguments and no result output.

**However**, when the same session is reloaded from the JSONL transcript, the tool call parts DO contain both `input` (`'{}'`) and `result` (~11KB of JSON). This means the Claude Code SDK records full MCP results in the JSONL, but the DorkOS streaming pipeline never relays them to the client.

## Evidence

DOM inspection of streamed vs history-loaded tool call cards on the same page:

```
History-loaded cards (from JSONL):
  hasInput: true,  inputLen: 2      (likely '{}')
  hasResult: true, resultLen: ~11004 (full MCP JSON response)

Streamed cards (live session):
  hasInput: false, inputLen: 0
  hasResult: false, resultLen: 0
```

## Architecture Context

### SSE Event Flow (server → client)

The server-side SDK event mapper (`apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`) processes raw SDK events and yields SSE events:

1. **`content_block_start`** (tool_use) → yields `tool_call_start` with `toolCallId`, `toolName`
2. **`content_block_delta`** (input_json_delta) → yields `tool_call_delta` with incremental `input`
3. **`content_block_stop`** → yields `tool_call_end` with `toolCallId`, `status: 'complete'` — **NO result data**
4. **`tool_use_summary`** (message-level) → yields `tool_result` with `toolCallId`, `result: summary.summary`

For built-in SDK tools (Read, Bash, etc.), step 4 fires and the client receives `tool_result`. For MCP tools, step 4 appears to never fire — the client only gets steps 1-3.

### Client-Side Handlers

In `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts`:

- `handleToolCallStart` — creates the tool call part with `startedAt`
- `handleToolCallDelta` — appends to `input`
- `handleToolCallEnd` — sets `status: 'complete'` and `completedAt`
- `handleToolResult` — sets `result`, `completedAt`, clears `progressOutput`

Since `handleToolResult` is never called for MCP tools, `result` stays `undefined`.

### Key Files

| File                                                                 | Role                                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`  | Transforms SDK events → SSE events. Lines 293-307 handle `tool_use_summary` → `tool_result`. |
| `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`  | Lines 264-274: `content_block_stop` → `tool_call_end` (no result).                           |
| `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts` | Client-side SSE event handlers. `handleToolResult` (line 104) sets `result`.                 |
| `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`           | Renders tool call card. Lines 175-186: shows input/result when expanded.                     |

## What to Investigate

1. **Does the Claude Code SDK emit `tool_use_summary` for MCP tool calls?**
   - Add temporary logging in `sdk-event-mapper.ts` to log ALL incoming `message.type` values during an MCP tool call
   - Compare the event sequence for a built-in tool (e.g., `Read`) vs an MCP tool (e.g., `mcp__dorkos__mesh_list`)
   - Check if MCP tools use a different result delivery mechanism (e.g., `tool_result` raw event, or inline in the `result` message)

2. **If `tool_use_summary` IS emitted, why isn't it reaching the client?**
   - Check if `preceding_tool_use_ids` in the summary matches the `toolCallId` tracked by `toolState.toolNameById`
   - The mapper stores tool IDs in `toolState.toolNameById.get(toolUseId)` — verify MCP tool IDs are being stored there

3. **If `tool_use_summary` is NOT emitted for MCP tools, what alternative exists?**
   - Check if the SDK sends MCP results through `result` events (the raw API event type) rather than `tool_use_summary`
   - Check if `content_block_stop` for MCP tools carries result data that we're currently ignoring
   - Look at the raw SDK event stream (before the mapper) to see what events actually fire

4. **Input also missing**: Streamed MCP tool calls have empty `input` while history shows `'{}'`. Check if `input_json_delta` events fire for MCP tools with no parameters, or if the empty `{}` input is only written to JSONL retroactively.

## Intended Outcome

After this investigation:

1. MCP tool results should appear in the `ToolCallCard` when expanded (same as built-in tools)
2. The `result` field on streamed MCP tool call parts should match what's stored in the JSONL transcript
3. If the SDK genuinely doesn't emit MCP results through the streaming API, document this as a known limitation and consider whether to populate results from the JSONL on session load

## How to Test

1. Start the dev server: `pnpm dev`
2. Open http://localhost:6241 and navigate to any session with an agent that has MCP tools enabled
3. Send a message that triggers an MCP tool call (e.g., "give me a mesh list")
4. After the response completes, expand the tool call card — it should show the result data
5. Compare with a built-in tool call (e.g., trigger a `Read` or `Bash`) which should already show results
