# Task Breakdown: Fix Relay SSE Message Delivery Pipeline

Generated: 2026-03-06
Source: specs/fix-relay-sse-delivery-pipeline/02-specification.md
Last Decompose: 2026-03-06

## Overview

Fix four compounding bugs in the Relay SSE message delivery pipeline that cause ~40-50% of messages to freeze. The SDK processes messages completely (JSONL has full responses) but response chunks never reach the client SSE stream. Fixes address: (1) EventSource lifecycle race condition, (2) missing subscribe-first handshake, (3) silent message loss when no subscriber is ready, (4) missing terminal `done` event on generator errors, and (5) dead subscription cleanup.

## Phase 1: Core Delivery Fixes

### Task 1.1: Stabilize EventSource lifecycle on relay path

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.3, 1.4

**Technical Requirements**:

- Split EventSource `useEffect` into two separate effects (relay path vs legacy path)
- Relay path: deps are `[sessionId, relayEnabled, streamEventHandler]` only — no `isStreaming`
- Legacy path: unchanged behavior with `isStreaming` in deps
- Add `streamReadyRef` (boolean ref) and `clientIdRef` (stable UUID ref)
- Listen for `stream_ready` SSE event to set `streamReadyRef.current = true`

**File**: `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**Acceptance Criteria**:

- [ ] Relay EventSource is NOT torn down when `isStreaming` changes
- [ ] Legacy path behavior unchanged
- [ ] `streamReadyRef` tracks stream_ready event
- [ ] No TypeScript errors

---

### Task 1.2: Add subscribe-first handshake

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Server: send `stream_ready` SSE event in `registerClient()` after `subscribeToRelay()` completes
- Client: add `waitForStreamReady()` helper (polls ref, 5s timeout, resolves on timeout)
- Client: call `waitForStreamReady()` before relay POST in `handleSubmit()`

**Files**: `session-broadcaster.ts`, `use-chat-session.ts`

**Acceptance Criteria**:

- [ ] Server sends `stream_ready` after relay subscription registration
- [ ] Client waits up to 5s before sending relay POST
- [ ] Client proceeds after timeout (never rejects)
- [ ] Unit tests for stream_ready emission and waitForStreamReady behavior

---

### Task 1.3: Add terminal done event in CCA finally block

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.4

**Technical Requirements**:

- Wrap SDK streaming loop in try/catch/finally
- Track `streamedDone` flag to prevent double-send
- In finally: send `done` event if not already sent (best-effort)
- Add `deliveredTo=0` warning logging in `publishResponse()`

**File**: `packages/relay/src/adapters/claude-code-adapter.ts`

**Acceptance Criteria**:

- [ ] `done` event always published even on generator error
- [ ] No double-send of `done` events
- [ ] Warning logged for `deliveredTo === 0` (non-done events)
- [ ] Unit tests for error scenarios

---

### Task 1.4: Clean up dead relay subscriptions on write error

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:

- Restructure `subscribeToRelay()` so `unsubFn` is accessible in flush catch block
- On write error: call unsubscribe, remove from `relaySubscriptions`, clear queue

**File**: `apps/server/src/services/session/session-broadcaster.ts`

**Acceptance Criteria**:

- [ ] Relay subscription cancelled on write error
- [ ] Queue cleared, map entry removed
- [ ] No double-unsubscribe
- [ ] Unit test for write error cleanup

## Phase 2: Defense-in-Depth

### Task 2.1: Add pending buffer to SubscriptionRegistry

**Size**: Large
**Priority**: Medium
**Dependencies**: Task 1.1, 1.2
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Add `pendingBuffers` Map to SubscriptionRegistry
- `bufferForPendingSubscriber()` stores envelope + timestamp
- `subscribe()` drains matching pending messages via `queueMicrotask()`
- 5-second TTL, 10-second cleanup interval
- `shutdown()` clears all state

**Files**: `packages/relay/src/subscription-registry.ts`, `packages/relay/src/relay-core.ts`

**Acceptance Criteria**:

- [ ] Messages buffered when no subscriber exists
- [ ] Drained in order on subscriber registration
- [ ] Expired messages not delivered
- [ ] Cleanup timer self-stops when empty
- [ ] 4 unit tests (buffer, drain, TTL expiry, cleanup)

---

### Task 2.2: Add deliveredTo=0 warning logging in CCA

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Verify/add warning log in `publishResponse()` when `deliveredTo === 0`
- Exclude `done` events from warning
- Include event type, subject, and envelope ID in log message

**File**: `packages/relay/src/adapters/claude-code-adapter.ts`

**Acceptance Criteria**:

- [ ] Warning logged for zero-delivery non-done events
- [ ] No warning for done events
- [ ] Unit test coverage

## Phase 3: Testing & Verification

### Task 3.1: Write unit tests for all fixes

**Size**: Large
**Priority**: High
**Dependencies**: All Phase 1 + Phase 2 tasks
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- 10 unit tests across 3 test files
- session-broadcaster: flush serialization, write error cleanup, stream_ready emission
- subscription-registry: buffer capture, drain on subscribe, TTL expiry, cleanup
- claude-code-adapter: done on error, done on publishResponse error, deliveredTo=0 warning

**Acceptance Criteria**:

- [ ] All 10 tests written and passing
- [ ] `pnpm test -- --run` passes

---

### Task 3.2: Update architecture documentation

**Size**: Small
**Priority**: Low
**Dependencies**: Task 1.2, 2.1
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- Document subscribe-first handshake in `contributing/architecture.md`
- Add follow-up reference in `specs/fix-relay-sse-backpressure/04-implementation.md`

**Acceptance Criteria**:

- [ ] Architecture docs updated
- [ ] Backpressure spec references this fix
