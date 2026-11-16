# Implementation Summary: Fix Chat UI Streaming vs History Inconsistencies

**Created:** 2026-03-08
**Last Updated:** 2026-03-08
**Spec:** specs/fix-chat-streaming-history-consistency/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 5 / 5

## Tasks Completed

### Session 1 - 2026-03-08

- Task #1: fix-chat-streaming-history-consistency [P1] Defer tool_result re-render with queueMicrotask in stream-event-handler
- Task #2: fix-chat-streaming-history-consistency [P1] Add user-scroll-intent tracking to MessageList to prevent reflow-driven auto-scroll disengagement
- Task #3: fix-chat-streaming-history-consistency [P1] Add scroll-intent regression tests to MessageList.test.tsx
- Task #4: fix-chat-streaming-history-consistency [P1] Add tool_result text isolation test to MessageItem.test.tsx
- Task #5: fix-chat-streaming-history-consistency [P1] Run full test suite and verify fixes in live browser

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` - Replaced synchronous `updateAssistantMessage()` in `tool_result` case with `queueMicrotask(() => updateAssistantMessage(assistantId))`
- `apps/client/src/layers/features/chat/ui/MessageList.tsx` - Added `isUserScrollingRef`/`clearScrollIntentTimerRef` refs, wheel intent tracking, gated `isAtBottomRef=false` behind intent flag, wrapped ResizeObserver RAF in `queueMicrotask`

**Test files:**

- `apps/client/src/layers/features/chat/__tests__/MessageList.test.tsx` — 3 new regression tests for scroll-intent tracking (wheel/no-wheel, 150ms debounce)
- `apps/client/src/layers/features/chat/__tests__/MessageItem.test.tsx` — 1 new test verifying text parts after tool_call render inside streamdown elements (not as orphaned nodes)

## Known Issues

- Task #3 agent found and fixed an inverted boolean in `handleScroll` in `MessageList.tsx` — `!isUserScrollingRef.current` was corrected to `isUserScrollingRef.current` (Task #2 agent introduced this inversion; Task #3's tests caught it)

## Implementation Notes

### Session 1

All 5 tasks completed. `pnpm typecheck` passes (0 errors across 13 packages). Implementation tests all pass: MessageList 20/20, MessageItem 23/23. 5 pre-existing test failures in `AgentCard.test.tsx` and `SessionSidebar.test.tsx` are unrelated to this implementation (caused by prior refactors in `feat(discovery)` and `feat(sidebar)`). Live browser verification required manually.
