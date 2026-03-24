# Implementation Summary: Fix MCP Tool Results Missing During Streaming

**Created:** 2026-03-23
**Last Updated:** 2026-03-23
**Spec:** specs/mcp-tool-result-streaming/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 6 / 6

## Tasks Completed

### Session 1 - 2026-03-23

- Task #1: [P1] Extend ToolState with resolvedResultIds and toolInputReceived tracking sets
- Task #2: [P2] Mark resolved tool IDs in tool_use_summary handler and track input_json_delta reception
- Task #3: [P3] Add assistant message handler for MCP tool input backfill
- Task #4: [P3] Add user message handler for MCP tool results with extractToolResultText helper
- Task #5: [P4] Add sdkMcpToolCall scenario builder to sdk-scenarios.ts
- Task #6: [P5] Add comprehensive test cases for MCP tool result streaming in sdk-event-mapper.test.ts

## Files Modified/Created

**Source files:**

- `apps/server/src/services/runtimes/claude-code/agent-types.ts` — Added `resolvedResultIds` and `toolInputReceived` Sets to ToolState interface and createToolState() factory
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — Added `extractToolResultText` helper, assistant message handler (input backfill), user message handler (MCP results with replay guard and deduplication), tracking in input_json_delta and tool_use_summary handlers

**Test files:**

- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts` — Added `sdkMcpToolCall` scenario builder and `sdkReplayUserMessage` helper
- `apps/server/src/services/core/__tests__/sdk-event-mapper.test.ts` — Updated `makeToolState()` helper, added 7-test "MCP tool result streaming" describe block

## Known Issues

_(None)_

## Implementation Notes

### Session 1

All 6 tasks implemented in a single agent session. All 22 tests pass (15 existing + 7 new). TypeScript compiles cleanly. Zero client-side changes — the fix is entirely server-side as specified.
