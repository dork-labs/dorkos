---
slug: tool-progress-streaming
number: 139
created: 2026-03-16
status: ideation
---

# Tool Progress Streaming

**Slug:** tool-progress-streaming
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/tool-progress-streaming

---

## 1) Intent & Assumptions

- **Task brief:** Handle `tool_progress` SDK messages that are currently silently dropped. When Claude executes long-running tools (Bash, file searches, large reads), the SDK emits `tool_progress` events with intermediate output, but `sdk-event-mapper.ts` ignores them. Map `tool_progress` through the server as a new StreamEvent type and render progressive output within the ToolCallCard so users see tool execution as it happens.
- **Assumptions:**
  - `tool_progress` carries `{ type: 'tool_progress', tool_use_id: string, content: string }` — a tool_use_id that correlates with an active tool call, and text content representing intermediate output
  - The existing tool call lifecycle (start → delta → end → result) can be augmented with progress events arriving between `tool_call_start` and `tool_call_end`/`tool_result`
  - Progress content is plain text (stdout/stderr from Bash, file content from Read, search results from Glob/Grep)
  - Multiple `tool_progress` events may arrive for a single tool call — content should accumulate
- **Out of scope:**
  - Specialized per-tool renderers (Bash terminal with ANSI, syntax-highlighted Read, etc.) — P3 #8 in the audit
  - Subagent progress (`task_progress`) — separate P0 item, already spec'd
  - Tool result truncation for existing `tool_result` events — separate P2 item (though this spec includes truncation for progress output)
  - Extended thinking (`thinking_delta`) — separate P1 item

## 2) Pre-reading Log

**Source:** `.temp/agent-sdk-audit.md` + codebase exploration

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: Pure async generator with sequential if-blocks. Handles 4 top-level message types (`system/init`, `stream_event`, `tool_use_summary`, `result`). No branch for `tool_progress`. Unknown types fall through silently (no catch-all).
- `apps/server/src/services/runtimes/claude-code/agent-types.ts:22-30`: `ToolState` interface tracks `inTool`, `currentToolName`, `currentToolId`, `taskToolInput`. No field for progress accumulation.
- `packages/shared/src/schemas.ts:29-50`: `StreamEventTypeSchema` enum — 19 types including recently-added `subagent_started/progress/done`. No `tool_progress` type.
- `packages/shared/src/schemas.ts:170-180`: `ToolCallEventSchema` — fields: `toolCallId`, `toolName`, `input`, `result`, `status`. No field for intermediate progress.
- `packages/shared/src/schemas.ts:374-388`: `ToolCallPartSchema` — same fields as event schema plus `interactiveType`, `questions`, `answers`. No progress field.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts:179-188`: `tool_call_delta` handler appends to `input` field only. No mechanism for progress output.
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx:14-76`: Renders status icon + label header, expandable body with `input` (ToolArgumentsDisplay) and `result` (`<pre>` block). No progress rendering. No truncation on result display.
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx:118-167`: Part iteration dispatches tool_call parts to `AutoHideToolCall` → `ToolCallCard`.
- `apps/server/src/services/core/__tests__/sdk-event-mapper.test.ts:308-319`: Explicitly tests that unknown message types yield nothing and don't throw. No test for `tool_progress`.

## 3) Codebase Map

**Source:** Codebase exploration agent

**Primary components/modules:**

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — SDK message → StreamEvent mapper (add new branch)
- `packages/shared/src/schemas.ts` — Zod schemas for events and message parts (add type + schema + field)
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Client event handler (add switch case)
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — Tool call renderer (add progress display)

**Shared dependencies:**

- `apps/server/src/services/runtimes/claude-code/agent-types.ts` — `ToolState` interface (no changes needed — tool_use_id lookup is sufficient)
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — Part renderer (no changes — existing `ToolCallCard` dispatch covers it)
- `apps/client/src/layers/features/chat/ui/AutoHideToolCall.tsx` — Auto-hide wrapper (may need adjustment for auto-expand behavior)

**Data flow:**

```
SDK emits tool_progress { tool_use_id, content }
  → sdk-event-mapper.ts yields StreamEvent { type: 'tool_progress', toolCallId, content }
    → SSE transport delivers to client
      → stream-event-handler.ts finds matching ToolCallPart, appends to progressOutput
        → ToolCallCard re-renders with streaming progress in expanded state
```

**Feature flags/config:** None needed — this is core pipeline behavior.

**Potential blast radius:**

- Direct: 4 files (mapper, schemas, handler, ToolCallCard)
- Indirect: AutoHideToolCall may need auto-expand logic; existing `tool_call_delta` handler unchanged
- Tests: 2 test files (mapper test, ToolCallCard test if one exists)

## 4) Root Cause Analysis

N/A — this is a feature gap, not a bug.

## 5) Research

**Source:** `.temp/agent-sdk-audit.md` section 2.4 + architecture analysis

**Potential solutions:**

**1. New `tool_progress` StreamEvent type (chosen)**

- Description: Add a dedicated `tool_progress` entry to the StreamEventTypeSchema enum with its own Zod schema carrying `toolCallId` and `content`. Add `progressOutput` field to `ToolCallPartSchema` for accumulation.
- Pros:
  - Semantic clarity — separate event for a separate concern
  - Clean client handler — distinct switch case, no ambiguity with `tool_call_delta`
  - Follows the pattern established by `subagent_started/progress/done` (each distinct)
  - Future extensibility (could add metadata like byte count, progress percentage)
- Cons:
  - More schema additions than extending `tool_call_delta`
  - New switch case in handler (minimal overhead)
- Complexity: Medium
- Maintenance: Low

**2. Extend existing `tool_call_delta` event**

- Description: Add a `progress` field to `ToolCallEventSchema`. Reuse the same event type for both input JSON deltas and progress output.
- Pros:
  - Fewer schema changes
  - Simpler server-side mapping
- Cons:
  - Handler must distinguish "input JSON" vs "progress output" within same event
  - Semantic overloading — one event type with two meanings
  - Makes the handler logic more complex (if input → append to input, if progress → append to progressOutput)
- Complexity: Low (server), Medium (client)
- Maintenance: Medium (dual semantics create future confusion)

**Recommendation:** Option 1 — new `tool_progress` event type. The marginal cost of a dedicated event type is small, and semantic clarity pays dividends as the audit identifies more event types to add. The subagent events set the precedent.

## 6) Decisions

| #   | Decision                            | Choice                                                   | Rationale                                                                                                  |
| --- | ----------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Event modeling for tool_progress    | New dedicated `tool_progress` StreamEvent type           | Semantic clarity, follows subagent event pattern, cleaner client handler with distinct switch case         |
| 2   | Rendering behavior during execution | Auto-expand ToolCallCard with streaming monospace output | Primary UX win — users see tool output as it arrives. Card collapses per normal auto-hide after completion |
| 3   | Output truncation                   | Truncate at ~5KB with "Show more" affordance             | Prevents browser freeze risk (audit P2 #1) from also affecting progress. Addresses two concerns at once    |
