# Task Breakdown: Fix Relay-Mode Ghost Messages

Generated: 2026-03-09
Source: specs/fix-relay-ghost-messages/02-specification.md
Last Decompose: 2026-03-09

## Overview

Fix three compounding race conditions in the relay-mode SSE message pipeline that cause ghost messages when users send messages in rapid succession. Phase 1 applies synchronous state resets (root causes 1 & 3) with minimal code changes. Phase 2 threads per-message correlation IDs through the full relay pipeline (root cause 2) to filter late-arriving events. Phase 3 covers testing and verification. Phase 4 updates internal documentation.

## Phase 1: Synchronous State Resets

### Task 1.1: Reset streamReadyRef before each relay message send

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 1.2

Fix root cause 1: `streamReadyRef` is never reset between messages. After the first message, `waitForStreamReady()` passes immediately because `streamReadyRef` stays `true`.

**Changes:**

- File: `apps/client/src/layers/features/chat/model/use-chat-session.ts`
- Remove `if (!streamReadyRef.current)` guard
- Add `streamReadyRef.current = false` before `waitForStreamReady()` call
- ~3 line diff, relay path only

**Acceptance Criteria:**

- [ ] `streamReadyRef.current` set to `false` before every `waitForStreamReady()` call
- [ ] `waitForStreamReady()` is called on every relay send
- [ ] Non-relay path unchanged

---

### Task 1.2: Set statusRef synchronously in handleSubmit

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 1.1

Fix root cause 3: `statusRef.current` updated via `useEffect` (async), leaving a 10-50ms window where it reads `'idle'` and `sync_update` events trigger stale history overwrites.

**Changes:**

- File: `apps/client/src/layers/features/chat/model/use-chat-session.ts`
- Add `statusRef.current = 'streaming'` immediately after `setStatus('streaming')` in `handleSubmit()`
- Keep existing `useEffect` for other status-change paths
- ~2 line diff

**Acceptance Criteria:**

- [ ] `statusRef.current` set synchronously right after `setStatus('streaming')`
- [ ] Existing `useEffect` sync preserved for error/stop paths
- [ ] `sync_update` listener guard blocks stale invalidation immediately

---

### Task 1.3: Write unit tests for synchronous state resets

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1, 1.2

New test file for relay-specific fixes.

**Tests:**

1. `streamReadyRef` resets per message — verify poll happens on every send
2. `statusRef` sync guard — verify immediate update (not useEffect-delayed)
3. `sync_update` blocked during streaming — verify no stale invalidation

**File:** `apps/client/src/layers/features/chat/__tests__/use-chat-session-relay.test.ts`

**Acceptance Criteria:**

- [ ] Test file created with MockEventSource and transport mocking
- [ ] All three test scenarios covered
- [ ] Tests pass

---

## Phase 2: Per-Message Correlation ID

### Task 2.1: Add correlationId to SendMessageRequestSchema

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 2.2

Add `correlationId: z.string().uuid().optional()` to the shared Zod schema.

**File:** `packages/shared/src/schemas.ts`

**Acceptance Criteria:**

- [ ] Schema includes `correlationId: z.string().uuid().optional()`
- [ ] Existing fields unchanged
- [ ] Backward compat: POST without correlationId still validates

---

### Task 2.2: Update Transport interface and HttpTransport for correlationId

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 2.1

Thread `correlationId` through the Transport abstraction.

**Files:**

- `packages/shared/src/transport.ts` — add `correlationId?: string` to options type
- `apps/client/src/layers/shared/lib/http-transport.ts` — include in POST body
- `apps/client/src/layers/shared/lib/direct-transport.ts` — update stub signature

**Acceptance Criteria:**

- [ ] Transport interface accepts `correlationId` in options
- [ ] HttpTransport includes it in POST body when present, omits when absent
- [ ] DirectTransport stub matches updated interface
- [ ] `pnpm typecheck` passes

---

### Task 2.3: Thread correlationId through server route publishViaRelay

**Size**: Small | **Priority**: High | **Dependencies**: 2.1

Extract `correlationId` from validated request body and pass through to relay publish.

**File:** `apps/server/src/routes/sessions.ts`

**Acceptance Criteria:**

- [ ] `publishViaRelay()` accepts and forwards `correlationId`
- [ ] Relay publish payload includes `correlationId`
- [ ] Undefined `correlationId` causes no error

---

### Task 2.4: Echo correlationId in ClaudeCodeAdapter response chunks

