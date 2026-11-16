# Task Breakdown: Fix Relay Agent-to-Agent Routing CWD Bug + Harden ClaudeCodeAdapter Pipeline

**Spec**: `specs/fix-relay-agent-routing-cwd/02-specification.md`
**Generated**: 2026-03-04
**Mode**: full

---

## Summary

Agent-to-agent relay messaging routes messages to the wrong CWD due to three cascading wiring bugs in the `AdapterManager.buildContext()` pipeline. This breakdown fixes those bugs across five phases, then hardens the pipeline with persistent session mapping, dual-ID traceability, concurrency safety, and a naming audit.

**Total tasks**: 12
**Phases**: 5

---

## Phase 1 — Three Wiring Bug Fixes (Critical Path)

**Goal**: Fix the root cause. After Phase 1, `buildContext('relay.agent.{agentId}')` returns a valid `AdapterContext` with the correct `directory`, and agents teaching tools use `{agentId}` terminology.

### Task 1.1 — Fix `AdapterManagerDeps.meshCore` type and `buildContext()` method

**Size**: small | **Priority**: high | **Parallel with**: 1.2

Fixes two of the three wiring bugs in `apps/server/src/services/relay/adapter-manager.ts`:

**Bug 1b**: The `meshCore?` field declares `getAgent(id)` which does not exist on `MeshCore`. Replace with a named structural interface `AdapterMeshCoreLike` that exposes `getProjectPath(agentId): string | undefined`.

**Bug 1c**: `buildContext()` calls `this.deps.meshCore.getAgent(sessionId)` and reads `agentInfo.manifest.directory`. Replace with:

```typescript
export interface AdapterMeshCoreLike {
  getProjectPath(agentId: string): string | undefined;
}

buildContext(subject: string): AdapterContext | undefined {
  if (!this.deps.meshCore) return undefined;
  if (!subject.startsWith('relay.agent.')) return undefined;
  const agentId = subject.split('.')[2];
  if (!agentId) return undefined;
  const projectPath = this.deps.meshCore.getProjectPath(agentId);
  if (!projectPath) return undefined;
  return { agent: { directory: projectPath, runtime: 'claude-code' } };
}
```

**Files**: `apps/server/src/services/relay/adapter-manager.ts`

---

### Task 1.2 — Fix `RELAY_TOOLS_CONTEXT` doc labels in context-builder.ts

**Size**: small | **Priority**: high | **Parallel with**: 1.1

Rename all `{sessionId}` and `{theirSessionId}` labels in the `RELAY_TOOLS_CONTEXT` constant to `{agentId}` and `{theirAgentId}`. These label the relay subject hierarchy shown to agents; using the wrong term causes agents to pass SDK UUIDs as relay subjects.

Specific replacements in `apps/server/src/services/core/context-builder.ts`:

- `relay.agent.{sessionId}` → `relay.agent.{agentId}`
- `relay.inbox.{sessionId}` → `relay.inbox.{agentId}`
- `{theirSessionId}` (two occurrences) → `{theirAgentId}`
- `{mySessionId}` (two occurrences) → `{myAgentId}`
- Step 1 text: `their session IDs` → `their agent IDs`

**Files**: `apps/server/src/services/core/context-builder.ts`

---

### Task 1.3 — Fix `index.ts` init order so `meshCore` is available when `adapterManager` starts

**Size**: medium | **Priority**: high | **Depends on**: 1.1

Fixes Bug 1a: `adapterManager` is currently constructed before `meshCore` is initialized, so its `meshCore` dep is always `undefined`.

Split the relay init into three sub-phases:

**Phase A** (inside `if (relayEnabled)`, before meshCore): Initialize `adapterRegistry`, `traceStore`, `relayCore`.

**Phase B** (always-on): Initialize `meshCore` (unchanged).

**Phase C** (inside `if (relayEnabled && relayCore)`, AFTER meshCore): Construct `adapterManager` with `meshCore` included:

```typescript
adapterManager = new AdapterManager(adapterRegistry, adapterConfigPath, {
  agentManager,
  traceStore,
  pulseStore,
  relayCore,
  meshCore, // now available
});
await adapterManager.initialize();
relayCore.setAdapterContextBuilder(adapterManager.buildContext.bind(adapterManager));
```

`adapterRegistry` must be hoisted to the module-level `let` declarations.

**Files**: `apps/server/src/index.ts`

---

### Task 1.4 — Add `buildContext()` tests to adapter-manager.test.ts

**Size**: small | **Priority**: high | **Depends on**: 1.1 | **Parallel with**: 1.3

