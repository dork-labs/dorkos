---
slug: hook-lifecycle-events
number: 141
created: 2026-03-16
status: ideation
---

# Surface SDK Hook Lifecycle Events in Chat UI

**Slug:** hook-lifecycle-events
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/hook-lifecycle-events

---

## 1) Intent & Assumptions

- **Task brief:** Surface `hook_started` (matrix item #11), `hook_progress` (#12), and `hook_response` (#13) SDK events in the chat UI. Currently all three are silently dropped in `sdk-event-mapper.ts`. Users have zero visibility into hook execution — if a hook takes time or fails, the agent appears frozen. This is P2 punch list item #7 from the Agent SDK Audit.
- **Assumptions:**
  - Hooks fire in a lifecycle: `hook_started` → 0..N `hook_progress` → `hook_response`
  - The `hook_id` field is stable across the lifecycle and serves as the correlation key
  - Tool-contextual hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) are the primary use case — they fire around tool execution and should be visually anchored to their tool
  - Session-level hooks (`SessionStart`, `UserPromptSubmit`, `PreCompact`, etc.) are secondary — most users won't configure these
  - The existing `toolState.currentToolId` in the mapper provides temporal correlation between hooks and tool calls
  - Multiple hooks can fire per tool call (each with its own `hookId`)
