---
slug: tool-result-truncation
number: 137
created: 2026-03-16
status: ideation
---

# Tool Result Truncation

**Slug:** tool-result-truncation
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/tool-result-truncation

---

## 1) Intent & Assumptions

- **Task brief:** Add truncation to large tool results in `ToolCallCard.tsx`. Currently, tool results of any size render fully in the DOM — a 100KB+ tool output (e.g., a large file read or verbose bash output) can freeze the browser. Add a size threshold (~5KB) above which results are truncated with a "Show more" button that expands to full content. Also truncate large tool input JSON in the fallback path.
- **Assumptions:**
  - This is a client-only UX fix — no server or shared schema changes needed
  - The existing `ProgressOutput` component in `ToolCallCard.tsx` already implements the exact pattern (5KB threshold, string slice, "Show full output" button) for `progressOutput` — we extract and reuse it
  - The full result string stays in React state (cheap V8 heap primitive) — truncation happens at the render layer only
  - Auto-hidden tool cards render nothing, so truncation only matters for expanded cards
- **Out of scope:**
  - Virtualized rendering (TanStack Virtual) — overengineered for static content, conflicts with AnimatePresence
  - ANSI color code support in tool output
  - Specialized per-tool renderers (Bash terminal, Read file preview, etc.)
  - Server-side truncation of tool results

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`: Main component — already has `ProgressOutput` with 5KB truncation for progress, but `toolCall.result` renders as raw `<pre>` with no truncation (line 101-104)
- `apps/client/src/layers/features/chat/model/chat-types.ts`: `ToolCallState` interface — `result?: string` and `progressOutput?: string` fields, no changes needed
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Stores full result string from SSE — no changes needed
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Wraps ToolCallCard with `AutoHideToolCall` — no changes needed
- `apps/client/src/layers/shared/lib/tool-arguments-formatter.tsx`: Already truncates individual values at 120 chars, but raw JSON fallback path (parse failure) has no limit
- `contributing/design-system.md`: Calm Tech design language, typography, spacing
- `contributing/animations.md`: Motion library patterns, AnimatePresence, spring presets

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — Main component to modify. Contains `ProgressOutput` (lines 8-30) with `PROGRESS_TRUNCATE_BYTES = 5120`, expand/collapse chevron, tool card rendering
- `apps/client/src/layers/shared/lib/tool-arguments-formatter.tsx` — Tool input display with value truncation. Raw JSON fallback at line 82 needs truncation

**Shared dependencies:**

- `motion/react` — AnimatePresence, motion.div for expand/collapse
- `lucide-react` — Loader2, Check, X, ChevronDown icons
- `cn()` utility from shared/lib
- `getToolLabel()` and `ToolArgumentsDisplay` from shared/lib

**Data flow:**
Server SSE `tool_result` event → `stream-event-handler.ts` stores in `ToolCallPart.result` → `AssistantMessageContent.tsx` renders via `AutoHideToolCall` → `ToolCallCard.tsx` displays result as `<pre>`

**Feature flags/config:**

- `expandToolCalls: boolean` (Zustand) — expand all tool cards on load
- `autoHideToolCalls: boolean` (Zustand) — hide completed tool calls after delay

**Potential blast radius:**

- Direct: 2 files (`ToolCallCard.tsx`, `tool-arguments-formatter.tsx`)
- Indirect: None — no API, type, or schema changes
- Tests: 1 new test file for `ToolCallCard`

## 4) Root Cause Analysis

N/A — this is a UX improvement, not a bug fix.

## 5) Research

**Potential solutions:**

**1. CSS-only truncation (`max-height` + `overflow: hidden`)**

- Description: Apply `max-height` with `overflow: hidden`, toggle class to expand
- Pros: Zero JavaScript, instant toggle
- Cons: Full DOM still created — browser still computes layout for the entire text node. `whitespace-pre-wrap` on a 100KB string causes expensive line-breaking calculation regardless of visibility. Does NOT solve the performance problem.
- Complexity: Low
- Maintenance: Low

**2. String slicing at render layer (Recommended)**

- Description: Keep full string in React state, render `string.slice(0, 5120)` in the DOM, expand to full on button click
- Pros: DOM only receives 5KB (eliminates layout thrashing), full string stays as a cheap V8 heap primitive, matches existing `ProgressOutput` pattern exactly, simple to implement
- Cons: Expand to full content could still be slow for 100KB+ (acceptable — user explicitly requested it)
- Complexity: Low (extract existing pattern)
- Maintenance: Low

**3. Virtualized rendering (TanStack Virtual)**

- Description: Split content into lines, virtualize with TanStack Virtual, only render visible lines
- Pros: Handles arbitrarily large content with constant DOM size
- Cons: Requires fixed-height container (conflicts with AnimatePresence collapse), complex line-height calculation for `whitespace-pre-wrap`, overengineered for content that's usually auto-hidden, adds a dependency interaction
- Complexity: High
- Maintenance: High

**Recommendation:** String slicing at render (approach 2). The pattern already exists in the same file. CSS-only doesn't solve the actual problem. Virtualization is overengineered for content that users rarely expand.

## 6) Decisions

| #   | Decision                                 | Choice                           | Rationale                                                                                                                                                                                   |
| --- | ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Character-based vs line-based truncation | Character-based at 5KB           | Matches existing `PROGRESS_TRUNCATE_BYTES = 5120` pattern. Consistent, simple, handles both structured and unstructured output. A single very long line could bypass line-based truncation. |
| 2   | Virtualization on expand                 | No virtualization                | Full string in React state is cheap. TanStack Virtual conflicts with AnimatePresence collapse animations. Auto-hide already collapses most cards. Overengineered for the use case.          |
| 3   | Truncate tool inputs too                 | Yes, truncate raw JSON fallback  | `ToolArgumentsDisplay` already truncates parsed values at 120 chars, but the raw JSON fallback path (parse failure, line 82) has no limit. Apply same 5KB threshold for consistency.        |
| 4   | Extract shared component vs duplicate    | Extract shared `TruncatedOutput` | `ProgressOutput` and the new result truncation have identical logic (threshold, slice, show-more button, max-h-48). Extract once, both callers use it. Eliminates near-identical code.      |
