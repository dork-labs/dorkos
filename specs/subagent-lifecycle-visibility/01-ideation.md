---
slug: subagent-lifecycle-visibility
number: 137
created: 2026-03-16
status: ideation
---

# Subagent Lifecycle Visibility

**Slug:** subagent-lifecycle-visibility
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/subagent-lifecycle-visibility

---

## 1) Intent & Assumptions

- **Task brief:** Surface subagent lifecycle in the chat UI. The SDK emits `task_started`, `task_progress`, and `task_notification` messages when Claude spawns subagents via the Task tool, but all three are silently dropped. Users have zero visibility into subagent operations. Design the full subagent visibility story: server mapping, shared schema additions, and client rendering.
- **Assumptions:**
  - The SDK's `system` message subtypes (`task_started`, `task_progress`, `task_notification`) are stable and documented in the Agent SDK
  - `task_progress` content blocks contain text and tool_use summaries from the subagent's stream
  - The existing StreamEvent pipeline (mapper -> SSE -> client handler -> component) is the correct integration path
  - Subagent sessions have unique `session_id` values that can be used as correlation keys
- **Out of scope:**
  - `tool_progress` events (separate audit item #8)
  - Extended thinking blocks (audit items #2c, #2g)
  - Rate limit handling (audit item #15)
  - Recursive subagent nesting (v1 is single-level only)
  - History reconstruction of subagent blocks from JSONL (follow-up work)

## 2) Pre-reading Log

**Source:** `.temp/agent-sdk-audit.md` + direct file reads for validation

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: Pure async generator mapping SDK messages to StreamEvents. Only handles `system/init`, `stream_event`, `tool_use_summary`, and `result`. System messages with non-`init` subtypes fall through silently (line 19 checks `subtype === 'init'` only). No catch-all logging. This is where `task_started`, `task_progress`, and `task_notification` handling must be added.
- `apps/server/src/services/runtimes/claude-code/build-task-event.ts`: Builds `task_update` events from TaskCreate/TaskUpdate tool inputs. Uses `TASK_TOOL_NAMES` set. Not directly involved but shares the task concept namespace.
- `apps/server/src/services/runtimes/claude-code/agent-types.ts`: Defines `AgentSession` and `ToolState`. `AgentSession` would need a subagent tracking map.
- `packages/shared/src/schemas.ts`: Defines all Zod schemas. `StreamEventTypeSchema` (line 29-48) lists 16 event types — needs new subagent types. `MessagePartSchema` (line 348) is a discriminated union of `TextPart` and `ToolCallPart` — needs a new `SubagentPart` variant.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Switch/case handler processing 12 event types. Would need new cases for subagent events. The `currentPartsRef` pattern (mutable ref updated then flushed via `updateAssistantMessage`) is the established pattern for adding new part types.
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Iterates `message.parts` and dispatches to `StreamingText`, `AutoHideToolCall`, `ToolApproval`, or `QuestionPrompt`. New `SubagentBlock` component would be dispatched here for `part.type === 'subagent'`.
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`: 77-line collapsible card with status icons, expand/collapse animation, and result display. The `SubagentBlock` component should follow this same pattern — collapsible, status-aware, with motion animations.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — Add 3 new branches for system subtypes
- `packages/shared/src/schemas.ts` — Add `SubagentEventSchema`, `SubagentPart`, extend `StreamEventTypeSchema` and `MessagePartSchema`
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Add 3 new switch cases
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — Add `SubagentBlock` dispatch
- `apps/client/src/layers/features/chat/ui/SubagentBlock.tsx` (new) — Collapsible inline block

**Shared Dependencies:**

- `@dorkos/shared/types` — Type re-exports consumed by both server and client
- `packages/shared/src/types.ts` — Re-export file (auto-exports from schemas.ts)
- `motion/react` — Animation library used by ToolCallCard, same patterns for SubagentBlock
- `lucide-react` — Icons (Loader2, Check, ChevronDown used in ToolCallCard)

**Data Flow:**

```
SDK task_started → mapSdkMessage() → yield subagent_started StreamEvent → SSE
  → stream-event-handler → push SubagentPart to currentPartsRef → updateAssistantMessage
  → AssistantMessageContent → SubagentBlock (collapsed, spinner)

SDK task_progress → mapSdkMessage() → yield subagent_progress StreamEvent → SSE
  → stream-event-handler → find SubagentPart by sessionId, append text/tool summary
  → updateAssistantMessage → SubagentBlock (updates progress content)

SDK task_notification → mapSdkMessage() → yield subagent_done StreamEvent → SSE
  → stream-event-handler → find SubagentPart by sessionId, set status complete
  → updateAssistantMessage → SubagentBlock (check icon, stop spinner)
```

**Potential Blast Radius:**

- Direct: 5 files (mapper, schemas, stream-event-handler, AssistantMessageContent, new SubagentBlock)
- Indirect: `types.ts` re-exports (automatic), `deriveFromParts()` needs SubagentPart handling
- Tests: `sdk-event-mapper.test.ts` needs 3+ new test cases, SubagentBlock needs component tests
- No config/feature flag impact

## 5) Research

**Source:** `.temp/agent-sdk-audit.md` (sections 2.1-2.3, Appendix B)

**Potential solutions:**

**1. Collapsible inline block (chosen)**

- New `SubagentPart` in `MessagePartSchema` discriminated union
- Three new StreamEvent types: `subagent_started`, `subagent_progress`, `subagent_done`
- Client renders a collapsible card similar to ToolCallCard with spinner/check status
- Expandable to show accumulated text output and tool usage summary
- Pros: Follows established ToolCallCard pattern, moderate complexity, good UX balance
- Cons: New message part type touches multiple files across the stack
- Complexity: M
- Maintenance: Low (follows existing patterns)

**2. Nested message rendering (rejected)**

- Render subagent output as child messages with visual indentation
- Would require recursive `AssistantMessageContent` rendering
- Pros: Richest visibility, mirrors the actual subagent conversation
- Cons: L effort, complex recursive state management, performance risk with deep nesting
- Complexity: L
- Maintenance: High

**3. Status-only indicator (rejected)**

- Minimal inline badge with no expandable content
- Pros: S effort, simple implementation
- Cons: Insufficient visibility — users still can't understand what the subagent is doing
- Complexity: S
- Maintenance: Low

**Recommendation:** Collapsible inline block. It provides meaningful visibility without the complexity of nested rendering. Follows the established ToolCallCard pattern that users already understand.

## 6) Decisions

| #   | Decision                   | Choice                       | Rationale                                                                                                                                                                        |
| --- | -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Rendering approach         | Collapsible inline block     | Follows existing ToolCallCard pattern. M effort vs L for nested rendering. Provides good visibility without UI complexity.                                                       |
| 2   | Detail level when expanded | Text output + tool summaries | Balances visibility with performance. Shows what the subagent wrote and a summary of tools used (e.g., "Read 5 files, ran 2 searches") without rendering full nested tool cards. |
| 3   | Nesting depth              | Single level only            | Covers 95%+ of real usage. Subagent-spawned-subagents are invisible in v1. Simpler data model avoids recursive state management.                                                 |

---

## Implementation Sketch

### Schema Additions (`packages/shared/src/schemas.ts`)

**New StreamEvent types:**

```typescript
// Add to StreamEventTypeSchema enum:
('subagent_started', 'subagent_progress', 'subagent_done');

// New event schemas:
SubagentStartedEventSchema = z.object({
  subagentSessionId: z.string(),
  description: z.string().optional(), // from Task tool description arg
});

SubagentProgressEventSchema = z.object({
  subagentSessionId: z.string(),
  text: z.string().optional(), // accumulated text content
  toolSummary: z.string().optional(), // e.g., "Read 3 files"
});

SubagentDoneEventSchema = z.object({
  subagentSessionId: z.string(),
  status: z.enum(['completed', 'error']).optional(),
});
```

**New MessagePart type:**

```typescript
SubagentPartSchema = z.object({
  type: z.literal('subagent'),
  subagentSessionId: z.string(),
  description: z.string().optional(),
  text: z.string().optional(),
  toolSummary: z.string().optional(),
  status: z.enum(['running', 'complete', 'error']),
});

// Add to MessagePartSchema discriminated union
```

### Server Mapping (`sdk-event-mapper.ts`)

Add three new branches in `mapSdkMessage` for system message subtypes:

```typescript
// After the existing system/init check:
if (message.type === 'system' && 'subtype' in message) {
  if (message.subtype === 'task_started') {
    yield { type: 'subagent_started', data: { subagentSessionId: message.session_id } };
    return;
  }
  if (message.subtype === 'task_progress') {
    // Extract text content and tool summaries from message.content blocks
    yield { type: 'subagent_progress', data: { subagentSessionId: ..., text: ..., toolSummary: ... } };
    return;
  }
  if (message.subtype === 'task_notification') {
    yield { type: 'subagent_done', data: { subagentSessionId: message.session_id, status: ... } };
    return;
  }
}
```

### Client Handler (`stream-event-handler.ts`)

Three new switch cases that create/update SubagentPart entries in `currentPartsRef`:

- `subagent_started`: Push new `SubagentPart` with `status: 'running'`
- `subagent_progress`: Find existing SubagentPart by `subagentSessionId`, append text, update toolSummary
- `subagent_done`: Find existing SubagentPart, set `status: 'complete'`

### Client Component (`SubagentBlock.tsx`)

Collapsible inline block following ToolCallCard patterns:

- Collapsed: status icon (spinner/check) + description text + chevron
- Expanded: accumulated text output (via StreamingText or simple `<pre>`) + tool summary line
- Uses `motion/react` for expand/collapse animation
- Follows auto-hide pattern from `useToolCallVisibility` if desired

### History Support (follow-up)

The JSONL transcript reader (`transcript-reader.ts`) would need to reconstruct SubagentPart blocks from `task_started`/`task_progress`/`task_notification` entries in the JSONL. This is a separate follow-up — v1 shows subagent blocks only during live streaming.
