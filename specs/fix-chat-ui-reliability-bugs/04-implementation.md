# Implementation Summary: Fix Chat UI Reliability Bugs

**Created:** 2026-03-11
**Last Updated:** 2026-03-11
**Spec:** specs/fix-chat-ui-reliability-bugs/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 12 / 12

## Tasks Completed

### Session 1 - 2026-03-11

- Task #1: [fix-chat-ui-reliability-bugs] [P1] Add enabled guard to useTaskState and update signature to accept null
- Task #2: [fix-chat-ui-reliability-bugs] [P1] Add enabled guard to useSessionStatus and update signature to accept null
- Task #3: [fix-chat-ui-reliability-bugs] [P2] Assign stable \_partId to new text parts in stream-event-handler
- Task #4: [fix-chat-ui-reliability-bugs] [P3] Remove optimistic setMessages and add pendingUserContent state to useChatSession
- Task #5: [fix-chat-ui-reliability-bugs] [P1] Remove ?? '' coercions at useTaskState and useSessionStatus call sites in ChatPanel
- Task #6: [fix-chat-ui-reliability-bugs] [P1] Write tests for useTaskState null guard and useSessionStatus null guard
- Task #7: [fix-chat-ui-reliability-bugs] [P2] Use \_partId as React key for text parts in AssistantMessageContent
- Task #8: [fix-chat-ui-reliability-bugs] [P2] Write tests for stable \_partId assignment and React key stability
- Task #9: [fix-chat-ui-reliability-bugs] [P3] Thread pendingUserContent through ChatPanel to MessageList
- Task #10: [fix-chat-ui-reliability-bugs] [P3] Add pendingUserContent prop to MessageList and render pending user bubble
- Task #11: [fix-chat-ui-reliability-bugs] [P3] Update existing tests and write new tests for pendingUserContent behavior
- Task #12: [fix-chat-ui-reliability-bugs] [P4] Run full test suite and verify zero regressions across all three bug fixes

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/features/chat/model/use-task-state.ts` — signature `string | null`, `enabled: !!sessionId` guard added
- `apps/client/src/layers/entities/session/model/use-session-status.ts` — signature `string | null`, `enabled: !!sessionId` guard, `updateSession` early-returns on null
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — removed `?? ''` coercions; destructures `pendingUserContent`; updated empty-state guard; passes prop to MessageList; updated scroll button guard
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — added `StreamingTextPart` local type with `_partId`; assigns on new-part creation, preserved via spread; added `setPendingUserContent` to `StreamEventDeps`; clears on first `text_delta`
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — React key uses `(part as { _partId?: string })._partId ?? \`text-${i}\``
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — added `pendingUserContent` state; replaced optimistic `setMessages` with `setPendingUserContent(content)`; clears on stream complete/error; exposed in return value
- `apps/client/src/layers/features/chat/ui/MessageList.tsx` — added `pendingUserContent?: string | null` prop; renders pending bubble with `aria-label="Sending…"` and `opacity-60` above `InferenceIndicator`

**Test files:**

- `apps/client/src/layers/features/chat/model/__tests__/use-task-state-null-guard.test.tsx` — 3 tests: null guard, positive case, empty state
- `apps/client/src/layers/entities/session/model/__tests__/use-session-status-guard.test.tsx` — 3 tests: null guard, default values, updateSession no-op
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-part-id.test.ts` — 4 tests: \_partId assignment, preservation, new part after tool call, pendingUserContent cleared on first delta
- `apps/client/src/layers/features/chat/ui/message/__tests__/AssistantMessageContent.test.tsx` — 3 tests: zero key warnings for multi-block, single-block, and history parts
- `apps/client/src/layers/features/chat/__tests__/use-chat-session.test.tsx` — 6 existing tests updated + new pendingUserContent describe block
- `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts` — 2 tests updated
- `apps/client/src/layers/features/chat/__tests__/MessageList.test.tsx` — 3 new pending bubble tests added

## Known Issues

_(None)_

## Implementation Notes

### Session 1

All three bugs fixed in a single parallel batch. Agents aafc723 and ada8def both independently implemented the full scope and both confirmed 1,848 tests passing across 152 test files, with TypeScript clean across all 13 packages. The parallel execution converged to a consistent state.

Key architectural note: Bug 3 (pending user content) required coordinated changes across 4 files (`use-chat-session.ts`, `stream-event-handler.ts`, `ChatPanel.tsx`, `MessageList.tsx`) and a broader refactor of existing tests that asserted on the now-removed optimistic `messages` array entry.