Add a `describe('buildContext()', ...)` block to `apps/server/src/services/relay/__tests__/adapter-manager.test.ts` with 5 tests:

1. Returns valid `AdapterContext` with correct directory when meshCore resolves a path
2. Returns `undefined` when agentId not found in Mesh
3. Returns `undefined` when meshCore is not injected (backward compat)
4. Returns `undefined` for non-agent subjects (`relay.human.*`, `relay.system.*`, `relay.inbox.*`)
5. Correctly parses `relay.agent.{agentId}` with ULID-format agentIds

**Files**: `apps/server/src/services/relay/__tests__/adapter-manager.test.ts`

---

## Phase 2 — Persistent Session Mapping

**Goal**: Server restarts no longer create new conversation threads for known agents. The mapping from Mesh ULID to SDK session UUID is persisted to `~/.dork/relay/agent-sessions.json`.

### Task 2.1 — Create `AgentSessionStore` for persistent agentId-to-SDK-UUID mapping

**Size**: medium | **Priority**: high | **Depends on**: 1.1, 1.3

Create `apps/server/src/services/relay/agent-session-store.ts` with:

- `AgentSessionRecord` interface: `{ sdkSessionId, createdAt, updatedAt }`
- `AgentSessionStoreLike` interface: `{ get(agentId), set(agentId, sdkId) }` (consumed by CCA)
- `AgentSessionStore` class with `init()`, `get()`, `set()`, `delete()`, `persist()` (atomic tmp+rename)

Storage at `{relayDir}/agent-sessions.json`. `init()` is non-fatal: missing file → empty state; corrupt JSON → warning + empty state.

**Files**: `apps/server/src/services/relay/agent-session-store.ts` (new)

---

### Task 2.2 — Add unit tests for `AgentSessionStore`

**Size**: medium | **Priority**: high | **Depends on**: 2.1

Create `apps/server/src/services/relay/__tests__/agent-session-store.test.ts` with 9 tests covering:

- `get()` returns `undefined` for unknown agentId
- `set()` + `get()` round-trip
- `set()` preserves `createdAt` on update
- `init()` loads from disk
- `init()` succeeds silently on ENOENT
- `init()` logs warning and starts empty on corrupt JSON
- `set()` uses atomic tmp+rename write
- Persist+init round-trip (restart simulation)
- `delete()` removes from memory and persists

**Files**: `apps/server/src/services/relay/__tests__/agent-session-store.test.ts` (new)

---

### Task 2.3 — Wire `AgentSessionStore` into `AdapterManager` and CCA

**Size**: large | **Priority**: high | **Depends on**: 2.1, 1.1, 1.3

Five-step integration:

1. **`adapter-manager.ts`**: Initialize `AgentSessionStore` in `initBindingSubsystem()` using `relayDir`. Add `getAgentSessionStore()` getter.

2. **`claude-code-adapter.ts` deps**: Add `agentSessionStore?: AgentSessionStoreLike` to `ClaudeCodeAdapterDeps`. Add `getSdkSessionId(sessionId): string | undefined` to `AgentManagerLike`.

3. **`agent-manager.ts`**: Implement `getSdkSessionId()` on the real `AgentManager`. Add `sdkSessionId?: string` to `AgentSession` if needed.

4. **`handleAgentMessage()` in CCA**: Replace direct `extractSessionId()` use with the two-step resolution:

   ```typescript
   const persistedSdkId = this.deps.agentSessionStore?.get(agentId);
   const ccaSessionKey = persistedSdkId ?? agentId;
   // ensureSession with hasStarted: !!persistedSdkId
   // After stream: store.set(agentId, realSdkId)
   ```

5. **`adapter-factory.ts`**: Pass `agentSessionStore` when constructing CCA instances.

**Files**: `apps/server/src/services/relay/adapter-manager.ts`, `packages/relay/src/adapters/claude-code-adapter.ts`, `apps/server/src/services/core/agent-manager.ts`, `apps/server/src/services/core/agent-types.ts`, `apps/server/src/services/relay/adapter-factory.ts`

---

### Task 2.4 — Add session mapping integration tests to CCA test suite

**Size**: medium | **Priority**: medium | **Depends on**: 2.3

Extend `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` with 3 tests:

1. Uses persisted SDK session ID to resume existing conversation (verifies `ensureSession` called with persisted UUID and `hasStarted: true`)
2. Uses agentId as session key on first-ever message (verifies `hasStarted: false`)
3. Calls `agentSessionStore.set()` after stream drains with real SDK UUID

