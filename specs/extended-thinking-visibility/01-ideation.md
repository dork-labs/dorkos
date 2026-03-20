---
slug: extended-thinking-visibility
number: 140
created: 2026-03-16
status: ideation
---

# Extended Thinking Visibility

**Slug:** extended-thinking-visibility
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/extended-thinking-visibility

---

## 1) Intent & Assumptions

- **Task brief:** Surface Claude's extended thinking in the DorkOS chat UI. The SDK emits `content_block_start` with type `thinking` and `content_block_delta` with type `thinking_delta`, but both are silently dropped in `sdk-event-mapper.ts`. Users have zero visibility into Claude's reasoning process. Map thinking blocks through the server, add a `ThinkingPart` to the `MessagePart` union, handle thinking deltas in `stream-event-handler.ts`, and design a client-side `ThinkingBlock.tsx` component.
- **Assumptions:**
  - Extended thinking is available on Opus/Sonnet models with extended thinking enabled
  - Thinking blocks always precede the response text within a single turn
  - Thinking content is plain text (not markdown) — raw internal monologue
  - The SDK's `content_block_start(thinking)` fires before any `content_block_delta(thinking_delta)` events, followed by `content_block_stop`, then `content_block_start(text)` + `text_delta` events
  - DorkOS already uses `motion` (Framer Motion) for animations and has established collapsible block patterns
- **Out of scope:**
  - Thinking budget configuration UI (belongs in a settings spec)
  - Server-side thinking content persistence or indexing
  - Thinking content in JSONL transcript history replay
  - User preference toggle for thinking visibility (v2 enhancement)
  - Thinking content search/filtering

## 2) Pre-reading Log

**Source:** `.temp/agent-sdk-audit.md` (comprehensive SDK implementation audit)

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: The mapper that transforms SDK messages into DorkOS StreamEvents. Lines 37-50 handle `content_block_start` but only check `contentBlock?.type === 'tool_use'` — thinking type falls through silently. Lines 51-68 handle `content_block_delta` but only check `delta?.type === 'text_delta'` and `'input_json_delta'` — `thinking_delta` falls through silently.
- `packages/shared/src/schemas.ts:29-47`: `StreamEventTypeSchema` — the enum of all SSE event types. Currently 16 types; needs a new `thinking_delta` type.
- `packages/shared/src/schemas.ts:323-350`: `MessagePartSchema` — discriminated union of `TextPart | ToolCallPart`. Needs a new `ThinkingPart` variant.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Client-side handler that processes SSE events into React state. Switch/case on event type at line 132. Needs a `thinking_delta` case.
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Renders message parts by mapping over `parts[]`. Currently handles `text`, `tool_call`, `approval`, and `question` types. Needs a `thinking` branch.
- `apps/server/src/services/runtimes/claude-code/agent-types.ts`: `ToolState` — mutable struct tracking tool call accumulation during streaming. May need a parallel `ThinkingState` or a flag to track thinking phase.

## 3) Codebase Map

**Source:** `.temp/agent-sdk-audit.md` + direct code verification

**Primary components/modules:**

- `sdk-event-mapper.ts` — Server: SDK → StreamEvent transformation (add thinking branches)
- `schemas.ts` — Shared: Zod schemas for `StreamEventType`, `MessagePart` (add `ThinkingPart`)
- `types.ts` — Shared: Re-exports from schemas (will auto-export new types)
- `stream-event-handler.ts` — Client: SSE → React state processor (add `thinking_delta` case)
- `AssistantMessageContent.tsx` — Client: Part renderer (add `thinking` branch)
- New: `ThinkingBlock.tsx` — Client: `features/chat/ui/ThinkingBlock.tsx`

**Shared dependencies:**

- `motion/react` — Animation library (already used by `AutoHideToolCall` in `AssistantMessageContent.tsx`)
- `@dorkos/shared/types` — Cross-package type imports
- `zod` — Schema definitions

**Data flow:**

```
SDK (thinking block)
  → sdk-event-mapper.ts (new branches for thinking start/delta/stop)
    → SSE stream
      → stream-event-handler.ts (new case: accumulate ThinkingPart)
        → AssistantMessageContent.tsx (render ThinkingBlock)
```

**Feature flags/config:** None needed for v1.

**Potential blast radius:**

- Direct: 6 files (mapper, schemas, types, stream handler, AssistantMessageContent, new ThinkingBlock)
- Indirect: Test files for mapper and stream handler
- Risk: Low — additive changes only, no modification of existing behavior

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

**Source:** `research/20260316_extended_thinking_visibility_ui_patterns.md` (research agent output)

The industry has converged on a **Progressive Disclosure Collapsible Block** as the standard pattern. Claude.ai, ChatGPT, Perplexity, and v0 all use variations: show thinking open during streaming, collapse when the response begins.

**Potential solutions:**

1. **Progressive Disclosure Accordion (recommended)** — Four-state `ThinkingBlock.tsx`: idle → streaming (open, breathing label + live text) → collapsing (animated height collapse) → collapsed ("Thought for Xs" chip with expand chevron). Auto-collapses when first `text_delta` arrives.
   - Pros: Matches Claude.ai reference implementation, honest by design, calm tech aligned, familiar to users
   - Cons: Requires stream phase detection, more states to manage
   - Complexity: Medium

2. **Inline Dimmed Text** — Thinking rendered inline before response in muted style, always visible.
   - Pros: Simplest implementation
   - Cons: Long thinking blocks dominate chat, violates "less but better", no transition handling
   - Complexity: Low
   - **Rejected** — violates Calm Tech and Dieter Rams principles

3. **Side Panel / Popover** — Thinking in a separate panel, accessed via button.
   - Pros: Clean main thread, excellent for long sessions
   - Cons: High complexity, context-switching cost, easy to ignore entirely
   - Complexity: High
   - **Rejected for v1** — consider as opt-in view in future

**Recommendation:** Solution 1 — Progressive Disclosure Accordion. Three reasons:

1. **Honest by design** — collapsed chip always present; nothing silently discarded
2. **Calm Tech alignment** — open when relevant (during streaming), collapsed when the answer is the focus
3. **The Kai Test** — Kai debugging agent output wants to glance at reasoning, not scroll past walls of thinking text

**Key implementation details from research:**

- Use CSS `grid-template-rows: 0fr → 1fr` for collapse transition (no JS height measurement)
- Buffer `thinking_delta` events and flush at ~50ms intervals via `requestAnimationFrame`
- Cap expanded block at `max-h-64 overflow-y-auto` for long thinking sessions
- ARIA contract: `button[aria-expanded]` header + `div[role=region]` content
- Follow the same structural contract as the planned SubagentBlock for visual consistency

**Performance considerations:**

- Thinking blocks can emit 100–10,000+ tokens — must efficiently append without re-rendering entire message list
- Use ref-based buffer that flushes to state at controlled rate
- CSS transitions over JS-driven height animations

## 6) Decisions

| #   | Decision                                        | Choice              | Rationale                                                                                                                                               |
| --- | ----------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Stream thinking text live or show summary only? | Live streaming      | Matches Claude.ai approach, satisfies "honest by design" principle. Users can watch the reasoning process in real-time during generation.               |
| 2   | FSD layer placement for ThinkingBlock.tsx       | `features/chat/ui/` | Co-located with other chat message renderers (StreamingText, ToolCallCard). The thinking block is chat-specific and tightly coupled to streaming state. |
| 3   | Collapsed label content                         | Elapsed time only   | Show "Thought for 8s" — simple, human-readable, mirrors Claude.ai. Token count adds noise; can be added later as a tooltip enhancement.                 |
