---
slug: tool-call-display-overhaul
number: 169
created: 2026-03-23
status: ideation
---

# Tool Call Display Overhaul

**Slug:** tool-call-display-overhaul
**Author:** Claude Code
**Date:** 2026-03-23
**Branch:** preflight/tool-call-display-overhaul

---

## 1) Intent & Assumptions

- **Task brief:** Overhaul the tool call display in the DorkOS chat UI: fix broken MCP tool name rendering, fix the empty card body bug during SSE streaming, improve input/output formatting with JSON tree rendering and diff support, and add execution duration display. The goal is to make tool calls genuinely informative and beautiful — a first-class observability surface, not an afterthought.
- **Assumptions:**
  - Changes are primarily client-side (shared/lib utilities + features/chat components)
  - The streaming event pipeline (server-side SDK mapper) is working correctly — the bug is in client rendering, not data flow
  - New library additions (react-json-view-lite, ansi-to-react, react-diff-viewer-continued) are acceptable; lazy-load heavier deps
  - Existing auto-hide and truncation features remain intact
  - Execution duration tracking requires adding timestamp fields to client-side ToolCallState
- **Out of scope:**
  - Server-side changes to the SDK event mapper or SSE protocol
  - Tool call grouping (5+ sequential calls → summary) — separate spec
  - Syntax highlighting for file content via Shiki — separate spec
  - Clickable file paths in results — separate spec
  - Virtual scrolling for large outputs
  - Persisting hooks/progress data in transcripts (server-side JSONL changes)

## 2) Pre-reading Log

- `apps/client/src/layers/shared/lib/tool-labels.ts`: Label generation for tool call headers. Has 15 explicit cases for SDK tools but **no MCP handling** — `default` returns raw `toolName`, so `mcp__slack__send_message` shows as-is.
- `apps/client/src/layers/shared/lib/tool-arguments-formatter.tsx`: Renders tool input as key-value grid. Falls back to raw `<pre>` when JSON.parse fails (partial JSON during streaming). No type-specific rendering per tool.
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`: Main card component. `TruncatedOutput` handles result/progress display with 5KB threshold. Card body renders nothing when `input` is `''` (falsy).
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Maps message parts to components. `AutoHideToolCall` passes `input: part.input || ''` to ToolCallCard. `expandToolCalls` setting controls default expansion.
- `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts`: Tool lifecycle event handlers. `handleToolCallStart` creates part with `input: ''`. `handleToolCallDelta` accumulates `existing.input += tc.input`. Input is partial JSON during streaming.
- `apps/client/src/layers/features/chat/ui/primitives/CollapsibleCard.tsx`: Shared accordion used by ToolCallCard, SubagentBlock, ThinkingBlock. Spring-animated chevron, motion height transitions.
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: Maps SDK messages to DorkOS StreamEvents. Confirms `tool_call_delta` events carry `partial_json` chunks, not full input.
- `apps/server/src/services/runtimes/claude-code/transcript-parser.ts`: Reconstructs tool calls from JSONL. All historical tool calls have `status: 'complete'` with full input/result. Hooks are NOT persisted.
- `specs/auto-hide-tool-calls/02-specification.md`: Already implemented. Auto-hide after 2s on complete, visible for errors/failed hooks.
- `specs/tool-result-truncation/02-specification.md`: Already implemented. 5KB TruncatedOutput, shared by result and progress output.
- `research/20260304_mcp_tool_naming_conventions.md`: Confirms `mcp__server__tool` format is Anthropic SDK convention. 90%+ MCP servers use snake_case.
- `research/20260316_subagent_activity_streaming_ui_patterns.md`: Streaming state machine, CSS grid height animation, formatSummaryBadge pattern.
- `research/20260323_tool_call_display_overhaul.md`: Fresh research on libraries, JSON viewers, diff rendering, ANSI support.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/shared/lib/tool-labels.ts` — MCP name bug location, label generation
  - `apps/client/src/layers/shared/lib/tool-arguments-formatter.tsx` — Input rendering (key-value grid)
  - `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — Main card with TruncatedOutput
  - `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — AutoHideToolCall wrapper, part mapping
  - `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts` — SSE event handlers for tool lifecycle
  - `apps/client/src/layers/features/chat/model/chat-types.ts` — ToolCallState, ChatMessage types
  - `apps/client/src/layers/features/chat/ui/primitives/CollapsibleCard.tsx` — Accordion primitive

- **Shared dependencies:**
  - `@dorkos/shared/types` — ToolCallEvent, MessagePart, HookPart schemas
  - `@dorkos/shared/constants` — SDK_TOOL_NAMES
  - `@/layers/shared/lib` — cn(), TIMING constants
  - `@/layers/shared/model` — useAppStore (expandToolCalls, autoHideToolCalls settings)
  - `motion/react` — AnimatePresence, motion.div
  - `lucide-react` — Check, X, Loader2, ChevronDown icons

- **Data flow:**

  ```
  SDK → sdk-event-mapper → SSE events → stream-tool-handlers →
    currentPartsRef (mutable) → updateAssistantMessage() → setMessages() →
    AssistantMessageContent → AutoHideToolCall → ToolCallCard →
      CollapsibleCard (header: getToolLabel + statusIcon)
      ToolArgumentsDisplay (body: parsed JSON input)
      TruncatedOutput (body: result/progress text)
  ```

- **Potential blast radius:**
  - Direct: 5 files (tool-labels.ts, tool-arguments-formatter.tsx, ToolCallCard.tsx, stream-tool-handlers.ts, chat-types.ts)
  - Indirect: AssistantMessageContent.tsx, CollapsibleCard.tsx (rendering changes)
  - Tests: tool-labels.test.ts (MCP cases), ToolCallCard.test.tsx (streaming body, duration), tool-arguments-formatter.test.tsx (new tests for JSON/raw toggle)

