# Task Breakdown: Surface SDK Hook Lifecycle Events in Chat UI

Generated: 2026-03-16
Source: specs/hook-lifecycle-events/02-specification.md
Last Decompose: 2026-03-16

## Overview

Surface three silently-dropped SDK system message subtypes (`hook_started`, `hook_progress`, `hook_response`) so users can see when hooks execute, watch their output, and understand failures. Tool-contextual hooks render as compact sub-rows inside `ToolCallCard`; session-level hooks route through `SystemStatusZone` for success and escalate to persistent error events on failure.

## Phase 1: Foundation

### Task 1.1: Add hook lifecycle Zod schemas and event types to shared package

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:
- Add `'hook_started'`, `'hook_progress'`, `'hook_response'` to `StreamEventTypeSchema` enum
- Define `HookStartedEventSchema`, `HookProgressEventSchema`, `HookResponseEventSchema` Zod schemas with `.openapi()` metadata
- Add all three to the `StreamEventSchema` data union
- Define `HookPartSchema` and `HookStatusSchema` for reuse
- Extend `ToolCallPartSchema` with optional `hooks: z.array(HookPartSchema).optional()`
- Re-export `HookStartedEvent`, `HookProgressEvent`, `HookResponseEvent`, `HookPart` from `types.ts`

**Files Modified**:
- `packages/shared/src/schemas.ts` — enum values, 3 schemas, union members, ToolCallPartSchema extension
- `packages/shared/src/types.ts` — type re-exports

**Acceptance Criteria**:
- [ ] All three event types in StreamEventTypeSchema
- [ ] Three schemas defined with OpenAPI metadata
- [ ] ToolCallPartSchema includes hooks field
- [ ] Types re-exported
- [ ] `pnpm typecheck` passes

---

## Phase 2: Server Mapper

### Task 2.1: Add hook lifecycle branches to sdk-event-mapper

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 3.1

