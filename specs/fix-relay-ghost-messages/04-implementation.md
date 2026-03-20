# Implementation Summary: Fix Relay-Mode Ghost Messages

**Created:** 2026-03-09
**Last Updated:** 2026-03-09
**Spec:** specs/fix-relay-ghost-messages/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 13 / 13

## Tasks Completed

### Session 1 - 2026-03-09

- Task #1: [P1] Reset streamReadyRef before each relay message send
- Task #2: [P1] Set statusRef synchronously in handleSubmit
- Task #3: [P1] Write unit tests for synchronous state resets
- Task #4: [P2] Add correlationId to SendMessageRequestSchema
- Task #5: [P2] Update Transport interface and HttpTransport for correlationId
- Task #6: [P2] Thread correlationId through server route publishViaRelay
- Task #7: [P2] Echo correlationId in ClaudeCodeAdapter response chunks
- Task #8: [P2] Pass correlationId through SessionBroadcaster SSE events
- Task #9: [P2] Add client-side correlationId generation and filtering
- Task #10: [P3] Write correlation ID unit tests for client and adapter
- Task #11: [P3] Write integration test for correlationId round-trip through server route
- Task #12: [P3] Run full test suite and verify no regressions
- Task #13: [P4] Update architecture docs with correlation ID relay flow

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — streamReadyRef unconditional reset, statusRef sync update, correlationId generation + filtering
- `packages/shared/src/schemas.ts` — Added `correlationId: z.string().uuid().optional()` to SendMessageRequestSchema
- `packages/shared/src/transport.ts` — Added `correlationId?: string` to sendMessageRelay options
- `apps/client/src/layers/shared/lib/http-transport.ts` — Include correlationId in POST body
- `apps/client/src/layers/shared/lib/direct-transport.ts` — Updated stub signature
- `apps/server/src/routes/sessions.ts` — Thread correlationId through publishViaRelay
- `packages/relay/src/adapters/claude-code-adapter.ts` — Echo correlationId in response chunks
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` — Include correlationId in SSE relay_message events
- `contributing/architecture.md` — Documented Relay Correlation IDs pipeline

**Test files:**

- `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts` — 26 tests (19 existing updated + 7 new)
- `apps/server/src/routes/__tests__/sessions-relay-correlation.test.ts` — 5 new integration tests
- `packages/relay/src/adapters/__tests__/claude-code-adapter-correlation.test.ts` — 5 new adapter tests

## Known Issues

- 5 pre-existing test failures (AgentCard.test.tsx: 4, SessionSidebar.test.tsx: 1) unrelated to these changes

## Verification Results

- **typecheck**: PASS — zero errors across all packages
- **tests**: PASS — all new tests pass, 0 new failures
- **lint**: PASS — zero new errors

## Implementation Notes

### Session 1

Executed 13 tasks in 7 parallel batches. Two-layer fix approach:

**Layer 1 — Synchronous state resets (P1):**

- `streamReadyRef` unconditionally reset before each `waitForStreamReady()` call
- `statusRef.current` set synchronously alongside `setStatus('streaming')` to close timing window

**Layer 2 — Per-message correlation ID (P2):**

- Full pipeline: client generates UUID → POST body → relay envelope → adapter echo → SSE event → client filter
- Late-arriving events from previous messages are discarded via correlationId mismatch
- Backward compatible: missing correlationId passes through unfiltered
