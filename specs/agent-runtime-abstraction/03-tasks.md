# Task Breakdown: Agent Runtime Abstraction

Generated: 2026-03-06
Source: specs/agent-runtime-abstraction/02-specification.md
Last Decompose: 2026-03-06

## Overview

Extract a universal `AgentRuntime` interface from the existing `AgentManager` to decouple DorkOS from the Claude Agent SDK. All Claude Code-specific logic moves behind `ClaudeCodeRuntime implements AgentRuntime`. A `RuntimeRegistry` holds multiple runtimes keyed by type. This is a pure refactor with zero user-visible behavior changes.

The work is organized into 6 phases with 20 tasks total.

---

## Phase 1: Interface & Registry

### Task 1.1: Define AgentRuntime interface and RuntimeCapabilities type in shared package

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.2

**Technical Requirements**:

- Create `packages/shared/src/agent-runtime.ts` with `AgentRuntime`, `RuntimeCapabilities`, `SessionOpts`, `MessageOpts`
- Add export path `./agent-runtime` to `packages/shared/package.json`
- AgentRuntime covers session lifecycle, messaging, interactive flows, session queries, sync, locking, capabilities, commands, lifecycle, and optional tool/dependency injection methods
- RuntimeCapabilities includes: type, supportsPermissionModes, supportedPermissionModes, supportsToolApproval, supportsCostTracking, supportsResume, supportsMcp, supportsQuestionPrompt

**Acceptance Criteria**:

- [ ] File exists at `packages/shared/src/agent-runtime.ts`
- [ ] Import path `@dorkos/shared/agent-runtime` resolves correctly
- [ ] `pnpm typecheck` passes across all packages
- [ ] No circular dependencies introduced

---

### Task 1.2: Create RuntimeRegistry service with singleton export

**Size**: Small | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: 1.3

**Technical Requirements**:

- Create `apps/server/src/services/core/runtime-registry.ts`
- Map-based lookup keyed by runtime type string
- Methods: register(), get(), getDefault(), resolveForAgent(), setDefault(), listRuntimes(), getAllCapabilities(), has(), getDefaultType()
- Default type is 'claude-code'
- Export singleton `runtimeRegistry`

**Acceptance Criteria**:

- [ ] Singleton `runtimeRegistry` exported
- [ ] All methods implemented
- [ ] `pnpm typecheck` passes

---

### Task 1.3: Write RuntimeRegistry unit tests

**Size**: Small | **Priority**: High | **Dependencies**: 1.2 | **Parallel with**: None

**Technical Requirements**:

- Create `apps/server/src/services/core/__tests__/runtime-registry.test.ts`
- Test: register/get, getDefault, setDefault, resolveForAgent (5 scenarios), listRuntimes, getAllCapabilities, has
- Mock runtime factory for test reuse

**Acceptance Criteria**:

- [ ] All tests pass
- [ ] Full coverage of RuntimeRegistry API

---

### Task 1.4: Create runtimes/claude-code/ directory structure

**Size**: Small | **Priority**: Medium | **Dependencies**: None | **Parallel with**: 1.1, 1.2

**Technical Requirements**:

- Create directory `apps/server/src/services/runtimes/claude-code/`
- Create barrel files at `runtimes/claude-code/index.ts` and `runtimes/index.ts`

**Acceptance Criteria**:

- [ ] Directory structure exists
- [ ] Barrel files created

---

## Phase 2: ClaudeCodeRuntime Extraction

### Task 2.1: Move internal services into runtimes/claude-code/ directory

**Size**: Large | **Priority**: High | **Dependencies**: 1.1, 1.2, 1.4 | **Parallel with**: None

**Technical Requirements**:

- Move 13 file groups from `services/core/` and `services/session/` to `services/runtimes/claude-code/`
- Files: agent-types, sdk-event-mapper, interactive-handlers, context-builder, tool-filter, command-registry, session-lock, transcript-reader, transcript-parser, session-broadcaster, build-task-event, task-reader, mcp-tools/
- Update internal imports for deeper nesting (../../config -> ../../../config, etc.)
- Create re-export shims at ALL old paths for backward compatibility

