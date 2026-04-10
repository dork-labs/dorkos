# Task Breakdown: Agent Channels Tab — New Functionality (Pause, Test, Activity)

Generated: 2026-04-10
Source: specs/agent-channels-tab-03-functionality/02-specification.md
Last Decompose: 2026-04-10

## Overview

This spec adds three capabilities to the Channels tab in the Agent dialog: **pause/resume** per binding, **test probe** to verify routing without invoking agents, and **activity metadata** ("Last received X ago") on each channel card. The work spans schema changes, server routing logic, a new test endpoint, client hooks, and UI updates to `ChannelBindingCard` and `ChannelsTab`.

**Blast radius:** ~12 files touched. 1 schema change, 1 new server route, 1 router modification, 1 new client hook, 2 client UI modifications, Transport interface update.

---

## Phase 1: Schema Foundation

### Task 1.1: Add `enabled` field to AdapterBindingSchema

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- Add `enabled: z.boolean().default(true)` to `AdapterBindingSchema` in `packages/shared/src/relay-adapter-schemas.ts`
- Add `enabled: z.boolean().optional()` to the inline `UpdateBindingSchema` in `apps/server/src/routes/relay-adapters.ts` (PATCH handler, line ~301)
- Add `'enabled'` to the `Pick` type in `Transport.updateBinding` in `packages/shared/src/transport.ts`
- Add `'enabled'` to the `Pick` type in `HttpTransport` relay methods in `apps/client/src/layers/shared/lib/transport/relay-methods.ts`
- TSDoc comment explaining pause semantics and race-condition caveat
- Schema tests for backward compatibility (missing field defaults to `true`)

**Acceptance Criteria**:

- [ ] `AdapterBindingSchema` includes `enabled` field with default and TSDoc
- [ ] `UpdateBindingSchema` in PATCH route accepts `enabled`
- [ ] Transport interface and HttpTransport Pick types include `enabled`
- [ ] Existing bindings without `enabled` parse to `enabled: true`
- [ ] Schema tests pass
- [ ] `pnpm typecheck` passes

### Task 1.2: Add `isSyntheticTest` to relay trace metadata and `BindingTestResult` type

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- Add `isSyntheticTest?: boolean` to trace metadata schema in `packages/shared/src/relay-schemas.ts`
- Define `BindingTestResultSchema` and export `BindingTestResult` type from `packages/shared/src/relay-adapter-schemas.ts`
- Security comment: flag must never be accepted from inbound adapter messages

**Acceptance Criteria**:

- [ ] Trace metadata schema includes `isSyntheticTest` with TSDoc
- [ ] `BindingTestResultSchema` and type exported
- [ ] Security annotation present
- [ ] `pnpm typecheck` passes

---

## Phase 2: Server Implementation

### Task 2.1: Update BindingRouter to filter disabled bindings and short-circuit synthetic tests

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Inbound routing (`handleInbound`): skip bindings with `enabled === false` before permission checks
- New `testBinding(bindingId)` method: returns routing verdict without agent invocation
- Outbound routing: also skip disabled bindings
- File: `apps/server/src/services/relay/binding-router.ts`

**Acceptance Criteria**:

- [ ] Inbound routing skips disabled bindings
- [ ] `testBinding()` method returns `{ resolved, wouldDeliverTo?, reason?, details? }`
- [ ] Outbound routing skips disabled bindings
- [ ] Server tests pass

### Task 2.2: Add POST /api/bindings/:id/test route with rate limiting

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Route: `POST /api/relay/bindings/:id/test` in `apps/server/src/routes/relay-adapters.ts`
- Rate limit: 10 requests/minute/IP via `express-rate-limit`
- Returns: `{ ok, resolved, latencyMs, wouldDeliverTo?, reason?, details? }`
- Error codes: 404 (not found), 409 (paused), 503 (subsystem unavailable), 500 (unexpected)
- No new auth surface

**Acceptance Criteria**:

- [ ] Route returns correct shapes for success and failure
- [ ] 404, 409, 503 error codes correct
- [ ] Rate limiting active
- [ ] Never invokes agent runtime
- [ ] `pnpm typecheck` passes

### Task 2.3: Write server-side unit tests for router changes and test route

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: None

**Technical Requirements**:

- Router tests: enabled-flag filtering (inbound/outbound), testBinding method (healthy, paused, agent-not-found, unknown ID, no runtime invocation)
- Route tests: successful test, paused binding 409, unknown 404, adapter error state
- Files: `apps/server/src/services/relay/__tests__/binding-router.test.ts`, route test file

**Acceptance Criteria**:

- [ ] 4+ router unit tests for enabled-flag filtering
- [ ] 5+ tests for testBinding() method
- [ ] 4+ route tests for POST endpoint
- [ ] All pass, no regressions

---

## Phase 3: Client Implementation

### Task 3.1: Add testBinding to Transport interface and implement in HttpTransport

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- Add `testBinding(bindingId: string): Promise<BindingTestResult>` to Transport interface
- Implement in HttpTransport relay methods (POST to `/relay/bindings/:id/test`)
- Stub in DirectTransport (Obsidian plugin)
- Update mock transport in test-utils if needed

**Acceptance Criteria**:

- [ ] Transport interface includes `testBinding`
- [ ] HttpTransport implements POST request
- [ ] DirectTransport has stub
- [ ] `pnpm typecheck` passes