## 4) Root Cause Analysis

### Bug 1: MCP Tool Name Display

- **Observed:** MCP tool calls show raw names like `mcp__dorkos__relay_send`, `mcp__slack__send_message` in the tool card header.
- **Expected:** Humanized display like `[Slack] Send message` or `Relay Send`.
- **Root cause:** `getToolLabel()` in `tool-labels.ts:93` has a `default` case that returns `toolName` unchanged. No parsing logic exists for the `mcp__<server>__<tool>` naming pattern.
- **Evidence:** The function has 15 explicit `case` statements for SDK tools (Bash, Read, Write, etc.) but zero handling for `mcp__` prefixed names.

### Bug 2: Empty Tool Card Body During Streaming

- **Observed:** When a tool call card is expanded during streaming (either via `expandToolCalls` setting or manual click), the body area shows no content.
- **Expected:** Should show accumulating input parameters or at minimum a loading indicator.
- **Root cause:** Three factors combine:
  1. `handleToolCallStart` creates the part with `input: ''` (line 43 of stream-tool-handlers.ts)
  2. `ToolCallCard.tsx:151` guards with `{toolCall.input && <ToolArgumentsDisplay>}` — empty string is falsy, so nothing renders
  3. Neither `progressOutput` nor `result` exist yet → the entire card body is empty
- **Evidence:** The `ToolArgumentsDisplay` condition `{toolCall.input && ...}` is a truthiness check. `''` is falsy in JavaScript. Between `tool_call_start` and the first `tool_call_delta`, and for tools with empty input, the body renders nothing.

### Bug 3 (secondary): Partial JSON Display During Streaming

- **Observed:** After deltas start arriving, `ToolArgumentsDisplay` receives partial JSON like `'{"command":"ls'`, which fails `JSON.parse`, falling back to raw `<pre>` showing garbled partial text.
- **Expected:** During streaming, show raw accumulating text gracefully (or defer formatted display until input is complete).
- **Root cause:** `ToolArgumentsDisplay` always tries `JSON.parse` first (line 80). During streaming, the accumulated input is incomplete JSON, so it hits the raw `<pre>` fallback every render until `tool_call_end`.

## 5) Research

### MCP Tool Name Display

Three approaches evaluated:

1. **Badge + humanized name** — `[Slack] Send message` with colored server badge. Hide badge for DorkOS's own tools (implicit context). **Selected.**
2. **Humanized name only** — Simpler but ambiguous with multiple MCP servers.
3. **Dot-separated** — `Slack > Send message`. Acceptable but less visually distinct.

The `mcp__server__tool` format is an Anthropic SDK convention. Parse by splitting on `__`, extract server name (index 1) and tool name (index 2+). Known server names get a display name override map (`dorkos` → `DorkOS`, `slack` → `Slack`). Tool names get `snake_case` → `Title Case` humanization.

### Input/Output Formatting

**react-json-view-lite** (~8KB gzip, zero deps) is the recommended JSON viewer. 18x faster than react-json-view (82ms vs 1,540ms median on 300KB JSON). Collapsible tree, keyboard navigation, ARIA tree pattern, CSS class API compatible with Tailwind.

For tool outputs, classify content before rendering:

- JSON detection → `react-json-view-lite` tree
- ANSI codes → `ansi-to-react` styled output
- Plain text → existing `TruncatedOutput`

**react-diff-viewer-continued** (active fork, 582K weekly downloads) for Edit tool diff rendering. Lazy-loaded since it's ~1.08MB and only used for Edit operations. Inline unified diff mode (not side-by-side — inappropriate for chat column width).

**ansi-to-react** (~15KB, nteract) for Bash/terminal output with ANSI color codes. Zero config, actively maintained.

### Streaming Display Fix

The research confirms: during active streaming, use `duration: 0` for any height transitions (no animation — instant snap). Only animate on user-triggered expand/collapse after completion. Show raw accumulating text during streaming, switch to formatted display after `tool_call_end`.

### Execution Duration

Industry standard (Chrome DevTools, VS Code) uses tiered format: `<100ms` → `347ms` → `1.2s` → `14s` → `1m 23s`. Decimals only meaningful below 10 seconds. Track `startedAt` on `tool_call_start` and `completedAt` on `tool_result`.

## 6) Decisions

| #   | Decision                     | Choice                                                                         | Rationale                                                                                                                                    |
| --- | ---------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | MCP tool name display format | Badge + humanized name                                                         | Clear namespacing that scales to third-party MCP servers. Hide DorkOS badge for own tools since it's implicit context.                       |
| 2   | Streaming display fix        | Show raw text during streaming, formatted after complete                       | Avoids partial JSON parse failures. Users see accumulating input in real-time. Switch to key-value grid or JSON tree once input is complete. |
| 3   | New library additions        | Full stack: react-json-view-lite + ansi-to-react + react-diff-viewer-continued | JSON tree for complex inputs/outputs, ANSI for terminal colors, diff for Edit operations. Lazy-load the diff viewer (~1.08MB).               |
| 4   | Execution duration           | Yes, tiered format on completed cards                                          | Low effort, high developer-facing value. Subtle badge next to status icon.                                                                   |
| 5   | Output rendering strategy    | Content-type classifier: JSON → tree, ANSI → styled, plain → TruncatedOutput   | Progressive enhancement — each tool type gets the most appropriate renderer without affecting others.                                        |
