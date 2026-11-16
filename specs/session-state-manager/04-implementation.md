# Implementation Summary: Session State Manager

**Created:** 2026-03-28
**Last Updated:** 2026-03-28
**Spec:** specs/session-state-manager/02-specification.md

## Progress

**Status:** Complete (with follow-up noted)
**Tasks Completed:** 9 / 9

## Tasks Completed

### Session 1 - 2026-03-28

- Task #2: session-state-manager [P1] Create session-chat-store with types, actions, and LRU eviction
- Task #3: session-state-manager [P1] Create StreamManager singleton with start, abort, and event dispatch
- Task #4: session-state-manager [P1] Wire useChatSession to delegate submit/stop to StreamManager
- Task #5: session-state-manager [P2] Migrate status, error, and sessionBusy from useState to store reads
- Task #6: session-state-manager [P2] Add SessionActivityIndicator to SessionItem for background status
- Task #7: session-state-manager [P2] Migrate input draft and remaining transient state fields to store
- Task #8: session-state-manager [P3] Migrate messages state and history reconciliation to store
- Task #9: session-state-manager [P3] Implement renameSession for create-on-first-message remap
- Task #10: session-state-manager [P4] Remove dead useState/useRef declarations and thin useChatSession

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/entities/session/model/session-chat-store.ts` — Session-keyed Zustand store (241 lines)
- `apps/client/src/layers/entities/session/index.ts` — Updated barrel with store exports
- `apps/client/src/layers/features/chat/model/stream-manager.ts` — StreamManager singleton (~500 lines)
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Refactored: all state store-backed, submit/stop delegated to StreamManager
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Updated to write status/error to store
- `apps/client/src/layers/features/session-list/ui/SessionItem.tsx` — Added SessionActivityIndicator

**Test files:**

- `apps/client/src/layers/entities/session/model/__tests__/session-chat-store.test.ts` — 12 tests
- `apps/client/src/layers/features/chat/__tests__/stream-manager.test.ts` — 29 tests
- `apps/client/src/layers/features/chat/__tests__/use-chat-session-multi-stream.test.tsx` — 5 acceptance tests
- `apps/client/src/layers/features/session-list/ui/__tests__/SessionActivityIndicator.test.tsx` — 8 tests

## Known Issues

- `immer` added as direct dependency to `@dorkos/client` (was a peer dep of zustand, not installed)
- `useChatSession` is ~750 lines (not ~300 as targeted). The `StreamEventDeps` interface still passes refs to `stream-event-handler.ts` and helpers (`currentPartsRef`, `orphanHooksRef`, `sessionStatusRef`, etc.). These refs can't be removed until `stream-event-handler.ts` is fully refactored to read from the store directly instead of through refs. This is a follow-up task — the architecture is correct (all state is store-backed), but the event handler bridge layer adds ~400 lines of boilerplate.

## Implementation Notes

### Session 1

**Architecture established:**

- Session-keyed Zustand store (`Record<string, SessionState>`) with immer + devtools middleware
- StreamManager module-level singleton managing per-session AbortControllers and timers
- All 15 useState declarations migrated to store reads
- Session remap uses atomic `renameSession` instead of `isRemappingRef`
- Background activity indicators (streaming/error/tool-approval/unseen) in sidebar
- Input drafts preserved per session
- LRU eviction (MAX_RETAINED_SESSIONS=20, never evicts streaming sessions)

**Dual-write bridge pattern:** The hook reads from the store but still passes refs to `stream-event-handler.ts` via `StreamEventDeps`. This bridge keeps the event handler working during incremental migration. Follow-up work should refactor `StreamEventDeps` to use store reads directly, which will remove the ref declarations and reduce the hook to ~300 lines.

**Verification:** 3424 tests pass (296 test files). Zero type errors. Zero new lint errors.
