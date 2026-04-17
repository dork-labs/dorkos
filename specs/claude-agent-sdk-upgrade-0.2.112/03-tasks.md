# Task Breakdown: Claude Agent SDK Upgrade to 0.2.112

**Generated**: 2026-04-16
**Source**: `specs/claude-agent-sdk-upgrade-0.2.112/02-specification.md`
**Slug**: `claude-agent-sdk-upgrade-0.2.112`
**Total tasks**: 19 across 6 phases

## Overview

Bump `@anthropic-ai/claude-agent-sdk` 0.2.89 → 0.2.112 and adopt the subset of new capabilities whose cost is bounded and value is immediate:

- Version bump (manifest + lockfile only)
- Remove a `PermissionMode 'auto'` type-cast workaround (free cleanup)
- Opus 4.7 support (free, requires SDK 0.2.111+)
- `terminal_reason` plumbing + minimal UI chip
- `system/memory_recall` event + `memory_paths` on `system.init`
- Richer `SDKStatus: 'requesting'` passthrough

All new data flows out of the `AgentRuntime` boundary (ADR-0089) via `StreamEvent` variants in `@dorkos/shared`.

## Critical Path

`1.1 → 1.2 → {2.1, 2.2, 3.1, 4.1, 5.1 (parallel)} → feature phases → 6.1 → 6.2 → 6.3`

After Task 1.2 (validation), Phases 2/3/4/5 can be worked in parallel. Within each phase, some sequencing still applies (types → mapper → UI → tests).

---

## Phase 1: Foundation

### Task 1.1: Bump SDK version across all 3 workspace manifests

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: —

Update `@anthropic-ai/claude-agent-sdk` from `0.2.89` to `0.2.112` in:

- `package.json`
- `apps/server/package.json`
- `packages/cli/package.json`

Then `pnpm install` to refresh `pnpm-lock.yaml`.

**Acceptance**:

- [ ] All 3 manifests declare `0.2.112`
- [ ] Lockfile updated
- [ ] No remaining references to `0.2.89` for this package

### Task 1.2: Validate clean upgrade with full pipeline (pre-code-changes)

**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: —

Run `pnpm lint && pnpm typecheck && pnpm build && pnpm test:run` BEFORE any code edits. Confirms the two breaking changes (options.env overlay, sandbox default) don't affect our code. Fail-fast gate.

**Acceptance**:

- [ ] All four commands exit 0
- [ ] Any test expectation needing adjustment due to 0.2.94 fixes (MCP cleanup, context usage breakdown) is corrected and re-verified

---

## Phase 2: Cleanup & Free Wins

### Task 2.1: Remove PermissionMode 'auto' type-assertion workaround

**Size**: Small
**Priority**: Medium
**Dependencies**: 1.2
**Can run parallel with**: 2.2, 3.1, 4.1, 5.1

At `apps/server/src/services/runtimes/claude-code/message-sender.ts:223-226`, remove the `as typeof sdkOptions.permissionMode` cast and the 'auto'-workaround comment. SDK 0.2.91 added `'auto'` to `PermissionMode` natively.

**Acceptance**:

- [ ] Cast removed, comment updated
- [ ] `pnpm typecheck && pnpm test:run` pass

### Task 2.2: Smoke-test Opus 4.7 end-to-end through the runtime

**Size**: Small
**Priority**: Medium
**Dependencies**: 1.2
**Can run parallel with**: 2.1, 3.1, 4.1, 5.1

Manual smoke: open a session with `model: 'claude-opus-4-7'`, send a message, verify response + `session_status` reports the Opus 4.7 model ID.

**Acceptance**:

- [ ] Opus 4.7 request succeeds
- [ ] Documented in `04-implementation.md`

---

## Phase 3: `terminal_reason` plumbing

### Task 3.1: Extend StreamEvent.session_status with terminalReason + export TerminalReason type

**Size**: Small
**Priority**: High
**Dependencies**: 1.2
**Can run parallel with**: 2.1, 2.2, 4.1, 5.1

Add `TerminalReason` union and optional `terminalReason?` field on the `session_status` variant in `@dorkos/shared/types`. No SDK import.

**Acceptance**:

- [ ] `TerminalReason` exported
- [ ] `session_status.data` carries `terminalReason?`
- [ ] `pnpm typecheck` passes

### Task 3.2: Read result.terminal_reason in sdk-event-mapper

**Size**: Small
**Priority**: High
**Dependencies**: 3.1
**Can run parallel with**: 3.3

In the result-message branch (`sdk-event-mapper.ts:482-500`), read `result.terminal_reason` and spread into the `session_status` event conditionally.

**Acceptance**:

- [ ] Field forwarded when present, omitted otherwise
- [ ] Existing error + `done` emission unchanged

### Task 3.3: Render minimal UI chip for non-completed terminalReason

**Size**: Medium
**Priority**: Medium
**Dependencies**: 3.1
**Can run parallel with**: 3.2

`TerminalReasonBadge` component — renders Shadcn `<Badge>` on the last assistant message when `terminalReason` is defined and not `'completed'`. Labels: `aborted_tools`→"Tool aborted", `max_turns`→"Max turns reached", `blocking_limit`→"Blocking limit", unknown→raw.

**Acceptance**:

- [ ] Chip appears for non-completed values, absent otherwise
- [ ] Component test passes

### Task 3.4: Add mapper unit tests for terminal_reason

**Size**: Small
**Priority**: High
**Dependencies**: 3.2
**Can run parallel with**: —

Two tests in `sdk-event-mapper.test.ts`: with `terminal_reason`, without `terminal_reason`.

**Acceptance**:

- [ ] Both tests pass
- [ ] `pnpm test:run` green

