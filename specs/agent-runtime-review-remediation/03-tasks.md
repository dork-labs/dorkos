# Task Breakdown: Agent Runtime Abstraction — Review Remediation

Generated: 2026-03-06
Source: specs/agent-runtime-review-remediation/02-specification.md
Last Decompose: 2026-03-06

## Overview

Address 12 issues identified in the code review of the agent-runtime-abstraction refactor (commit `bc0fe8b`). This is a cleanup/remediation spec with no user-visible behavior changes. The issues fall into four groups:

- **Group A (Route Migration):** Two routes bypass `RuntimeRegistry`, creating duplicate service instances
- **Group B (Import Cleanup):** Stale import paths, backward-compatibility shims, old naming conventions, misplaced test files
- **Group C (Interface Refinement):** Type safety gaps in the `AgentRuntime` interface
- **Group D (File Size):** `claude-code-runtime.ts` at 687 lines exceeds the 500-line threshold

---

## Phase 1: Interface Refinement

Foundation changes that other phases depend on.

### Task 1.1: Narrow SseResponse interface to only accept 'close' event

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

Narrow the `SseResponse` interface from accepting any `string` event to only the `'close'` literal. Update `SessionLockManager` to use `SseResponse` instead of Express `Response`, and remove the `as Response` cast in `ClaudeCodeRuntime`.

**Files:**

- `packages/shared/src/agent-runtime.ts` — narrow `on(event: string, ...)` to `on(event: 'close', ...)`
- `apps/server/src/services/runtimes/claude-code/session-lock.ts` — replace `Response` import with `SseResponse`
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — remove `as Response` cast

**Acceptance Criteria:**

- [ ] `SseResponse` only accepts `'close'` event literal
- [ ] No `import type { Response } from 'express'` in `session-lock.ts`
- [ ] No `as Response` cast in runtime
- [ ] `pnpm typecheck` passes
- [ ] Type-level test verifies Express Response satisfies narrowed SseResponse

---

### Task 1.2: Define narrow DI port interfaces for AgentRegistryPort and RelayPort

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

Replace `unknown` types in `setMeshCore()` and `setRelay()` with narrow, structurally-typed port interfaces.

**Files:**

- `packages/shared/src/agent-runtime.ts` — add `AgentRegistryPort` (getByPath, updateLastSeen, listWithPaths) and `RelayPort` (publish, isEnabled)
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — use `AgentRegistryPort` instead of `MeshCore`
- `apps/server/src/services/runtimes/claude-code/context-builder.ts` — use `AgentRegistryPort` instead of `MeshCore`

**Key discovery:** `context-builder.ts` calls `meshCore.listWithPaths()` which was not in the spec's ideation. The port must include this method.

**Acceptance Criteria:**

- [ ] `AgentRegistryPort` and `RelayPort` exported from `@dorkos/shared/agent-runtime`
- [ ] No `unknown` types in DI methods
- [ ] No `import type { MeshCore }` in runtime or context-builder
- [ ] Type-level assertions that MeshCore/RelayCore satisfy the ports

---

### Task 1.3: Make watchSession() functional via registerCallback on SessionBroadcaster

**Size**: Large
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

The current `watchSession()` is a no-op stub. Add `registerCallback()` to `SessionBroadcaster` and wire it through the runtime.

**Files:**

- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` — add `registerCallback()` method, update `broadcastUpdate()` to invoke callbacks, update `deregisterClient()` to check callbacks before stopping watchers
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — implement `watchSession()` via `broadcaster.registerCallback()`
- New test: `apps/server/src/services/session/__tests__/session-broadcaster-callback.test.ts`

**Acceptance Criteria:**

- [ ] `registerCallback()` returns unsubscribe function
- [ ] `broadcastUpdate()` invokes callbacks alongside SSE clients
- [ ] Watcher lifecycle respects both SSE clients and callbacks
- [ ] `watchSession()` is no longer a no-op

---

## Phase 2: Route Migration

Migrate routes to use `RuntimeRegistry` instead of direct Claude Code service imports.

### Task 2.1: Migrate commands.ts route to use RuntimeRegistry

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.2

**Files:**

- `packages/shared/src/agent-runtime.ts` — add `cwd` parameter to `getCommands()`
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — implement per-CWD command registry cache (max 50)
- `apps/server/src/routes/commands.ts` — replace direct `CommandRegistryService` with `runtimeRegistry.getDefault().getCommands()`

**Acceptance Criteria:**

- [ ] Route uses RuntimeRegistry, no direct `CommandRegistryService` import
- [ ] Per-CWD caching preserved in runtime (max 50 entries)
- [ ] Existing command route tests pass

---

### Task 2.2: Migrate relay.ts route to use RuntimeRegistry and remove TranscriptReader singleton

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.1

**Files:**

- `apps/server/src/routes/relay.ts` — replace `transcriptReader.getSession()` with `runtimeRegistry.getDefault().getSession()`
- `apps/server/src/services/runtimes/claude-code/transcript-reader.ts` — remove singleton export
- `apps/server/src/services/session/index.ts` — remove singleton re-export

**Acceptance Criteria:**

- [ ] No `transcriptReader` singleton import in any route
- [ ] Singleton export removed (class export kept)
- [ ] All relay route tests pass

---

### Task 2.3: Migrate sessions.ts SSE stream to runtime.watchSession() and remove app.locals.sessionBroadcaster

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: None

**Files:**

- `apps/server/src/routes/sessions.ts` — replace `req.app.locals.sessionBroadcaster` with `runtime.watchSession()`
- `apps/server/src/index.ts` — remove `app.locals.sessionBroadcaster` assignment
- Test files: `sessions.test.ts`, `sessions-boundary.test.ts`, `sessions-relay.test.ts` — update mocks

**Design consideration:** Relay subscription fan-in needs to be handled through `registerCallback()` in the broadcaster (extend Task 1.3's implementation to support relay subscriptions when clientId is provided).

**Acceptance Criteria:**

- [ ] No `app.locals.sessionBroadcaster` anywhere
- [ ] SSE stream route uses `runtime.watchSession()`
- [ ] Relay fan-in works through callback
- [ ] All session route tests pass

---

## Phase 3: Import Cleanup

Remove stale compatibility shims and naming.

### Task 3.1: Update Obsidian plugin imports and remove old package.json export shims

**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Tasks 3.2, 3.3, 3.4

**Files:**

- `apps/server/src/services/runtimes/claude-code/index.ts` — add `TranscriptReader` and `CommandRegistryService` exports
- `apps/obsidian-plugin/src/views/CopilotView.tsx` — update import path
- `apps/server/package.json` — remove 3 old export shims

**Acceptance Criteria:**

- [ ] Obsidian plugin imports from canonical path
- [ ] Old export shims removed
- [ ] Plugin builds successfully

---

### Task 3.2: Clean up core/index.ts barrel to only export core infrastructure

**Size**: Medium
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Tasks 3.1, 3.3, 3.4

Remove all Claude Code-specific re-exports from `core/index.ts` (AgentManager alias, agent types, SDK mapper, MCP tools, interactive handlers). Update consumers to import from canonical claude-code paths.

**Acceptance Criteria:**

- [ ] `core/index.ts` only exports core infrastructure
- [ ] No `AgentManager` alias exists
- [ ] All broken imports fixed

---

### Task 3.3: Rename AgentManagerLike to AgentRuntimeLike in relay package

**Size**: Medium
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Tasks 3.1, 3.2, 3.4

**Files:**

- `packages/relay/src/adapters/claude-code-adapter.ts` — rename interface
- `packages/relay/src/index.ts` — update re-export
- `apps/server/src/services/relay/adapter-factory.ts` and `adapter-manager.ts` — update imports
- 2 test files in relay package — update type references
- `contributing/adapter-catalog.md` — update documentation

**Acceptance Criteria:**

- [ ] No `AgentManagerLike` references in source code
- [ ] All relay tests pass

---

### Task 3.4: Rename and relocate agent-manager test files to claude-code-runtime

**Size**: Medium
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Tasks 3.1, 3.2, 3.3

Move 4 test files from `core/__tests__/` to `runtimes/claude-code/__tests__/`, rename from `agent-manager-*` to `claude-code-runtime-*`, update describe blocks and import paths. No test logic changes.

**Acceptance Criteria:**

- [ ] All 4 files moved and renamed
- [ ] Describe blocks say `ClaudeCodeRuntime`
- [ ] All 4 tests pass from new locations
- [ ] No files at old paths

---

## Phase 4: File Size Reduction

### Task 4.1: Extract sendMessage() body into message-sender.ts

**Size**: Large
**Priority**: Medium
**Dependencies**: Tasks 1.1, 1.2
**Can run parallel with**: None

Extract the 224-line `sendMessage()` body into `executeSdkQuery()` in a new `message-sender.ts` file. The runtime's `sendMessage()` becomes a thin wrapper.

**Files:**

- New: `apps/server/src/services/runtimes/claude-code/message-sender.ts`
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — thin wrapper + cleanup

**Acceptance Criteria:**

- [ ] `message-sender.ts` contains `executeSdkQuery()` async generator
- [ ] `claude-code-runtime.ts` under 500 lines (target ~470)
- [ ] All tests pass (no behavioral changes)

---

## Phase 5: Verification and Documentation

### Task 5.1: Run full verification suite and update CLAUDE.md documentation

**Size**: Medium
**Priority**: High
**Dependencies**: All previous tasks
**Can run parallel with**: None

Run full test suite, typecheck, lint, and Obsidian plugin build. Verify all 12 code review issues are resolved. Update CLAUDE.md with 7 documentation changes.

**Acceptance Criteria:**

- [ ] All 1168+ tests pass
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` no new errors
- [ ] Obsidian plugin builds
- [ ] All 12 issues verified resolved
- [ ] CLAUDE.md updated

---

## Dependency Graph

```
Phase 1 (Interface Refinement):
  1.1 ──────────────────────────────────────┐
  1.2 ──────────────────────────────────────┤
  1.3 ──────────────────────────────────────┤
                                            │
Phase 2 (Route Migration):                  │
  2.1 ──────────────────────────────────────┤
  2.2 ──────────────────────────────────────┤
  2.3 ← depends on 1.3 ────────────────────┤
                                            │
Phase 3 (Import Cleanup):                   │
  3.1 ──────────────────────────────────────┤
  3.2 ──────────────────────────────────────┤
  3.3 ──────────────────────────────────────┤
  3.4 ──────────────────────────────────────┤
                                            │
Phase 4 (File Size):                        │
  4.1 ← depends on 1.1, 1.2 ───────────────┤
                                            │
Phase 5 (Verification):                     │
  5.1 ← depends on ALL ────────────────────┘
```

## Parallel Opportunities

- **Tasks 1.1 + 1.2**: Both modify `agent-runtime.ts` but different sections; can be done in parallel if merged carefully
- **Tasks 2.1 + 2.2**: Independent route migrations
- **Tasks 3.1 + 3.2 + 3.3 + 3.4**: All cleanup tasks are independent
- **Maximum parallelism**: 4 tasks (all Phase 3 tasks simultaneously)

## Critical Path

1.3 -> 2.3 -> 5.1 (longest dependency chain through watchSession functional implementation)