**Technical Requirements**:
- Add `TOOL_CONTEXTUAL_HOOK_EVENTS` constant (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`)
- Add three branches in system message dispatch for `hook_started`, `hook_progress`, `hook_response`
- Tool-contextual hooks yield new event types; session-level hooks use existing `system_status` and `error` paths
- Empty `currentToolId` produces `toolCallId: null`
- Session-level `hook_progress` is silent; session-level success `hook_response` is silent

**Files Modified**:
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — 3 branches + constant
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-event-mapper.test.ts` — 9 new tests

**Test Cases** (9 total):
1. `hook_started` (tool-contextual) yields `hook_started` event
2. `hook_started` (session-level) yields `system_status` event
3. `hook_progress` (tool-contextual) yields `hook_progress` event
4. `hook_progress` (session-level) yields nothing
5. `hook_response` (tool-contextual, success) yields `hook_response`
6. `hook_response` (tool-contextual, error) yields `hook_response`
7. `hook_response` (session-level, error) yields `error` event
8. `hook_response` (session-level, success) yields nothing
9. `hook_started` with empty `currentToolId` yields `toolCallId: null`

**Acceptance Criteria**:
- [ ] All routing logic correct per hook_event field
- [ ] 9 unit tests passing
- [ ] `pnpm typecheck` and `pnpm lint` pass

---

## Phase 3: Client Handler

### Task 3.1: Add HookState type and hook handler cases to stream-event-handler

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.1

**Technical Requirements**:
- `HookState` interface in `chat-types.ts` with `hookId`, `hookName`, `hookEvent`, `status`, `stdout`, `stderr`, `exitCode`
- `ToolCallState` extended with `hooks?: HookState[]`
- `orphanHooksRef` in `use-chat-session.ts` passed to `createStreamEventHandler`
- `findHookById` helper in stream-event-handler
- Three new switch cases: `hook_started`, `hook_progress`, `hook_response`
- `tool_call_start` case modified to drain orphan buffer
- `deriveFromParts` updated to propagate hooks

**Files Modified**:
- `apps/client/src/layers/features/chat/model/chat-types.ts` — HookState interface, ToolCallState extension
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — deps, helper, 3 cases, orphan logic
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — orphanHooksRef, re-export

**Acceptance Criteria**:
- [ ] HookState interface defined
- [ ] ToolCallState has hooks field
- [ ] All three handler cases work correctly
- [ ] Orphan hooks buffer and attach
- [ ] deriveFromParts propagates hooks
- [ ] `pnpm typecheck` passes

### Task 3.2: Add stream-event-handler unit tests for hook lifecycle events

**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Technical Requirements**:
- Test `hook_started` adds hook to tool call's hooks array
- Test `hook_started` without toolCallId buffers to orphanHooksRef
- Test `hook_progress` updates stdout/stderr
- Test `hook_response` maps outcome to status correctly
- Test orphan hooks drain on `tool_call_start`

**Files Modified**:
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler.test.ts` — 5 test cases

**Acceptance Criteria**:
- [ ] All 5 test cases pass
- [ ] Tests use mock deps pattern consistent with codebase

---

## Phase 4: UI Component

### Task 4.1: Add HookRow component and hook rendering to ToolCallCard

**Size**: Large
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Technical Requirements**:
- `HookRow` component with four visual states (running/success/error/cancelled)
- Error hooks auto-expand with stderr output and exit code
- Hook section rendered below tool header with `border-t border-border/50` separator
- No rendering when hooks is undefined or empty
- Accessible: `aria-expanded` on hook buttons with output

**Files Modified**:
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — HookRow component + integration
- `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx` — 7 test cases

**Test Cases** (7 total):
1. Renders hook rows when hooks present
2. Shows spinner for running hook
3. Shows check icon for successful hook
4. Shows X icon and "failed" for errored hook
5. Expands to show stderr on click
6. No section for empty hooks array
7. No section for undefined hooks

**Acceptance Criteria**:
- [ ] All four visual states render correctly
- [ ] Error state auto-expands
- [ ] All 7 tests pass
- [ ] `pnpm typecheck` and `pnpm lint` pass

---

## Phase 5: Polish & Documentation

### Task 5.1: Add auto-hide suppression for tool cards with failed hooks

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 4.1
**Can run parallel with**: Task 5.2

**Technical Requirements**:
- Tool cards with failed hooks must not auto-hide
- `hasFailedHook = toolCall.hooks?.some((h) => h.status === 'error')`
- Condition integrated into auto-hide decision logic

**Acceptance Criteria**:
- [ ] Failed hooks prevent auto-hide
- [ ] Successful hooks allow normal auto-hide

### Task 5.2: Update interactive-tools documentation with hook lifecycle section

**Size**: Small
**Priority**: Low
**Dependencies**: Task 4.1
**Can run parallel with**: Task 5.1

**Technical Requirements**:
- New "Hook Lifecycle Events" section in `contributing/interactive-tools.md`
- Cover routing logic, orphan handling, and visual states

**Files Modified**:
- `contributing/interactive-tools.md`

**Acceptance Criteria**:
- [ ] Documentation section added
- [ ] Covers routing, orphan handling, visual states

---

## Summary

| Phase | Tasks | Estimated LOC |
|---|---|---|
| Phase 1: Foundation | 1 task | ~48 |
| Phase 2: Server Mapper | 1 task | ~155 |
| Phase 3: Client Handler | 2 tasks | ~175 |
| Phase 4: UI Component | 1 task | ~135 |
| Phase 5: Polish & Docs | 2 tasks | ~30 |
| **Total** | **7 tasks** | **~543** |

**Parallel Opportunities**: Tasks 2.1 and 3.1 can run in parallel (both depend only on 1.1). Tasks 5.1 and 5.2 can run in parallel.

**Critical Path**: 1.1 → 3.1 → 4.1 → 5.1