**Acceptance Criteria**:

- [ ] All 13 file groups moved
- [ ] Re-export shims at all old paths
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test -- --run` passes (via shims)

---

### Task 2.2: Create ClaudeCodeRuntime class implementing AgentRuntime

**Size**: Large | **Priority**: High | **Dependencies**: 2.1 | **Parallel with**: None

**Technical Requirements**:

- Create `services/runtimes/claude-code/claude-code-runtime.ts`
- Class extends current AgentManager logic with `implements AgentRuntime`
- Internal ownership of TranscriptReader, SessionBroadcaster, CommandRegistryService
- Delegation methods: listSessions, getSession, getMessageHistory, getSessionTasks, getSessionETag, readFromOffset, watchSession, getCommands
- getCapabilities() returns static Claude Code capabilities
- getInternalSessionId() (renamed from getSdkSessionId) + backward-compatible alias
- Expose internal services via getTranscriptReader(), getSessionBroadcaster()
- Re-export shim at old `agent-manager.ts` path

**Acceptance Criteria**:

- [ ] `ClaudeCodeRuntime implements AgentRuntime` compiles
- [ ] All interface methods implemented
- [ ] getCapabilities() returns correct capabilities
- [ ] Backward-compatible shim works
- [ ] `pnpm typecheck` and `pnpm test -- --run` pass

---

### Task 2.3: Update existing tests for moved file paths

**Size**: Medium | **Priority**: High | **Dependencies**: 2.2 | **Parallel with**: None

**Technical Requirements**:

- Verify 9+ test files work via re-export shims
- Test files: agent-manager.test.ts (4 variants), session-broadcaster.test.ts, sessions.test.ts (4 variants)
- Run each test individually to confirm

**Acceptance Criteria**:

- [ ] All existing tests pass without modification
- [ ] `pnpm test -- --run` passes

---

## Phase 3: Route Migration

### Task 3.1: Update server startup to create ClaudeCodeRuntime and register in RuntimeRegistry

**Size**: Large | **Priority**: High | **Dependencies**: 2.2 | **Parallel with**: None

**Technical Requirements**:

- Replace `agentManager` singleton import with `ClaudeCodeRuntime` instantiation in `index.ts`
- Register runtime in `runtimeRegistry`
- Wire MeshCore, MCP factory, Relay through runtime methods
- SessionBroadcaster accessed via runtime.getSessionBroadcaster()
- TranscriptReader accessed via runtime.getTranscriptReader()
- Store runtime and registry on app.locals

**Acceptance Criteria**:

- [ ] No `agentManager` imports in `index.ts`
- [ ] Server starts successfully
- [ ] `pnpm typecheck` passes

---

### Task 3.2: Migrate sessions.ts route to use RuntimeRegistry

**Size**: Medium | **Priority**: High | **Dependencies**: 3.1 | **Parallel with**: 3.3, 3.4, 3.5

**Technical Requirements**:

- Replace `agentManager` and `transcriptReader` imports with `runtimeRegistry`
- Update all 9+ agentManager calls and transcriptReader calls to use `runtimeRegistry.getDefault()`
- Use `getInternalSessionId()` instead of `getSdkSessionId()`

**Acceptance Criteria**:

- [ ] No `agentManager` or `transcriptReader` imports
- [ ] All handlers use `runtimeRegistry.getDefault()`
- [ ] `pnpm typecheck` passes

---

### Task 3.3: Migrate models.ts and commands.ts routes to use RuntimeRegistry

**Size**: Small | **Priority**: High | **Dependencies**: 3.1 | **Parallel with**: 3.2, 3.4, 3.5

**Technical Requirements**:

- models.ts: replace `agentManager.getSupportedModels()` with `runtimeRegistry.getDefault().getSupportedModels()`
- commands.ts: no changes needed (uses CommandRegistryService directly, works via re-export shim)

**Acceptance Criteria**:

- [ ] No `agentManager` import in `models.ts`
- [ ] `pnpm typecheck` passes

---

### Task 3.4: Add GET /api/capabilities endpoint

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.1 | **Parallel with**: 3.2, 3.3, 3.5

**Technical Requirements**:

- Create `routes/capabilities.ts`
- Returns `{ capabilities, defaultRuntime }` from `runtimeRegistry`
- Mount in `app.ts`

**Acceptance Criteria**:

- [ ] Endpoint returns runtime capabilities
- [ ] Route mounted and accessible

---

### Task 3.5: Update ClaudeCodeAdapter for AgentRuntime compatibility

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.1 | **Parallel with**: 3.2, 3.3, 3.4

**Technical Requirements**:

- Verify ClaudeCodeRuntime satisfies ClaudeCodeAgentManagerLike (the adapter's interface)
- getSdkSessionId() alias ensures compatibility
- No changes needed in relay package (existing interface is compatible)

**Acceptance Criteria**:

- [ ] TypeScript verifies compatibility
- [ ] `pnpm typecheck` passes across all packages

---

### Task 3.6: Update route tests to mock RuntimeRegistry instead of agentManager

**Size**: Medium | **Priority**: High | **Dependencies**: 3.2, 3.3, 3.4 | **Parallel with**: None

**Technical Requirements**:

- Update 4+ session route test files to mock `runtimeRegistry` instead of `agentManager`
- Create capabilities route test
- All assertions reference mockRuntime methods

**Acceptance Criteria**:

- [ ] All route tests mock `runtimeRegistry`
- [ ] New capabilities test exists
- [ ] `pnpm test -- --run` passes

---

## Phase 4: Backward-Compatibility Shim Removal

### Task 4.1: Remove re-export shims and delete old service directories

**Size**: Medium | **Priority**: High | **Dependencies**: 3.6 | **Parallel with**: None

**Technical Requirements**:

- Delete all 14 re-export shims (13 files + mcp-tools directory)
- Grep to verify no remaining imports of old paths
- Delete empty `services/session/` directory
- Update any remaining test imports

**Acceptance Criteria**:

- [ ] All shims deleted
- [ ] No old path imports in codebase
- [ ] `pnpm typecheck`, `pnpm test -- --run`, `pnpm build` all pass

---

### Task 4.2: Verify no Claude SDK imports leak outside runtimes/claude-code/

**Size**: Small | **Priority**: High | **Dependencies**: 4.1 | **Parallel with**: None

**Technical Requirements**:

- Grep for `@anthropic-ai/claude-agent-sdk` outside runtimes/claude-code/ and lib/sdk-utils.ts
- Grep for `agentManager` outside runtimes/claude-code/
- Document `resolveClaudeCliPath()` in config.ts as known remaining coupling point

**Acceptance Criteria**:

- [ ] SDK imports contained to runtimes/claude-code/ and lib/sdk-utils.ts
- [ ] No `agentManager` usage outside the runtime

---

## Phase 5: Client Capability Detection

### Task 5.1: Add getCapabilities() to Transport interface and implement in HttpTransport

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.4 | **Parallel with**: 5.2

**Technical Requirements**:

- Add `getCapabilities()` to `Transport` interface in `packages/shared/src/transport.ts`
- Implement in `HttpTransport` via `GET /api/capabilities`

**Acceptance Criteria**:

- [ ] Transport interface includes the method
- [ ] HttpTransport implements it
- [ ] `pnpm typecheck` passes

---

### Task 5.2: Implement getCapabilities() in DirectTransport and update DirectTransportServices

**Size**: Medium | **Priority**: Medium | **Dependencies**: 5.1 | **Parallel with**: None

**Technical Requirements**:

- Rename `DirectTransportServices.agentManager` to `DirectTransportServices.runtime`
- Add `getCapabilities()` to the runtime interface shape
- Implement getCapabilities() in DirectTransport (returns Claude Code capabilities directly)
- Update all internal `this.services.agentManager` references to `this.services.runtime`
- Update Obsidian plugin's DirectTransport construction

**Acceptance Criteria**:

- [ ] Interface renamed
- [ ] getCapabilities() implemented
- [ ] Obsidian plugin updated
- [ ] `pnpm typecheck` and `pnpm build` pass

---

### Task 5.3: Create useRuntimeCapabilities hook and gate UI features

**Size**: Medium | **Priority**: Medium | **Dependencies**: 5.1 | **Parallel with**: 5.2

**Technical Requirements**:

- Create `entities/runtime/` FSD module with useRuntimeCapabilities and useDefaultCapabilities hooks
- TanStack Query with `staleTime: Infinity`
- Create barrel file at `entities/runtime/index.ts`

**Acceptance Criteria**:

- [ ] Hooks exist and work
- [ ] Entity barrel exports both hooks
- [ ] `pnpm typecheck` passes

---

## Phase 6: Cleanup & Verification

### Task 6.1: Run full test suite, typecheck, lint, and build verification

**Size**: Medium | **Priority**: High | **Dependencies**: 4.2, 5.2, 5.3 | **Parallel with**: 6.2

**Technical Requirements**:

- Run `pnpm typecheck`, `pnpm test -- --run`, `pnpm lint`, `pnpm build`
- Verify SDK import containment via grep
- Verify old import path removal via grep
- Run Docker smoke test if available

**Acceptance Criteria**:

- [ ] All quality gates pass
- [ ] SDK imports contained
- [ ] No old import paths remain

---

### Task 6.2: Update CLAUDE.md and architecture documentation

**Size**: Medium | **Priority**: Medium | **Dependencies**: 4.2 | **Parallel with**: 6.1

**Technical Requirements**:

- Update `CLAUDE.md` service descriptions: replace AgentManager with ClaudeCodeRuntime + RuntimeRegistry
- Update `contributing/architecture.md` with RuntimeRegistry section
- Update `contributing/api-reference.md` with GET /api/capabilities
- Remove stale references to `agentManager` singleton

**Acceptance Criteria**:

- [ ] Documentation reflects new architecture
- [ ] No stale references to agentManager in docs

---

## Dependency Graph

```
Phase 1:  [1.1] ──┬──> [1.2] ──> [1.3]
          [1.4] ──┘