**Size**: Medium | **Priority**: High | **Dependencies**: 2.3

Extract correlation ID from inbound payloads and echo in every response chunk.

**File:** `packages/relay/src/adapters/claude-code-adapter.ts`

**Changes:**

- Extract `correlationId` from `payloadObj` in `handleAgentMessage()`
- Add `correlationId?: string` parameter to `publishResponse()`
- Spread into payload: `const payload = correlationId ? { ...event, correlationId } : event`
- Dispatch flows unaffected (no correlationId)

**Acceptance Criteria:**

- [ ] Every response chunk includes `correlationId` when present in inbound payload
- [ ] Clean payloads (no `correlationId` key) when absent
- [ ] Dispatch flows unchanged

---

### Task 2.5: Pass correlationId through SessionBroadcaster SSE events

**Size**: Small | **Priority**: High | **Dependencies**: 2.4

Include correlation ID in SSE `relay_message` event data sent to client.

**File:** `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`

**Changes:**

- In `subscribeToRelay()`, extract `correlationId` from envelope payload
- Include in SSE event data: `...(correlationId ? { correlationId } : {})`

**Acceptance Criteria:**

- [ ] SSE `relay_message` events include `correlationId` when present
- [ ] Omitted when absent (no undefined in JSON)
- [ ] Existing event fields unchanged

---

### Task 2.6: Add client-side correlationId generation and filtering

**Size**: Medium | **Priority**: High | **Dependencies**: 2.2, 2.5

Generate per-message UUID and filter incoming events by correlation ID.

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**Changes:**

- Add `correlationIdRef = useRef<string>('')`
- Generate `crypto.randomUUID()` in `handleSubmit()` for relay path
- Pass to `transport.sendMessageRelay()` in options
- Filter `relay_message` events: discard when `envelope.correlationId !== correlationIdRef.current`
- Permissive filter: pass through when either side lacks correlationId

**Acceptance Criteria:**

- [ ] UUID generated per relay send
- [ ] Late events from previous messages discarded
- [ ] Events without correlationId pass through (backward compat)
- [ ] Non-relay path unchanged

---

## Phase 3: Testing & Verification

### Task 3.1: Write correlation ID unit tests for client and adapter

**Size**: Medium | **Priority**: High | **Dependencies**: 2.4, 2.6 | **Parallel with**: Task 3.2

**Files:**

- `apps/client/src/layers/features/chat/__tests__/use-chat-session-relay.test.ts` (append)
- `packages/relay/src/adapters/__tests__/claude-code-adapter-correlation.test.ts` (new)

**Client tests:**

1. Mismatched correlationId events are discarded
2. Events without correlationId pass through
3. correlationId UUID sent to transport

**Adapter tests:**

1. correlationId echoed in all response chunks
2. Clean payloads when no correlationId in inbound message

**Acceptance Criteria:**

- [ ] 5 tests covering both client filtering and adapter echo
- [ ] All tests pass

---

### Task 3.2: Write integration test for correlationId round-trip through server route

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.3 | **Parallel with**: Task 3.1

**File:** `apps/server/src/routes/__tests__/sessions-relay-correlation.test.ts` (new)

**Tests:**

1. correlationId flows from POST body into relay publish payload
2. correlationId omitted from relay payload when not in POST body
3. Invalid (non-UUID) correlationId rejected with 400

**Acceptance Criteria:**

- [ ] Three integration tests covering the route → relay pipeline
- [ ] All tests pass

---

### Task 3.3: Run full test suite and verify no regressions

**Size**: Small | **Priority**: High | **Dependencies**: 3.1, 3.2

**Steps:**

1. `pnpm typecheck` — zero errors
2. `pnpm test -- --run` — all tests pass
3. `pnpm lint` — no new errors
4. Manual review: non-relay path has zero diff
5. Backward compat: messages without correlationId work normally

**Acceptance Criteria:**

- [ ] All checks pass
- [ ] No regressions in non-relay path
- [ ] Backward compatibility confirmed

---

## Phase 4: Documentation

### Task 4.1: Update architecture docs with correlation ID relay flow

**Size**: Small | **Priority**: Low | **Dependencies**: 2.6

Add a "Relay Correlation IDs" section to `contributing/architecture.md` documenting the full correlation ID pipeline (client → server → adapter → broadcaster → client) and backward compatibility.

**Acceptance Criteria:**

- [ ] Architecture doc updated with correlation ID flow
- [ ] Pipeline steps documented
- [ ] Backward compatibility mentioned
