# Implementation Summary: Status-Aware Loading Affordance for `system_status.status`

**Created:** 2026-04-17
**Last Updated:** 2026-04-17
**Spec:** specs/status-aware-loading-affordance/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 8 / 8

## Tasks Completed

### Session 1 - 2026-04-17

- Task #1: [P1] Add `SystemStatusState` interface and widen session store types
- Task #2: [P1] Widen `setSystemStatus` setter signatures in `useSessionStoreActions`
- Task #3: [P2] Forward `system_status.status` through stream-event-handler and `api_retry`
- Task #4: [P2] Propagate `SystemStatusState` through `useChatSession` and `ChatPanel`
- Task #5: [P3] Add `deriveStatusCopy` and route structured status through `ChatStatusStrip`
- Task #6: [P4] Unit tests for `deriveStatusCopy` and `deriveStripState` struct branch
- Task #7: [P4] Extend stream-event-handler test to cover the `status` field
- Task #8: [P5] Mark spec 245 task 5.4 as tracked here and verify the full pipeline

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/shared/model/chat-message-types.ts` — added `SystemStatusState` interface
- `apps/client/src/layers/features/chat/model/chat-types.ts` — re-exported `SystemStatusState` from the feature barrel
- `apps/client/src/layers/entities/session/model/session-chat-store.ts` — widened `SessionState.systemStatus` to `SystemStatusState | null`
- `apps/client/src/layers/features/chat/model/use-session-store-actions.ts` — widened `setSystemStatus` + `setSystemStatusWithClear` signatures (accept string or struct)
- `apps/client/src/layers/features/chat/model/stream/stream-event-types.ts` — widened `StreamEventDeps.setSystemStatus` signature
- `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts` — `system_status` case forwards `{message, status: status ?? null}`; `api_retry` case wraps synthesized string with `status: null`
- `apps/client/src/layers/features/chat/ui/status/ChatStatusStrip.tsx` — added `deriveStatusCopy` helper, widened three input/prop types, priority-3 branch now prefers status-aware copy with `deriveStatusCopy(status) ?? message`
- `apps/client/src/dev/showcases/StatusShowcases.tsx` — updated 3 showcase entries to pass `{message, status: null}` structs (scope bump, required for clean typecheck; no behavior change)
- `specs/claude-agent-sdk-upgrade-0.2.112/04-implementation.md` — updated "Deferred UI work" note to mark task 5.4 as implemented here

**Test files:**

- `apps/client/src/layers/features/chat/__tests__/ChatStatusStrip.test.tsx` — rewrote `systemStatus:` inputs to structs; added `deriveStatusCopy` describe block (5 cases); added 3 new `deriveStripState` branch assertions; added component render test for `'Thinking…'`
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-status.test.ts` — updated existing `system_status` test to assert struct shape; added new test locking `{message, status: 'requesting'}` forwarding

## Known Issues

_None._

## Implementation Notes

### Session 1

**Execution strategy**: Small, tightly-coupled 8-task spec — dispatched a single comprehensive implementation agent for tasks #1–#7, then main context ran holistic verification gates + task #8 (manifest update and spec 245 cross-reference). Per the user's `feedback_holistic_batch_gates` memory: this follows the pattern of using holistic batch-level gates instead of per-task two-stage review for DorkOS spec execution.

**FSD compliance**: The key architectural decision was placing `SystemStatusState` in `layers/shared/model/chat-message-types.ts` rather than the spec's originally-proposed `features/chat/model/chat-types.ts`. The entity-layer store (`session-chat-store.ts`) cannot import from `features/` per the FSD unidirectional rule (`shared ← entities ← features ← widgets`). The feature layer re-exports the type from its barrel for consumer convenience. Zero FSD violations.

**Backwards compatibility preserved**: When `status` is absent (legacy `api_retry` path or pre-0.2.108 SDK), `deriveStatusCopy(null)` returns `null` and `deriveStripState` falls back to the raw `message`. Existing showcases ("Compacting context…", "Permission mode changed", "Reading knowledge files…") render unchanged.

**Verification (holistic gates — main context)**:

- `pnpm typecheck` → 21/21 packages successful, 0 errors (FULL TURBO cache hit after agent's run, so results are cross-validated)
- `pnpm --filter @dorkos/client test -- --run` → 349 test files, **4061 tests passed (4061)** (up from 4032 — +29 new test assertions across the two touched test files)
- `pnpm --filter @dorkos/client lint` → **0 errors, 47 pre-existing warnings** (unchanged count — none on files touched by this change)

**Scope bump**: `StatusShowcases.tsx` in the dev playground consumed `ChatStatusStrip.systemStatus` as a bare string in three places. This was not in the original task list but required for clean typecheck. All three now pass `{message, status: null}` — no behavior change.

**Calm-copy design**: The `deriveStatusCopy` helper is a forward-compat switch statement by design — adding new SDK discriminators (e.g., a future `'retrying'` status) becomes a one-line `case` rather than a substring-matching regex ladder. This aligns with the spec's non-goal of avoiding new state-machine types beyond the SDK's two discriminators.
