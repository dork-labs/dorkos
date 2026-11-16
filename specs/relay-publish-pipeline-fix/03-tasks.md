# Task Breakdown: Relay Publish Pipeline Fix

Generated: 2026-02-27
Source: specs/relay-publish-pipeline-fix/02-specification.md
Last Decompose: 2026-02-27

## Overview

Fix the critical bug in `relay-core.ts:publish()` where an early return at lines 308-315 skips adapter delivery when no Maildir endpoints match the target subject. This completely blocks all Relay-based chat dispatch and Pulse scheduled runs. The fix restructures the publish pipeline into a unified fan-out model, propagates rich `DeliveryResult` from adapters, adds timeout protection, and brings test coverage from zero adapter integration tests to comprehensive coverage.

## Phase 1: Foundation

### Task 1.1: Update AdapterRegistryLike interface and AdapterRegistry.deliver() to return DeliveryResult

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:

- Change `AdapterRegistryLike.deliver()` return type from `Promise<boolean>` to `Promise<DeliveryResult | null>` in `packages/relay/src/types.ts`
- Add `adapterResult?: DeliveryResult` field to `PublishResultLike` in `packages/relay/src/types.ts`
- Update `AdapterRegistry.deliver()` in `packages/relay/src/adapter-registry.ts` to return `null` (not `false`) when no adapter matches, and the full `DeliveryResult` (not `true`) when an adapter matches
- Update two existing adapter-registry tests to match the new return types

**Files Modified**:

- `packages/relay/src/types.ts`
- `packages/relay/src/adapter-registry.ts`

**Acceptance Criteria**:

- [ ] `AdapterRegistryLike.deliver()` returns `Promise<DeliveryResult | null>`
- [ ] `AdapterRegistry.deliver()` returns `null` for no match, `DeliveryResult` for match
- [ ] `PublishResultLike` has `adapterResult?: DeliveryResult`
- [ ] `pnpm typecheck` passes across monorepo

---

### Task 1.2: Extend PublishResult with adapterResult field

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Add `adapterResult?: DeliveryResult` to the `PublishResult` interface in `packages/relay/src/relay-core.ts`
- Import `DeliveryResult` from `./types.js`

**Files Modified**:

- `packages/relay/src/relay-core.ts`

**Acceptance Criteria**:

- [ ] `PublishResult` includes `adapterResult?: DeliveryResult`
- [ ] `DeliveryResult` is imported
- [ ] `pnpm typecheck` passes

---

### Task 1.3: Add deliverToAdapter() private method to RelayCore

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

**Technical Requirements**:

- Add `ADAPTER_TIMEOUT_MS = 30_000` static readonly constant
- Add `deliverToAdapter()` private method with: timeout via `Promise.race`, SQLite indexing with `adapter:` prefix on success, error-returning (not throwing) on failure
- Returns `null` when no adapter registry configured
- Returns `DeliveryResult` with `{ success: false, error, deadLettered: false }` on failure

**Files Modified**:

- `packages/relay/src/relay-core.ts`

**Acceptance Criteria**:

- [ ] `deliverToAdapter()` is private on RelayCore
- [ ] 30-second timeout via `Promise.race`
- [ ] SQLite index entry inserted on success with `adapter:<subjectHash>` endpoint hash
- [ ] Returns error result (not throws) on failure
- [ ] `pnpm typecheck` passes

---

### Task 1.4: Restructure publish() with unified fan-out — remove early return bug

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: None

**Technical Requirements**:

- Remove the early return at lines 308-315 that dead-letters when `matchingEndpoints.length === 0`
- Move Maildir delivery loop to always execute (even for zero endpoints)
- Call `deliverToAdapter()` unconditionally after Maildir delivery
- Dead-letter only when `deliveredTo === 0` after all targets tried
- Include descriptive dead-letter reason (adapter error or "no matching endpoints or adapters")
- Include `adapterResult` in returned `PublishResult`

**Files Modified**:

- `packages/relay/src/relay-core.ts`

**Acceptance Criteria**:

- [ ] Early return removed
- [ ] Adapter delivery attempted even with zero Maildir endpoints
- [ ] Dead-lettering only when `deliveredTo === 0`
- [ ] Partial delivery (Maildir succeeds, adapter fails) does NOT dead-letter
- [ ] `pnpm typecheck` passes
- [ ] Existing non-adapter tests still pass

---

### Task 1.5: Update publishViaRelay() — real trace ID and improved error handling

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.4
**Can run parallel with**: None

**Technical Requirements**:

