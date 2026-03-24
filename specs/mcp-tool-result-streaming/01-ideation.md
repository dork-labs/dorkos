---
slug: mcp-tool-result-streaming
number: 172
created: 2026-03-23
status: ideation
---

# Fix MCP Tool Results Missing During Streaming

**Slug:** mcp-tool-result-streaming
**Author:** Claude Code
**Date:** 2026-03-23
**Branch:** preflight/mcp-tool-result-streaming

---

## 1) Intent & Assumptions

- **Task brief:** When MCP tools execute during a streaming session, the client never receives tool result data. The `ToolCallCard` shows an empty body when expanded — no input arguments and no result output. However, reloading the same session from the JSONL transcript shows full `input` and `result` data. The Claude Code SDK records MCP results in JSONL, but the DorkOS streaming pipeline never relays them to the client.
- **Assumptions:**
  - The Claude Code Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.58) emits `tool_use_summary` events only for built-in tools, not for MCP tools — this is confirmed by codebase analysis and SDK type inspection
  - The `SDKUserMessage` (type: `'user'`) emitted by the SDK after each assistant turn contains `tool_result` content blocks for both built-in AND MCP tools
  - The existing client-side `handleToolResult` handler already works correctly — the only fix needed is on the server-side event mapper
  - There is also a secondary issue: MCP tools with empty `{}` input show no input in streamed cards because no `input_json_delta` events fire for empty inputs
- **Out of scope:**
  - Tool result truncation/size limits (tracked separately as a potential follow-up)
  - Changes to the Claude Code Agent SDK itself
  - Changes to the `ToolCallCard` UI component (it already renders results correctly when data is present)
  - Obsidian plugin / DirectTransport path (same Transport interface, should work once server is fixed)

## 2) Pre-reading Log