Requires updating mock `createMockAgentManager()` to implement `getSdkSessionId()` and adding `createMockAgentSessionStore()`.

**Files**: `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts`

---

## Phase 3 — Dual-ID Traceability

**Goal**: Agents receiving relay messages can see both their Mesh ULID (for routing) and their SDK UUID (for conversation continuity) in the `<relay_context>` block.

### Task 3.1 — Add `Agent-ID` and `Session-ID` lines to relay_context block

**Size**: small | **Priority**: medium | **Depends on**: 2.3

Three changes:

1. **`formatPromptWithContext()` in CCA**: Add `agentId` and `sdkSessionId` parameters. Insert two lines after `From:`:

   ```
   Agent-ID: {agentId}          ← Mesh ULID for routing
   Session-ID: {sdkSessionId}   ← SDK UUID for conversation continuity
   ```

2. **Trace span `toEndpoint`**: Change from `agent:${sessionId}` to `agent:${agentId}/${ccaSessionKey}`.

3. **`RELAY_TOOLS_CONTEXT` in context-builder.ts**: Add a note explaining the dual-ID model to the workflow section.

**Files**: `packages/relay/src/adapters/claude-code-adapter.ts`, `apps/server/src/services/core/context-builder.ts`

---

## Phase 4 — In-CCA Async Queue

**Goal**: Two concurrent `relay_send` calls to the same agent are serialized. The "Already connected to a transport" SDK error cannot be triggered.

### Task 4.1 — Add per-agentId promise queue to CCA for concurrency safety

**Size**: medium | **Priority**: high | **Depends on**: 2.3

Add to `ClaudeCodeAdapter`:

```typescript
private agentQueues = new Map<string, Promise<void>>();

private async processWithQueue(
  agentId: string,
  fn: () => Promise<DeliveryResult>,
): Promise<DeliveryResult> {
  const current = this.agentQueues.get(agentId) ?? Promise.resolve();
  let result!: DeliveryResult;
  const next = current.then(() => fn().then(r => { result = r; }));
  this.agentQueues.set(agentId, next.catch(() => {}));
  await next;
  return result;
}
```

Wrap the agent message path in `deliver()` through `processWithQueue()`. Clear `agentQueues` in `stop()`. Expose `queuedMessages: agentQueues.size` in `getStatus()`.

**Files**: `packages/relay/src/adapters/claude-code-adapter.ts`, `packages/relay/src/types.ts` (if `AdapterStatus` needs `queuedMessages` field)

---

### Task 4.2 — Add concurrency serialization tests to CCA test suite

**Size**: small | **Priority**: high | **Depends on**: 4.1

Add `describe('per-agentId queue (concurrency safety)', ...)` with 2 tests:

1. **Same agentId serialized**: Two concurrent deliveries to `relay.agent.SAME_AGENT` — the second `sendMessage` starts only after the first completes. Proven by tracking call order with a hanging mock stream.

2. **Different agentIds parallel**: Two concurrent deliveries to `relay.agent.AGENT_A` and `relay.agent.AGENT_B` — both `sendMessage` calls start without waiting for the other to complete.

**Files**: `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts`

---

## Phase 5 — Naming Audit

**Goal**: No relay-related file uses `sessionId` to refer to a Mesh agent ULID. The ID glossary comment block is present in CCA.

### Task 5.1 — Rename `extractSessionId` to `extractAgentId` and audit CCA

**Size**: small | **Priority**: medium | **Depends on**: 2.3, 3.1, 4.1 | **Parallel with**: 5.2

In `packages/relay/src/adapters/claude-code-adapter.ts`:

1. Rename `extractSessionId()` → `extractAgentId()` with updated JSDoc
2. Rename all local vars that hold relay-subject-extracted ULIDs from `sessionId` → `agentId`
3. Update `publishResponse()` and `publishAgentResult()` call sites to pass `agentId`
4. Update error messages and JSDoc comments referencing `sessionId` in relay context
5. Add the ID glossary comment block at the top of the file (before imports):
   ```
   // ID GLOSSARY:
   // agentId      — Mesh ULID, extracted from relay.agent.{agentId} subjects. Stable.
   // sdkSessionId — SDK UUID, assigned by Claude Agent SDK. Maps to JSONL file.
   // ccaSessionKey — CCA internal key: sdkSessionId if persisted, else agentId.
   ```

**Files**: `packages/relay/src/adapters/claude-code-adapter.ts`

---

### Task 5.2 — Naming audit in adapter-delivery.ts, relay-tools.ts, and interactive-handlers.ts

**Size**: small | **Priority**: low | **Depends on**: 2.3 | **Parallel with**: 5.1

