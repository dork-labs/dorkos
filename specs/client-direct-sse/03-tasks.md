# Task Breakdown: Client Direct SSE — Remove Relay Message Path from Web Client
Generated: 2026-03-12
Source: specs/client-direct-sse/02-specification.md
Last Decompose: 2026-03-12

## Overview

Remove the relay message code path from the DorkOS web client, making direct SSE the sole transport for sending messages and receiving streaming responses. The relay infrastructure stays intact for external adapters (Telegram, webhooks) and agent-to-agent communication. This eliminates ~350 lines of complex relay-specific code that has been the source of every streaming bug in the codebase.

## Phase 1: Client-Side Removal

### Task 1.1: Remove relay message code path from use-chat-session.ts
**Size**: Large
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

The highest-value change. Remove all relay branching from the client chat hook:
- Delete `waitForStreamReady()` function
- Delete `useRelayEnabled()` import and usage
- Delete `correlationIdRef`, `streamReadyRef`, `stalenessTimerRef` refs
- Delete `resetStalenessTimer` callback
- Delete entire relay EventSource effect (stream_ready, relay_message, sync_update)
- Simplify SSE EventSource effect (remove relayEnabled guard)
- Remove relay branch from `executeSubmission` (keep direct SSE path only)
- Remove `relayEnabled` from refetch logic and dependency arrays
- Update "legacy" comments to neutral SSE terminology

**Acceptance Criteria**:
- [ ] No references to relay remain in `use-chat-session.ts`
- [ ] `executeSubmission` always calls `transport.sendMessage()`
- [ ] TypeScript compiles cleanly
- [ ] Existing `use-chat-session.test.ts` tests pass

### Task 1.2: Delete client relay chat test file
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

Delete `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts`. This file tests relay-specific code paths (waitForStreamReady, correlationId filtering, staleness detection, sendMessageRelay calls) that no longer exist. The direct SSE path already has coverage in `use-chat-session.test.ts`.

**Acceptance Criteria**:
- [ ] Test file deleted
- [ ] `pnpm test -- --run` passes
- [ ] Other relay test files remain untouched

## Phase 2: Server-Side Removal

### Task 2.1: Remove relay dispatch path from sessions.ts route handler
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.2, Task 2.3

Remove relay dispatch from `POST /api/sessions/:id/messages`:
- Delete `isRelayEnabled` and `RelayCore` imports
- Delete `publishViaRelay()` function (~60 lines)
- Delete the `if (isRelayEnabled() && relayCore)` block that returns 202
- Delete `stream_ready` event in `GET /stream`
- Rename "Legacy path" comments

**Acceptance Criteria**:
- [ ] POST always streams SSE (never returns 202)
- [ ] GET /stream does not emit `stream_ready`
- [ ] No relay imports remain in sessions.ts
- [ ] TypeScript compiles cleanly

### Task 2.2: Remove relay fan-in from session-broadcaster.ts
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.1, Task 2.3

Remove all relay subscription code from `SessionBroadcaster` (~120 lines):
- Delete `RelayCore` import and type alias
- Delete `relaySubscriptions`, `callbackRelayUnsubs`, `relay` properties
- Delete `setRelay()` method
- Delete relay subscription in `registerClient()` and `registerCallback()`
- Delete `subscribeToRelay()` and `unsubscribeFromRelay()` private methods
- Delete relay cleanup in `deregisterClient()` and `shutdown()`

**Acceptance Criteria**:
- [ ] `setRelay()` method removed
- [ ] No `RelayCore` references remain
- [ ] ~120 lines removed
- [ ] TypeScript compiles cleanly

### Task 2.3: Remove broadcaster.setRelay() call from runtime and index
**Size**: Small
**Priority**: High
**Dependencies**: Task 2.2
**Can run parallel with**: Task 2.1

Update `ClaudeCodeRuntime.setRelay()` to be a no-op (broadcaster no longer has `setRelay()`). Update comment in `index.ts`. Keep the `runtimeRegistry.getDefault().setRelay?.(relayCore)` call for backward compat with other runtimes.

**Acceptance Criteria**:
- [ ] `ClaudeCodeRuntime.setRelay()` no longer calls `broadcaster.setRelay()`
- [ ] `setRelay?.(relayCore)` call in index.ts still exists
- [ ] TypeScript compiles cleanly

## Phase 3: Test Cleanup

### Task 3.1: Delete server-side relay chat test files
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.1
**Can run parallel with**: Task 3.2

Delete:
- `apps/server/src/routes/__tests__/sessions-relay.test.ts`
- `apps/server/src/routes/__tests__/sessions-relay-correlation.test.ts`

Keep other relay test files (`relay.test.ts`, `relay-conversations.test.ts`, `relay-bindings-integration.test.ts`).

**Acceptance Criteria**:
- [ ] Both files deleted
- [ ] `pnpm test -- --run` passes
- [ ] Other relay tests untouched

### Task 3.2: Update remaining test files to remove relay chat mocks
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: Task 3.1

Audit and update test files that mock `relayEnabled` or reference the relay message path in chat context. Remove stale mocks while preserving relay UI test mocks.

**Acceptance Criteria**:
- [ ] No test references `isRelayEnabled` in a sessions/chat context
- [ ] No test references `publishViaRelay`
- [ ] All tests pass
- [ ] Relay infrastructure tests untouched

## Phase 4: Naming Cleanup and Documentation

### Task 4.1: Remove 'legacy' labels from SSE code paths
**Size**: Small
**Priority**: Low
**Dependencies**: Task 1.1, Task 2.1, Task 2.2
**Can run parallel with**: Task 4.2

Search and update all "legacy" labels that reference SSE. Non-SSE "legacy" references (trace-store, site, DB) remain unchanged.

**Acceptance Criteria**:
- [ ] No SSE code paths labeled as "legacy"
- [ ] Non-SSE legacy references unchanged

### Task 4.2: Update architecture documentation
**Size**: Small
**Priority**: Low
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: Task 4.1

Update `contributing/architecture.md` to describe SSE as the sole client transport. Note that `sendMessageRelay` is external-adapter-only. Keep relay documentation for external adapters and agent-to-agent communication.

**Acceptance Criteria**:
- [ ] Architecture doc describes SSE as sole client transport
- [ ] `sendMessageRelay` documented as external-adapter-only
- [ ] Relay external adapter docs intact

## Phase 5: Verification

### Task 5.1: Final verification — typecheck, tests, and dead import scan
**Size**: Medium
**Priority**: High
**Dependencies**: All previous tasks
**Can run parallel with**: None

Run `pnpm typecheck`, `pnpm test -- --run`, `pnpm lint`. Scan for dead imports. Verify relay infrastructure is intact (packages/relay, relay services, relay routes, relay UI). Verify `sendMessageRelay()` stays on Transport interface.

**Acceptance Criteria**:
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test -- --run` passes
- [ ] `pnpm lint` passes
- [ ] No dead imports
- [ ] Relay infrastructure confirmed intact
- [ ] `sendMessageRelay()` confirmed on Transport interface