Phase 2:  [1.1, 1.2, 1.4] ──> [2.1] ──> [2.2] ──> [2.3]

Phase 3:  [2.2] ──> [3.1] ──┬──> [3.2] ──┐
                             ├──> [3.3] ──┤
                             ├──> [3.4] ──├──> [3.6]
                             └──> [3.5] ──┘

Phase 4:  [3.6] ──> [4.1] ──> [4.2]

Phase 5:  [3.4] ──> [5.1] ──┬──> [5.2]
                             └──> [5.3]

Phase 6:  [4.2, 5.2, 5.3] ──> [6.1]
          [4.2] ──> [6.2]
```

## Critical Path

1.1 -> 1.2 -> 2.1 -> 2.2 -> 2.3 -> 3.1 -> 3.2 -> 3.6 -> 4.1 -> 4.2 -> 6.1

## Parallel Opportunities

- Tasks 1.1 and 1.4 can run in parallel (no dependencies)
- Tasks 1.2 and 1.3 can overlap (1.3 starts as soon as 1.2 is done)
- Tasks 3.2, 3.3, 3.4, 3.5 can all run in parallel (all depend only on 3.1)
- Tasks 5.2 and 5.3 can run in parallel (both depend on 5.1)
- Tasks 6.1 and 6.2 can run in parallel (different dependency sets)
