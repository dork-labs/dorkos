---
slug: system-status-compact-boundary
number: 136
created: 2026-03-16
status: ideation
---

# Surface SDK System Status Messages & Compact Boundary Events

**Slug:** system-status-compact-boundary
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/system-status-compact-boundary

---

## 1) Intent & Assumptions

- **Task brief:** Surface SDK `system` messages with subtype `status` (e.g., "Compacting context...", permission mode changes) and `compact_boundary` (context window compaction marker) in the DorkOS chat UI. Both are currently silently dropped in `sdk-event-mapper.ts`. Users have no visibility into what the agent is doing during these pauses — context compaction looks like a freeze. This addresses punch list items #9 and #10 from the agent SDK audit.
- **Assumptions:**
  - Status messages are ephemeral operational feedback — they should NOT pollute message history
  - Compact boundaries are significant conversation events — they deserve a persistent visual divider
  - The existing `messageType: 'compaction'` in `ChatMessage` was designed for exactly this purpose
  - Both event types have low blast radius — additive changes only, no modifications to existing handlers
  - The InferenceIndicator remains the primary streaming state display; status zone supplements it
- **Out of scope:**
  - Hook events (`hook_started`, `hook_progress`, `hook_response`) — separate P2 item
  - Persisting compact boundaries in JSONL history replay — deferred to P3
  - Status messages in the InferenceIndicator (decided against — only visible during streaming)
  - Prompt suggestions (`prompt_suggestion`) — separate P2 item

## 2) Pre-reading Log