Audit three files for relay-subject `sessionId` terminology:

- **`packages/relay/src/adapter-delivery.ts`**: Check for `sessionId` in relay-subject extraction or `toEndpoint` construction
- **`apps/server/src/services/core/mcp-tools/relay-tools.ts`**: Check tool schema description strings for `relay.agent.{sessionId}` references
- **`apps/server/src/services/core/interactive-handlers.ts`**: Check for relay context `sessionId` usages

Rename any `sessionId` that holds a Mesh ULID to `agentId`. Update doc strings. Note files as clean if no issues found.

**Files**: `packages/relay/src/adapter-delivery.ts`, `apps/server/src/services/core/mcp-tools/relay-tools.ts`, `apps/server/src/services/core/interactive-handlers.ts`

---

### Task 5.3 — Update relay-cca-roundtrip test and run full test suite

**Size**: small | **Priority**: medium | **Depends on**: 5.1, 5.2, 4.2, 2.4

Final validation task:

1. **Update `relay-cca-roundtrip.test.ts`**: Add a CWD propagation test that verifies `context.agent.directory` flows end-to-end to `ensureSession()`. Update `createMockAgentManager()` to implement `getSdkSessionId()` (required by updated `AgentManagerLike`).

2. **Run all affected test suites**:

   ```bash
   pnpm vitest run packages/relay
   pnpm vitest run apps/server/src/services/relay
   pnpm vitest run apps/server/src/services/core
   ```

3. **Run typecheck**: `pnpm typecheck`

4. Fix any remaining failures from interface changes across the five phases.

**Files**: `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`

---

## Dependency Graph

```
1.1 ──────────────────────────────────────────────────────────────────────────┐
1.2 (parallel with 1.1)                                                         │
1.3 (depends on 1.1) ──────────────────────────────────────────────────────────┤
1.4 (depends on 1.1, parallel with 1.3)                                        │
                                                                                │
2.1 (depends on 1.1, 1.3) ──────────────────────────────────────────────────   │
2.2 (depends on 2.1)                                                            │
2.3 (depends on 2.1, 1.1, 1.3) ─────────────────────────────────────────────  ┘
2.4 (depends on 2.3)

3.1 (depends on 2.3)

4.1 (depends on 2.3) ──────────────────────────────────────────────────────────
4.2 (depends on 4.1)

5.1 (depends on 2.3, 3.1, 4.1) ────────────────────────────────────────────── ┐
5.2 (depends on 2.3, parallel with 5.1)                                        │
5.3 (depends on 5.1, 5.2, 4.2, 2.4) ◄─────────────────────────────────────── ┘
```

## Files Changed Summary

| File                                                     | Tasks              | Change Type                                       |
| -------------------------------------------------------- | ------------------ | ------------------------------------------------- |
| `apps/server/src/index.ts`                               | 1.3                | Init reorder: meshCore before adapterManager      |
| `apps/server/src/services/relay/adapter-manager.ts`      | 1.1, 2.3           | Fix types + buildContext + wire AgentSessionStore |
| `apps/server/src/services/core/context-builder.ts`       | 1.2, 3.1           | Doc labels + dual-ID guidance                     |
| `packages/relay/src/adapters/claude-code-adapter.ts`     | 2.3, 3.1, 4.1, 5.1 | Session store + traceability + queue + naming     |
| `packages/relay/src/adapter-delivery.ts`                 | 5.2                | Naming audit only                                 |
| `apps/server/src/services/core/mcp-tools/relay-tools.ts` | 5.2                | Naming audit only                                 |
| `apps/server/src/services/core/interactive-handlers.ts`  | 5.2                | Naming audit only                                 |
| `apps/server/src/services/core/agent-manager.ts`         | 2.3                | Add getSdkSessionId()                             |
| `apps/server/src/services/core/agent-types.ts`           | 2.3                | Add sdkSessionId? to AgentSession                 |
| `apps/server/src/services/relay/adapter-factory.ts`      | 2.3                | Pass agentSessionStore to CCA                     |
| `packages/relay/src/types.ts`                            | 4.1                | Add queuedMessages? to AdapterStatus              |

## Files Created Summary

| File                                                                   | Task | Purpose                             |
| ---------------------------------------------------------------------- | ---- | ----------------------------------- |
| `apps/server/src/services/relay/agent-session-store.ts`                | 2.1  | Persistent agentId→SDK UUID mapping |
| `apps/server/src/services/relay/__tests__/agent-session-store.test.ts` | 2.2  | Unit tests for AgentSessionStore    |
