# MCP Tool Result Streaming — Task Breakdown

**Spec:** `specs/mcp-tool-result-streaming/02-specification.md`
**Generated:** 2026-03-23
**Mode:** Full decomposition

---

## Overview

This task breakdown implements the fix for MCP tool results missing during live streaming sessions. The root cause is that `sdk-event-mapper.ts` only emits `tool_result` SSE events via `tool_use_summary`, which the Claude Code Agent SDK only emits for built-in tools. MCP tool results arrive in `SDKUserMessage` events that the mapper currently ignores.

**Scope:** 5 phases, 5 tasks. All changes are server-side — zero client modifications needed.

**Files changed:**

- `apps/server/src/services/runtimes/claude-code/agent-types.ts` — ToolState interface extension
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — New handlers + tracking
- `apps/server/src/services/core/__tests__/sdk-event-mapper.test.ts` — New test cases + helper update
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts` — New scenario builder

---

## Phase 1: Foundation

### Task 1.1 — Extend ToolState with resolvedResultIds and toolInputReceived tracking sets

**Size:** Small | **Priority:** High | **Dependencies:** None

Add `resolvedResultIds: Set<string>` and `toolInputReceived: Set<string>` to the `ToolState` interface and `createToolState()` factory in `agent-types.ts`. Also update the test helper `makeToolState()` in `sdk-event-mapper.test.ts` to include both new fields.

- `resolvedResultIds` tracks tool IDs whose results were already delivered via `tool_use_summary` (used for deduplication)
- `toolInputReceived` tracks tool IDs that received at least one `input_json_delta` during streaming (used to determine if input backfill is needed)

---

## Phase 2: Server Mapper — Deduplication & Input Tracking

### Task 2.1 — Mark resolved tool IDs in tool_use_summary handler and track input_json_delta reception

**Size:** Small | **Priority:** High | **Dependencies:** 1.1

Two single-line additions to existing handlers in `sdk-event-mapper.ts`:

1. In `tool_use_summary` handler: add `toolState.resolvedResultIds.add(toolUseId)` before yielding
2. In `input_json_delta` handler: add `toolState.toolInputReceived.add(toolState.currentToolId)` before existing logic

These are prerequisites for the new handlers in Phase 3.

---

## Phase 3: Server Mapper — New Handlers

### Task 3.1 — Add assistant message handler for MCP tool input backfill

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1 | **Parallel with:** 3.2

Add handler for `message.type === 'assistant'` that iterates `tool_use` blocks and emits `tool_call_delta` with serialized input for tools that never received `input_json_delta`. Fixes empty `{}` input display for MCP tools.

### Task 3.2 — Add user message handler for MCP tool results with extractToolResultText helper

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1 | **Parallel with:** 3.1

Add handler for `message.type === 'user'` that extracts `tool_result` blocks and emits `tool_result` SSE events for unresolved MCP tool calls. Includes:

- Replay guard (`isReplay: true` skips)
- Deduplication via `resolvedResultIds`
- File-local `extractToolResultText` helper

This is the **primary fix** — it delivers MCP tool results during live streaming.

---

## Phase 4: Test Scenarios

### Task 4.1 — Add sdkMcpToolCall scenario builder to sdk-scenarios.ts

**Size:** Small | **Priority:** High | **Dependencies:** 3.1, 3.2

Add `sdkMcpToolCall(toolName, toolId, input, resultContent)` scenario builder that produces the full MCP event sequence: init -> content_block_start -> optional input_json_delta -> content_block_stop -> assistant message -> user message -> result. Also add `sdkReplayUserMessage` helper for replay guard testing.

---

## Phase 5: Tests

### Task 5.1 — Add comprehensive test cases for MCP tool result streaming

**Size:** Large | **Priority:** High | **Dependencies:** 4.1

Add 7 new test cases in a `MCP tool result streaming` describe block:

1. **MCP tool result via user message** — Verifies `tool_result` SSE events from user messages
2. **Deduplication** — `tool_use_summary` + user message for same ID yields only one result
3. **Input backfill** — Assistant message yields `tool_call_delta` with `'{}'` when no input delta was received
4. **Input backfill skipped** — No extra delta when `input_json_delta` was already received
5. **Replay guard** — `isReplay: true` user messages yield nothing
6. **Mixed tool calls** — Built-in + MCP tools in same session both get correct results
7. **String content** — `extractToolResultText` handles plain string content

---

## Dependency Graph

```
1.1 (ToolState extension)
 └── 2.1 (Tracking in existing handlers)
      ├── 3.1 (Assistant message handler)  ─┐
      └── 3.2 (User message handler)       ─┤ parallel
                                             │
                                             └── 4.1 (Scenario builder)
                                                  └── 5.1 (Tests)
```

## Acceptance Criteria (Full Feature)

1. MCP tool results appear in the `ToolCallCard` during live streaming (not just on page reload)
2. MCP tool input (`'{}'` for parameterless tools) displays in the expanded card during streaming
3. Built-in tool results continue to work correctly (no regression)
4. No duplicate `tool_result` events for built-in tools (deduplication verified by test)
5. Session resume/replay does not re-emit stale tool results
6. All existing `sdk-event-mapper.test.ts` tests continue to pass
7. At least 6 new test cases covering MCP results, deduplication, input backfill, replay guard
