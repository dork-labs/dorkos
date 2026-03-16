# Implementation Summary: Tool Approval Timeout Visibility

**Created:** 2026-03-16
**Last Updated:** 2026-03-16
**Spec:** specs/tool-approval-timeout-visibility/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 7 / 7

## Tasks Completed

### Session 1 - 2026-03-16

- Task #1: [P1] Add timeoutMs to ApprovalEventSchema and ToolCallPartSchema
- Task #2: [P1] Add drain keyframe and animate-drain utility to CSS
- Task #3: [P1] Include timeoutMs in server approval_required event payload
- Task #4: [P1] Pass timeoutMs through stream-event-handler to tool call parts
- Task #5: [P2] Implement countdown timer, progress bar, and warning phases in ToolApproval
- Task #6: [P2] Add unit tests for countdown, progress bar, and timeout behavior
- Task #7: [P2] Update interactive-tools.md documentation

## Files Modified/Created

**Source files:**

- `packages/shared/src/schemas.ts` — Added `timeoutMs` to `ApprovalEventSchema` and `ToolCallPartSchema`
- `apps/client/src/index.css` — Added `@keyframes drain` and `@utility animate-drain`
- `apps/server/src/services/runtimes/claude-code/interactive-handlers.ts` — Added `timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS` to approval_required event payload
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Added `timeoutMs` to `deriveFromParts` and both `approval_required` code paths
- `apps/client/src/layers/features/chat/model/chat-types.ts` — Added optional `timeoutMs?: number` to `ToolCallState`
- `apps/client/src/layers/features/chat/ui/ToolApproval.tsx` — Full countdown timer implementation with progress bar, warning/urgent phases, timeout expiry, and screen reader announcements
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — Passed `timeoutMs={toolPart.timeoutMs}` to `ToolApproval`
- `contributing/interactive-tools.md` — Added Timeout Visibility subsection under Key Patterns

**Test files:**

- `apps/client/src/layers/features/chat/__tests__/ToolApproval.test.tsx` — Added 12 countdown timer tests covering progress bar rendering, threshold phases, timeout expiry, manual approve/deny, and screen reader announcements

## Known Issues

_(None)_

## Implementation Notes

### Session 1

All 7 tasks completed. The countdown timer tests required using `async act()` wrapping renders and timer advancement because `vi.useFakeTimers()` intercepts React's scheduler in Vitest 2.x + React 19. The pattern used is: render inside `await act(async () => {...})` to flush effects, then advance time with `await act(async () => vi.advanceTimersByTime(...))`. For manual approve/deny tests that require promise resolution, `vi.runAllTimersAsync()` is called inside `act` to flush both pending timers and microtasks. Full client test suite: 1983 tests across 165 files, all passing.