- `.temp/agent-sdk-audit.md`: Comprehensive audit of SDK message handling — matrix items #9 and #10 are the targets
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: Main mapper. Lines 48-94 handle system messages but only `init`, `task_started`, `task_progress`, `task_notification`. Status and compact_boundary fall through silently
- `packages/shared/src/schemas.ts`: StreamEventTypeSchema has 21 event types. Missing `system_status` and `compact_boundary`. ThinkingDeltaSchema and ToolProgressEventSchema serve as precedent schemas
- `packages/shared/src/types.ts`: Type re-exports — needs new types added
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Client event handler switch statement. ~450 lines. Missing cases for new event types
- `apps/client/src/layers/features/chat/model/chat-types.ts`: `ChatMessage.messageType` already includes `'compaction'` — designed for this
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Parts dispatcher. Handles text, subagent, error, thinking, tool_call. No system_status rendering
- `specs/extended-thinking-visibility/`: Complete pattern for adding new StreamEvent types (thinking_delta)
- `specs/tool-progress-streaming/`: Precedent for dedicated event types (ADR-0138 semantic clarity)
- `decisions/0138-dedicated-tool-progress-event-type.md`: ADR establishing pattern of separate event types for semantic clarity
- `decisions/0139-single-thinking-delta-event-type.md`: ADR establishing implicit phase transitions, single event types

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — SDK message to StreamEvent mapper (lines 48-94: system message dispatch)
  - `packages/shared/src/schemas.ts` — Zod schemas (lines 29-54: StreamEventTypeSchema enum)
  - `packages/shared/src/types.ts` — Type re-exports
  - `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Client event handler (switch statement ~line 161+)
  - `apps/client/src/layers/features/chat/model/chat-types.ts` — ChatMessage type with `messageType: 'compaction'`
  - `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — Parts rendering dispatcher
  - `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Chat panel composition
  - `apps/client/src/layers/features/chat/ui/MessageList.tsx` — Message list rendering

- **Shared dependencies:**
  - `@dorkos/shared/types` — StreamEvent, MessagePart type unions
  - `@dorkos/shared/schemas` — Zod validation schemas
  - `lucide-react` — Icons (RefreshCw for compaction, Info for status)
  - `motion` — AnimatePresence for ephemeral status zone fade

- **Data flow:**
  - SDK stream → `mapSdkMessage()` yields `system_status` / `compact_boundary` → SSE transport → `stream-event-handler.ts` switch → update React state → render

- **Feature flags/config:** None required

- **Potential blast radius:**
  - Direct: 8 files modified + 1 new component + 1 new component
  - Indirect: MessageList.tsx (renders compaction messages), ChatPanel.tsx (hosts status zone)
  - Tests: 3-4 new test files, existing tests unaffected (additive only)

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

Research agent analyzed 22 sources across AI chat UIs, notification patterns, and conversation boundary designs.

### Potential Solutions

**1. Ephemeral Status Zone + Hairline Compact Divider (Recommended)**

- Description: Two distinct treatments matching the temporal semantics. Status messages appear in a single-line ephemeral zone between MessageList and ChatInput, auto-fading after 4s. Compact boundaries render as a centered hairline divider injected as a standalone `ChatMessage` with `messageType: 'compaction'`.
- Pros:
  - Matches established patterns (Slack typing indicator for ephemeral, Slack date separator for persistent)
  - No message history pollution from status messages
  - Compact boundary is visually distinct as a conversation event
  - Low implementation complexity — ~360 LOC total
- Cons:
  - Status zone is only visible when the message is active (4s window)
  - Requires two new components instead of one
- Complexity: Low-Medium
- Maintenance: Low

**2. InferenceIndicator Integration (Status Only)**

- Description: Replace the rotating verb in InferenceIndicator with status text while active. Compact boundary rendered inline.
- Pros:
  - Zero new UI components for status
  - Reuses existing animation infrastructure
- Cons:
  - Only visible during streaming (not after)
  - Mixes operational status with personality-rich indicator
  - Doesn't work for permission mode changes that happen outside streaming
- Complexity: Low
- Maintenance: Low

**3. Inline Message Parts (Both)**

- Description: Render both as muted system message parts within the assistant message, like ErrorMessageBlock.
- Pros:
  - Simple implementation — follow existing ErrorMessageBlock pattern exactly
  - Both persist in conversation history
- Cons:
  - VS Code Copilot's `"Summarized conversation history"` inline approach drew user complaints about clutter
  - Status messages are transient — embedding them in messages creates permanent noise
  - Compact boundaries lose visual distinction as conversation-level events
- Complexity: Low
- Maintenance: Low

### Industry Patterns

- **VS Code Copilot**: Inline `"Summarized conversation history"` after agent actions — users complained about visual clutter, requested toggle
- **Cursor**: Added context indicator arc → removed it → community backlash → added toggle back. Lesson: make it subtle, optional
- **Slack**: Typing indicators in dedicated zone below messages (ephemeral). "Joined the channel" as centered text between hairline rules (persistent system events)
- **Stream Chat SDK**: `DateSeparator` component — direct React implementation reference for divider pattern
- **Carbon Design System**: Toast notifications auto-dismiss at 4-6s for informational content

### Recommendation

**Solution 1 (Ephemeral Status Zone + Hairline Compact Divider)** because:

- Respects the opposite temporal semantics (ephemeral vs permanent)
- Avoids the clutter trap that VS Code Copilot fell into
- Aligns with the Calm Tech design philosophy (unobtrusive, informative when needed)
- The `messageType: 'compaction'` field already exists — this is completing an incomplete feature

## 6) Decisions

| #   | Decision                                   | Choice                                                  | Rationale                                                                                                                                  |
| --- | ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | How to display system status messages      | Ephemeral status zone between MessageList and ChatInput | Auto-fades after 4s. Matches Slack typing indicator pattern. Doesn't pollute message history. Avoids VS Code Copilot's clutter complaints. |
| 2   | How to display compact boundary            | Centered hairline divider as standalone message         | Matches Slack date separator pattern. Uses existing `messageType: 'compaction'`. Visually distinct conversation boundary.                  |
| 3   | History persistence for compact boundaries | Stream-only, transient                                  | Simplest implementation — no JSONL parsing changes. Can add persistence in P3 if needed.                                                   |