- Replace `traceId: 'no-trace'` with `traceId: publishResult.messageId` in `publishViaRelay()` return
- Update endpoint registration catch block to only ignore "already registered" errors, log others via `console.error`

**Files Modified**:

- `apps/server/src/routes/sessions.ts`

**Acceptance Criteria**:

- [ ] `traceId` equals `publishResult.messageId`
- [ ] Non-duplicate registration errors logged via `console.error`
- [ ] Publish proceeds even when registration fails
- [ ] `pnpm typecheck` passes

---

## Phase 2: Test Coverage

### Task 2.1: Fix existing buggy test and add adapter integration tests to relay-core.test.ts

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.4
**Can run parallel with**: Task 2.2, Task 2.3

**Technical Requirements**:

- Fix existing test that validates `deliveredTo: 0` for unmatched subjects to also verify DLQ behavior
- Add 7 new tests in an "adapter delivery" describe block: adapter-only delivery, mixed delivery, adapter failure with DLQ, timeout with fake timers, partial delivery (no DLQ), context builder pass-through, no adapter returns undefined

**Files Modified**:

- `packages/relay/src/__tests__/relay-core.test.ts`

**Acceptance Criteria**:

- [ ] Existing buggy test updated
- [ ] 7 new adapter tests added and passing
- [ ] Timeout test uses `vi.useFakeTimers()` / `vi.useRealTimers()`
- [ ] All existing tests still pass
- [ ] `pnpm vitest run packages/relay/src/__tests__/relay-core.test.ts` passes

---

### Task 2.2: Update adapter-registry.test.ts for DeliveryResult return type

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.1, Task 2.3

**Technical Requirements**:

- Update deliver routing test to assert `DeliveryResult` object (not `true`)
- Update no-match test to assert `null` (not `false`)
- Add 3 new tests: rich DeliveryResult propagation, failure result propagation, context pass-through

**Files Modified**:

- `packages/relay/src/__tests__/adapter-registry.test.ts`

**Acceptance Criteria**:

- [ ] Existing tests updated for new return types
- [ ] 3 new DeliveryResult tests added and passing
- [ ] `pnpm vitest run packages/relay/src/__tests__/adapter-registry.test.ts` passes

---

### Task 2.3: Update sessions-relay.test.ts — trace ID and error handling tests

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.5
**Can run parallel with**: Task 2.1, Task 2.2

**Technical Requirements**:

- Add test verifying `traceId === messageId` in 202 response
- Add test verifying non-duplicate registration errors are logged
- Add test verifying "already registered" errors are silently ignored

**Files Modified**:

- `apps/server/src/routes/__tests__/sessions-relay.test.ts`

**Acceptance Criteria**:

- [ ] Trace ID test passes
- [ ] Error handling tests pass
- [ ] Existing tests still pass
- [ ] `pnpm vitest run apps/server/src/routes/__tests__/sessions-relay.test.ts` passes

---

## Phase 3: Documentation

### Task 3.1: Update architecture docs and changelog

**Size**: Small
**Priority**: Low
**Dependencies**: Task 1.5
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- Add unified fan-out subsection to `contributing/architecture.md` Relay section
- Document POST/SSE race condition as known edge case
- Add changelog entries under `[Unreleased]` > `Fixed`

**Files Modified**:

- `contributing/architecture.md`
- `CHANGELOG.md`

**Acceptance Criteria**:

- [ ] Architecture doc describes unified fan-out pipeline
- [ ] Race condition documented as known edge case
- [ ] Changelog has entries for all fixes

---

### Task 3.2: Update spec manifest status

**Size**: Small
**Priority**: Low
**Dependencies**: None
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- Update `specs/manifest.json` entry for spec 70 to `status: "in-progress"`
- Update spec frontmatter and body status line

**Files Modified**:

- `specs/manifest.json`
- `specs/relay-publish-pipeline-fix/02-specification.md`

**Acceptance Criteria**:

- [ ] Manifest status updated
- [ ] Spec frontmatter and body status updated

---

## Dependency Graph

```
1.1 (types) ──────┬── 1.2 (PublishResult) ── 1.3 (deliverToAdapter) ── 1.4 (publish fix) ── 1.5 (sessions.ts)
                   │                                                      │                      │
                   ├── 2.2 (adapter-registry tests)                       ├── 2.1 (relay tests)  ├── 2.3 (session tests)
                   │                                                      │                      │
                   │                                                      │                      ├── 3.1 (docs)
                   │                                                      │                      │
                   └──────────────────────────────────────────────────────────────────────────── 3.2 (manifest)
```

## Critical Path

1.1 -> 1.2 -> 1.3 -> 1.4 -> 1.5 -> 2.1 (longest chain)