- **Out of scope:**
  - Hook configuration UI (users configure hooks via Claude Code settings, not DorkOS)
  - `SDKHookCallbackMessage` handling (the SDK's internal hook callback mechanism — separate from lifecycle events)
  - Specialized renderers for specific hook types
  - Hook execution metrics or history

## 2) Pre-reading Log

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: Main mapper (276 lines). System message dispatch at lines 48–115 handles `init`, `task_started`, `task_progress`, `task_notification`, `status`, `compact_boundary`. Hook events not mentioned — silently dropped. Already has `toolState.currentToolId` available for correlation.
- `packages/shared/src/schemas.ts`: `StreamEventTypeSchema` enum (lines 29–56) has 23 event types. `StreamEventSchema` union (lines 389–418). `MessagePartSchema` discriminated union (lines 487–493). No hook types defined.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Client event dispatcher (485 lines). Switch statement handles all StreamEvent types. `system_status` case (420–424) and `compact_boundary` case (425–437) show the pattern for new event types. Tool call cases (230–294) show how to update tool state.
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`: Expandable card (119 lines) with status icon, tool label, chevron toggle, progress output, and `TruncatedOutput`. Already has `progressOutput` and auto-expand on progress — hooks extend this naturally.
- `specs/system-status-compact-boundary/02-specification.md`: Recent completed spec showing the exact pipeline pattern: schema → mapper → handler → component. Explicitly notes hooks are out of scope, intended as a separate feature (line 343).
- `apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (lines 1511–1547): Authoritative type definitions for all three hook message types.
- `contributing/interactive-tools.md`: Documents tool approval and AskUserQuestion patterns. Should be updated with hook lifecycle event documentation.
- `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx`: Test structure with `makeToolCall` factory, truncation tests, expand behavior.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — SDK→StreamEvent mapper. Add 3 system message branches for hook events.
  - `packages/shared/src/schemas.ts` — Zod schemas. Add 3 event types + schemas to enum and union.
  - `packages/shared/src/types.ts` — Type re-exports. Add hook event types.
  - `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Client event handler. Add 3 switch cases to route hook events to tool call state.
  - `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — Tool call display. Add `HookRow` sub-component for rendering hook lifecycle within tool cards.
  - `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — Message parts dispatcher. No changes needed (hooks are sub-items of tool calls, not top-level parts).
- **Shared dependencies:**
  - `@dorkos/shared/types` — StreamEvent types, ToolCallPart types
  - `@anthropic-ai/claude-agent-sdk` — SDK message types (confined to `services/runtimes/claude-code/`)
  - `motion/react` — AnimatePresence for hook row animations
  - `lucide-react` — Status icons (Loader2, Check, X, AlertTriangle)
- **Data flow:**
  ```
  SDK hook_started/progress/response
    → mapSdkMessage() checks hook_event field
      → Tool-contextual: yield hook_started/hook_progress/hook_response StreamEvent with toolCallId
      → Session-level success: yield system_status (ephemeral)
      → Session-level failure: yield error (persistent)
    → SSE Transport
    → stream-event-handler.ts switch
      → hook_started: add HookState to tool call's hooks array
      → hook_progress: update stdout/stderr on existing hook
      → hook_response: mark outcome, exit code
    → ToolCallCard renders HookRow sub-components
  ```
- **Feature flags/config:** None needed
- **Potential blast radius:**
  - Direct: 6 files modified (mapper, schemas, types, handler, ToolCallCard, chat-types)
  - New: 0 new files (HookRow lives inside ToolCallCard.tsx or extracted alongside it)
  - Tests: 2–3 test files updated (mapper tests, ToolCallCard tests, handler tests)
  - Docs: `contributing/interactive-tools.md` update

## 4) Root Cause Analysis

N/A — This is a new feature, not a bug fix.

## 5) Research

Research report: `research/20260316_hook_lifecycle_events_ui_patterns.md`

**SDK Hook Message Shapes (from `sdk.d.ts`):**

| Message | Key Fields |
|---------|-----------|
| `hook_started` | `hook_id`, `hook_name`, `hook_event`, `session_id` |
| `hook_progress` | `hook_id`, `hook_name`, `hook_event`, `stdout`, `stderr`, `output` |
| `hook_response` | `hook_id`, `hook_name`, `hook_event`, `stdout`, `stderr`, `exit_code?`, `outcome: 'success'\|'error'\|'cancelled'` |

**Hook Events (from SDK `HookEvent` type):**

- Tool-contextual: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
- Session-level: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`, `PermissionRequest`

**Potential solutions analyzed:**

1. **Sub-rows inside ToolCallCard** — Hooks render as compact rows inside the tool card. Clear contextual relationship. Extends existing component. Follows GitHub Actions sub-step pattern.
   - Pros: Causality clear, no new top-level component, familiar pattern
   - Cons: Requires tool-hook correlation via temporal proximity, session-level hooks need separate path
   - Complexity: Medium

2. **Standalone HookCard component** — Independent cards at same level as ToolCallCard.
   - Pros: Simple data model, no correlation needed
   - Cons: Loses contextual relationship, visual noise, confusing ordering (pre-tool hook before card, post-tool after)
   - Complexity: Medium

3. **SystemStatusZone only** — All hooks as ephemeral status messages.
   - Pros: Zero new components
   - Cons: Failures auto-fade in 4s, no persistent record, useless for debugging
   - Complexity: Very low (inadequate UX)

4. **Hybrid** — Tool-contextual hooks in ToolCallCard, session-level hooks in SystemStatusZone with error escalation.
   - Pros: Correct semantic routing, reuses both existing surfaces, failure escalation for session hooks
   - Cons: Two code paths in mapper
   - Complexity: Medium

- **Recommendation:** Solution 4 (Hybrid) — the routing logic based on `hook_event` is clean and each surface already exists.

**Key edge case identified:** For `PreToolUse` hooks, `hook_started` may arrive before `tool_call_start`. If `toolState.currentToolId` is empty, correlation fails. Mitigation: buffer hook events with no `toolCallId` and attach them retrospectively when the next `tool_call_start` arrives.

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | How should tool-contextual hooks render? | Sub-rows inside ToolCallCard | Clear causal relationship between hook and tool. Extends existing component. Follows GitHub Actions sub-step pattern. No new top-level component needed. |
| 2 | How should session-level hooks render? | SystemStatusZone with error escalation | Success hooks are ephemeral (uninteresting). Failed session hooks escalate to persistent error banner via existing `error` event type. Reuses both existing surfaces. |
| 3 | Should successful hooks auto-hide independently? | Hide with parent card | When ToolCallCard auto-collapses, hook rows go with it. Failed hooks force the card to stay expanded. Simplest approach — hooks are visual children of the tool card. |
