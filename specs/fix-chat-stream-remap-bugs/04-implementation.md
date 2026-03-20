# Implementation Summary: Fix Chat UI Streaming Bugs — Duplicate Messages & Stale Model Display

**Created:** 2026-03-12
**Last Updated:** 2026-03-12
**Spec:** specs/fix-chat-stream-remap-bugs/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 4 / 4

## Tasks Completed

**Tasks Completed:** 2 / 4

### Session 1 - 2026-03-12

**Batch 1 (parallel):**

**Task #1 — Fix Bug #1: stream-event-handler.ts done handler** ✅

- File: `apps/client/src/layers/features/chat/model/stream-event-handler.ts`
- In the `done` case, inside `if (doneData.sessionId && doneData.sessionId !== sessionId)`, added three lines before `onSessionIdChangeRef.current?.(doneData.sessionId)`:
  - `currentPartsRef.current = [];` — resets streaming accumulator
  - `assistantCreatedRef.current = false;` — resets assistant-row guard
  - `setMessages([]);` — clears React message state so history is sole source of truth
- Added 4-line comment block explaining the ID-mismatch dedup failure root cause

**Task #2 — Fix Bug #3: use-session-status.ts model priority chain** ✅

- File: `apps/client/src/layers/entities/session/model/use-session-status.ts`
- Changed line 69 from:
  `const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;`
  to:
  `const model = localModel ?? (isStreaming ? streamingStatus?.model : null) ?? session?.model ?? DEFAULT_MODEL;`
- Updated comment to explain the `isStreaming` gate
- Lines 72–78 (`contextTokens`, `costUsd`) left unchanged

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Bug #1 fix
- `apps/client/src/layers/entities/session/model/use-session-status.ts` — Bug #3 fix

**Test files:**

- `apps/client/src/layers/entities/session/__tests__/use-session-status.test.tsx` — Bug #3 regression tests (5 tests total, all pass)
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-remap.test.ts` — Bug #1 regression tests (2 tests, all pass; new file)

## Known Issues

_(None)_

## Implementation Notes

### Session 1

**Batch 1** ran two agents in parallel and both completed cleanly. No TypeScript interface changes were needed — `setMessages` was already in `StreamEventDeps`. The `isStreaming` gate is a one-line change that preserves `streamingStatus.contextTokens`/`costUsd` behavior.

**Batch 2** ran two agents in parallel:

- Task #3 (session-status tests): Added `import type { SessionStatusEvent } from '@dorkos/shared/types'` and two regression tests. All 5 tests in the file pass.
- Task #4 (stream-event-handler-remap tests): Created new file following the exact `createMinimalDeps()` factory pattern from `stream-event-handler-part-id.test.ts`. Both tests pass, including the `invocationCallOrder` assertion verifying `setMessages([])` fires before `onSessionIdChange`. The existing 3 tests in `stream-event-handler-part-id.test.ts` also continue to pass.