---

## Phase 4: `memory_recall` + `memory_paths`

### Task 4.1: Confirm SDK payload shape via dist types

**Size**: Small
**Priority**: High
**Dependencies**: 1.2
**Can run parallel with**: 2.1, 2.2, 3.1, 5.1

Grep `node_modules/@anthropic-ai/claude-agent-sdk/dist/` for `memory_recall` and `memory_paths`. Record exact shapes in `04-implementation.md`. If types don't export, fall back to logging raw SDK messages from the catch-all at `sdk-event-mapper.ts:527`.

**Acceptance**:

- [ ] Exact payload shape documented
- [ ] 4.2 unblocked with confirmed field names

### Task 4.2: Add memory_recall StreamEvent variant + extend AgentSession with memoryPaths

**Size**: Small
**Priority**: High
**Dependencies**: 4.1
**Can run parallel with**: —

Add new `memory_recall` variant to `StreamEvent`; add optional `memoryPaths?: string[]` to `AgentSession`. Field names per 4.1 research.

**Acceptance**:

- [ ] Types compile
- [ ] No SDK import leak

### Task 4.3: Add mapper branches for memory_recall subtype and memory_paths on system.init

**Size**: Small
**Priority**: High
**Dependencies**: 4.2
**Can run parallel with**: 4.4

Extend the `system.init` branch to populate `session.memoryPaths`. Add a new branch for `system.memory_recall` that emits a `memory_recall` `StreamEvent`.

**Acceptance**:

- [ ] Typecheck + build pass
- [ ] No regression in other subtype handling

### Task 4.4: Render minimal memory_recall UI surface

**Size**: Medium
**Priority**: Medium
**Dependencies**: 4.2
**Can run parallel with**: 4.3

`MemoryRecallIndicator` component — mirrors `api_retry` presentation. Subtle inline row with lucide icon and brief text. Throttle/group adjacent events to avoid noise.

**Acceptance**:

- [ ] Indicator visible for memory_recall events
- [ ] Component test passes

### Task 4.5: Add mapper unit tests for memory_recall + memory_paths

**Size**: Small
**Priority**: High
**Dependencies**: 4.3
**Can run parallel with**: —

Three tests: memory_paths populates session, absent memory_paths leaves session field undefined, memory_recall subtype emits event.

**Acceptance**:

- [ ] All three tests pass
- [ ] `pnpm test:run` green

---

## Phase 5: Richer `SDKStatus`

### Task 5.1: Extend StreamEvent.system_status with optional status field

**Size**: Small
**Priority**: High
**Dependencies**: 1.2
**Can run parallel with**: 2.1, 2.2, 3.1, 4.1

Add `status?: string` to the `system_status` variant's `data`.

**Acceptance**:

- [ ] Typecheck passes
- [ ] Existing consumers still compile

### Task 5.2: Update mapper status handler to forward status + fallback message

**Size**: Small
**Priority**: High
**Dependencies**: 5.1
**Can run parallel with**: 5.4

At `sdk-event-mapper.ts:115-125`, read `msg.status`, include in event, synthesize a message if only `status` is present.

**Acceptance**:

- [ ] `{subtype:'status', status:'requesting'}` produces an event with both fields populated
- [ ] Backward compat: body-text-only messages still work

### Task 5.3: Add mapper unit test for richer system_status

**Size**: Small
**Priority**: High
**Dependencies**: 5.2
**Can run parallel with**: —

Two tests: status-only emits with synthetic message + status field; body-only still works without status field.

**Acceptance**:

- [ ] Both tests pass

### Task 5.4: (Optional) Surface status-aware loading UI affordance

**Size**: Small
**Priority**: Low
**Dependencies**: 5.1
**Can run parallel with**: 5.2

If the existing loading spinner is generic, add a minimal variation for `status === 'requesting'`. Otherwise skip and document in `04-implementation.md`.

**Acceptance**:

- [ ] Implemented minimally OR explicitly skipped with reasoning

---

## Phase 6: Validation & Hand-off

### Task 6.1: Run full pipeline validation after all code changes

**Size**: Small
**Priority**: High
**Dependencies**: 2.1, 2.2, 3.4, 4.5, 5.3
**Can run parallel with**: —

`pnpm lint && pnpm typecheck && pnpm build && pnpm test:run` — all must pass.

**Acceptance**:

- [ ] All four commands exit 0

### Task 6.2: Execute manual smoke checklist

**Size**: Medium
**Priority**: High
**Dependencies**: 6.1
**Can run parallel with**: —

Six manual checks: Opus 4.7, terminal chip, memory indicator, richer status, concurrent-session `MaxListeners` absence, CJK text integrity.

**Acceptance**:

- [ ] All items pass or are documented as skipped with reasoning

### Task 6.3: Mark spec as implemented in manifest

**Size**: Small
**Priority**: Medium
**Dependencies**: 6.2
**Can run parallel with**: —

Advance manifest status to `implemented`, update `04-implementation.md` `Status: Complete`, suggest `/git:commit`.

**Acceptance**:

- [ ] Manifest shows `implemented`
- [ ] Implementation summary marked Complete

---

## Parallelism Summary

- **After 1.2 completes**, five foundation tasks can launch in parallel: 2.1, 2.2, 3.1, 4.1, 5.1.
- **After 4.1 completes**, 4.2 unblocks; then 4.3/4.4 parallel; then 4.5.
- **After 3.1 completes**, 3.2/3.3 parallel; then 3.4.
- **After 5.1 completes**, 5.2/5.4 parallel; then 5.3.
- **Phase 6 is strictly serial**: 6.1 → 6.2 → 6.3.