### Task 3.2: Create useTestBinding mutation hook

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- New file: `apps/client/src/layers/entities/binding/model/use-test-binding.ts`
- Export from barrel: `apps/client/src/layers/entities/binding/index.ts`
- TanStack Query useMutation wrapping `transport.testBinding`
- 3 tests: success, failure result, network error

**Acceptance Criteria**:

- [ ] Hook created and exported
- [ ] 3 tests written and passing

---

## Phase 4: Client UI

### Task 4.1: Extend ChannelBindingCard with pause state, test action, and activity metadata

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 3.1
**Can run parallel with**: None

**Technical Requirements**:

- New props: `lastMessageAt`, `onTogglePause`, `onTest`
- Paused state: `opacity-60`, gray status dot, "Paused" badge, "Paused — no messages routing" subtitle
- Activity subtitle: "Last received {relative time}" / "No recent activity", 60s refresh interval
- Kebab dropdown menu replacing hover buttons: Send test, separator, Pause/Resume, separator, Edit, Remove
- Send test shows spinner while pending, disabled when paused
- File: `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx`

**Acceptance Criteria**:

- [ ] Paused visual state (opacity, gray dot, badge, subtitle)
- [ ] Activity subtitle with relative time, 60s refresh
- [ ] Kebab menu with all items in correct order
- [ ] Send test spinner and disabled-when-paused behavior
- [ ] `pnpm typecheck` passes

### Task 4.2: Wire ChannelsTab with test, pause, and activity metadata

**Size**: Large
**Priority**: High
**Dependencies**: Task 3.1, Task 3.2, Task 4.1
**Can run parallel with**: None

**Technical Requirements**:

- Add `useTestBinding` hook
- Add `handleTogglePause` using `updateBinding.mutateAsync({ id, updates: { enabled } })`
- Add `handleTest` with toast feedback
- Create `BoundChannelRow` wrapper to compute `lastMessageAt` from `useObservedChats`
- Toast messages: "Channel paused" / "Channel resumed" / "Test OK — routed in {N}ms" / "Test failed: {reason}"
- File: `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`

**Acceptance Criteria**:

- [ ] Pause mutation dispatches correctly with toast
- [ ] Test mutation dispatches correctly with toast
- [ ] `lastMessageAt` computed per binding from observed chats
- [ ] `pnpm typecheck` passes

---

## Phase 5: Client Tests

### Task 5.1: Write ChannelBindingCard tests for pause, test, and activity states

**Size**: Large
**Priority**: High
**Dependencies**: Task 4.1
**Can run parallel with**: Task 5.2

**Technical Requirements**:

- Paused state tests: dim card, gray dot, badge, subtitle replacement
- Activity metadata tests: recent timestamp, absent, just now
- Kebab menu tests: item presence, Pause vs Resume, click handlers, disabled state
- File: `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelBindingCard.test.tsx`

**Acceptance Criteria**:

- [ ] 3+ paused state tests
- [ ] 3+ activity metadata tests
- [ ] 5+ kebab menu tests
- [ ] All pass

### Task 5.2: Write ChannelsTab tests for pause and test wiring

**Size**: Medium
**Priority**: High
**Dependencies**: Task 4.2
**Can run parallel with**: Task 5.1

**Technical Requirements**:

- Pause mutation dispatch tests (enabled=false, enabled=true)
- Test mutation dispatch and toast message tests
- Activity metadata passthrough test
- File: `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelsTab.test.tsx`

**Acceptance Criteria**:

- [ ] 2+ pause mutation tests
- [ ] 3+ test mutation tests
- [ ] 1+ activity metadata test
- [ ] All pass, no regressions

---

## Phase 6: Verification and Polish

### Task 6.1: Full regression verification and typecheck

**Size**: Medium
**Priority**: High
**Dependencies**: Task 5.1, Task 5.2, Task 2.3
**Can run parallel with**: None

**Technical Requirements**:

- `pnpm typecheck` passes
- `pnpm test -- --run` passes (zero failures)
- `pnpm lint` passes
- `pnpm build` succeeds
- TSDoc present on all new exports
- No dead code or lingering TODOs

**Acceptance Criteria**:

- [ ] All CI-equivalent checks pass
- [ ] TSDoc complete
- [ ] No dead code

---

## Dependency Graph

```
Phase 1:  [1.1] ──┬── [1.2]
                   │
Phase 2:  [2.1] ──┤── [2.2]
                   │
          [2.3] ──┘

Phase 3:  [3.1] ──┬── [3.2]
                   │
Phase 4:  [4.1] ──┤
                   │
          [4.2] ──┘

Phase 5:  [5.1] ──┬── [5.2]
                   │
Phase 6:  [6.1] ──┘
```

**Critical path:** 1.1 → 2.1 → 2.3 → 6.1 (server) and 1.1 → 3.1 → 4.1 → 4.2 → 5.2 → 6.1 (client)

**Parallel opportunities:**

- Tasks 1.1 and 1.2 can run in parallel
- Tasks 2.1 and 2.2 can run in parallel (after Phase 1)
- Tasks 3.1 and 3.2 can run in parallel (after 1.2)
- Tasks 5.1 and 5.2 can run in parallel (after Phase 4)