- `contributing/architecture.md`: Hexagonal architecture, Transport interface, SSE streaming patterns
- `contributing/api-reference.md`: SSE event types including `tool_result`, `tool_call_start/delta/end`
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: Core event mapper — transforms SDK messages to SSE events. Lines 204-289 handle tool call streaming; lines 293-307 handle `tool_use_summary` → `tool_result`. This is the primary fix location.
- `apps/server/src/services/runtimes/claude-code/agent-types.ts`: Defines `ToolState` interface with `toolNameById`, `currentToolId`, `toolProgressById` maps
- `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts`: Client SSE handlers. `handleToolResult` (line 107-131) correctly sets `result`, `status`, `completedAt`. Line 96 comment reads: "Set completedAt if not already set (MCP tools complete here, not via tool_result)" — confirming the gap was known.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Main SSE processor. Line 154-156 routes `tool_result` events to `handleToolResult`.
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`: Renders tool call card. Lines 175-186: expanded view. Lines 190-197: `OutputRenderer` renders if `result` is truthy.
- `apps/server/src/services/runtimes/claude-code/transcript-parser.ts`: Parses JSONL history. Lines 182-203: `applyToolResult` populates result from `block.content`. Lines 263-271: reads `tool_result` blocks from `user` messages — this is why JSONL loading works.
- `apps/server/src/services/core/stream-adapter.ts`: SSE wire protocol (`initSSEStream`, `sendSSEEvent`, `endSSEStream`)
- `apps/server/src/routes/sessions.ts`: Express route for POST `/messages` (lines 142-233). Iterates `mapSdkMessage()` and sends SSE events.
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts`: Test scenario builders. `sdkTodoWrite` (lines 147-188) includes `tool_use_summary` — confirms built-in tools emit it.
- `apps/server/src/services/core/__tests__/sdk-event-mapper.test.ts`: Comprehensive test suite for event mapper, including tool call flows.
- `packages/shared/src/schemas.ts`: `StreamEvent` and `ToolCallEvent` Zod schemas; `tool_result` is a valid event type.
- `node_modules/.../claude-agent-sdk/sdk.d.ts`: SDK type definitions. `SDKToolUseSummaryMessage` at line 1845-1851 confirms the type structure. `StdoutMessage` union at line 1985 includes `SDKStreamlinedToolUseSummaryMessage` — an internal type not exposed to consumers.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — Transforms SDK messages → SSE events (the bug is here)
  - `apps/server/src/services/runtimes/claude-code/agent-types.ts` — `ToolState` interface definition (needs `resolvedResultIds` field)
  - `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts` — Client-side `handleToolResult` (no changes needed)
  - `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — Tool card UI (no changes needed)
- **Shared dependencies:**
  - `packages/shared/src/schemas.ts` — `ToolResultEvent` Zod schema, `StreamEvent` union
  - `apps/server/src/services/core/stream-adapter.ts` — SSE wire protocol
  - `apps/server/src/routes/sessions.ts` — Streaming route that consumes `mapSdkMessage()`
- **Data flow:**
  - **Working (JSONL):** JSONL file → `transcript-parser.ts` → `applyToolResult()` extracts text from `tool_result` blocks → client receives populated `ToolCallPart`
  - **Broken (streaming):** SDK emits `stream_event` → `mapSdkMessage()` yields `tool_call_start/delta/end` → SDK emits `user` message with `tool_result` blocks → **mapper ignores it** → SDK does NOT emit `tool_use_summary` for MCP → `tool_result` SSE never sent → client `ToolCallCard` shows empty
- **Feature flags/config:** None
- **Potential blast radius:**
  - Direct: 2 files (`sdk-event-mapper.ts`, `agent-types.ts`)
  - Tests: 2 files (`sdk-event-mapper.test.ts`, `sdk-scenarios.ts`)
  - Indirect: 0 — client handlers and UI components already work correctly

## 4) Root Cause Analysis

- **Repro steps:**
  1. Start dev server (`pnpm dev`)
  2. Open http://localhost:6241 and navigate to a session with MCP tools enabled
  3. Send a message that triggers an MCP tool call (e.g., "give me a mesh list")
  4. After response completes, expand the tool call card
  5. Observe: empty body (no input, no result)
  6. Reload the page (forces JSONL transcript load)
  7. Observe: same tool call card now shows full input and result
- **Observed vs Expected:** Streamed MCP tool calls show `hasInput: false, resultLen: 0`. Expected: same data as JSONL-loaded cards (`hasInput: true, inputLen: 2, hasResult: true, resultLen: ~11004`).
- **Evidence:**
  - `sdk-event-mapper.ts` lines 293-307: `tool_use_summary` is the ONLY path that emits `tool_result` SSE events
  - `stream-tool-handlers.ts` line 96 comment explicitly acknowledges MCP tools don't receive `tool_result`
  - `sdk-scenarios.ts` `sdkTodoWrite` confirms `tool_use_summary` fires for built-in tools
  - SDK type definitions confirm `SDKToolUseSummaryMessage` is a built-in tool feature
  - SDK `StdoutMessage` union includes `SDKStreamlinedToolUseSummaryMessage` (internal only)
- **Root-cause hypotheses:**
  1. **The SDK does not emit `tool_use_summary` for MCP tools** — the summary mechanism is specific to built-in SDK tools (Read, Bash, Edit, etc.). MCP tools follow a different execution path where results are recorded in JSONL via `SDKUserMessage` but never summarized into a streaming event. **Confidence: HIGH** (confirmed by type analysis, code paths, and existing comment in codebase)
  2. **`input_json_delta` events don't fire for empty-input MCP tools** — when an MCP tool takes no parameters (`{}`), the Anthropic API may emit no delta at all, leaving `input` as empty string on the streamed card. The JSONL stores the reconstructed `JSON.stringify(block.input)` = `'{}'`. **Confidence: MEDIUM** (needs live trace verification)
- **Decision:** Hypothesis 1 is confirmed as the root cause. The fix must intercept `SDKUserMessage` events in the mapper and extract `tool_result` blocks for MCP tools.

## 5) Research

- **Potential solutions:**
  1. **Process `SDKUserMessage` for MCP tool results (Recommended)**
     - The SDK emits `user` type messages containing `tool_result` content blocks after each assistant turn. Currently ignored by the mapper. Add a handler that extracts results and emits `tool_result` SSE events.
     - Pros: Correct, complete, real-time, no filesystem I/O, works with current SDK version
     - Cons: Requires deduplication for built-in tools (which also have `user` messages), needs `resolvedResultIds` tracking in `ToolState`
     - Complexity: Low-Medium | Reliability: High | Latency: Zero

  2. **Fallback JSONL read on session completion**
     - When the `result` message arrives, read the JSONL transcript for unresolved MCP tool results.
     - Pros: Simple, confirmed data source
     - Cons: Delayed (fires after `done`), filesystem I/O in hot path, JSONL flush race condition
     - Complexity: Medium | Reliability: Medium | Latency: High

  3. **Extract from `SDKAssistantMessage` (input fix only)**
     - Process the `assistant` message to backfill completed tool inputs with full `block.input` objects.
     - Pros: Fixes missing input without new event types
     - Cons: Doesn't fix missing result — partial fix only
     - Complexity: Low | Reliability: High

  4. **Use PostToolUse hook to capture MCP results**
     - Configure SDK hook to intercept MCP tool responses.
     - Pros: SDK-native mechanism
     - Cons: No clean way to bridge hook callback → SSE event; side-channel pattern is fragile
     - Complexity: High | Reliability: Low

- **Recommendation:** Approach 1 — Process `SDKUserMessage` for MCP tool results. This is the correct, complete, and lowest-latency fix. The deduplication concern is handled by a simple `resolvedResultIds: Set<string>` in `ToolState`. The client-side requires zero changes.

## 6) Decisions

No ambiguities identified — the investigation brief was thorough and the exploration/research findings converge on a clear fix approach. The `SDKUserMessage` processing approach is the only one that provides real-time results with high reliability.
