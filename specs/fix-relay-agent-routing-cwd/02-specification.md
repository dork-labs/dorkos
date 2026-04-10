---
slug: fix-relay-agent-routing-cwd
number: 90
title: Fix Relay Agent-to-Agent Routing CWD Bug + Harden ClaudeCodeAdapter Pipeline
status: draft
created: 2026-03-04
authors:
  - Claude Code
---

# Fix Relay Agent-to-Agent Routing CWD Bug + Harden ClaudeCodeAdapter Pipeline

## Status

Draft

## Authors

Claude Code — 2026-03-04

---

## Overview

Agent-to-agent relay messaging is fundamentally broken at the routing level. When agent A sends
`relay_send(subject="relay.agent.{agentBId}", ...)`, the message is handled by a generic Claude
session at the server's default CWD (repo root) instead of agent B's project directory. Three
cascading wiring bugs in the `adapterContextBuilder` pipeline prevent the target agent's
`projectPath` from being resolved and injected. This spec fixes those three bugs and hardens the
ClaudeCodeAdapter pipeline with persistent session mapping, dual-ID traceability, concurrency
safety, and a naming audit.

---

## Background / Problem Statement

The `relay.agent.{agentId}` subject pattern was designed to route a message to a specific Mesh-
registered agent by its ULID. The path is:

```
relay_send(subject="relay.agent.{agentBId}", ...)
  → RelayCore.deliver()
  → AdapterDelivery calls contextBuilder("relay.agent.{agentBId}")
  → AdapterManager.buildContext()   ← BROKEN HERE
  → ClaudeCodeAdapter.handleAgentMessage()
  → AgentManager.ensureSession(sessionId, { cwd })
```

Three bugs in `AdapterManager.buildContext()` cascade to produce `cwd = undefined`:

### Bug 1 — `meshCore` never injected (init order)

`apps/server/src/index.ts` constructs `adapterManager` at ~line 116 inside the `if (relayEnabled)`
block. `meshCore` is initialized at ~line 143 in a separate always-on block that runs **after**
the relay block completes. `AdapterManagerDeps` has no `meshCore` field.

`buildContext()` immediately returns `undefined` because `!this.deps.meshCore` is always true.

### Bug 2 — Wrong method name on the interface

`AdapterManagerDeps.meshCore` is typed as:

```typescript
meshCore?: {
  getAgent(id: string): { manifest: Record<string, unknown> } | undefined;
};
```

`MeshCore` has no `getAgent()` method. The public method is `get(agentId)` (returns
`AgentManifest | undefined`) and `getProjectPath(agentId)` (returns `string | undefined`).

### Bug 3 — Wrong field name

`buildContext()` accesses `agentInfo.manifest.directory`. `AgentManifest` has no `directory` field.
The project path lives in `AgentRegistryEntry.projectPath` — an internal type not exposed via the
public `get()` API. `MeshCore.getProjectPath()` exists at line 460 of `mesh-core.ts` and is the
correct accessor.

**Combined effect:** Every agent-to-agent relay call results in a session with `cwd = undefined`,
which falls through to `this.cwd` (the server's process.cwd() or `DEFAULT_CWD`). A blank Claude
assistant responds with no project context, AGENTS.md, or tools.

### Secondary issues addressed by this spec

Beyond the three critical bugs, the ClaudeCodeAdapter pipeline has additional reliability gaps:

- **Session continuity breaks on restart** — the mapping from Mesh ULID to SDK session UUID is
  in-memory only. Every server restart creates a new conversation for the same agent.
- **No dual-ID traceability** — relay context and trace spans only show one identifier, making
  debugging ambiguous.
- **Concurrency crash risk** — the SDK disallows concurrent `query()` calls on the same session.
  Two simultaneous relay messages to the same target silently crash with "Already connected to a
  transport".
- **Naming confusion** — `{theirSessionId}` in `RELAY_TOOLS_CONTEXT` teaches agents the wrong ID
  type, leading to invalid relay subjects.

---

## Goals

- Fix the three wiring bugs so agent-to-agent relay routing resolves the correct CWD
- Fix the initialization order in `index.ts` so `meshCore` is available when `adapterManager` starts
- Fix the interface type mismatch (`getAgent` → `getProjectPath`) in `AdapterManagerDeps`
- Add persistent `agentId → SDK UUID` session mapping that survives server restarts
- Surface both `agentId` (ULID) and `sdkSessionId` (UUID) in relay context blocks and trace spans
- Add a per-agentId async queue in CCA to serialize concurrent messages safely
- Rename all `sessionId` variables in relay files that actually refer to Mesh agent ULIDs
- Fix the `{theirSessionId}` doc label in `RELAY_TOOLS_CONTEXT` to `{theirAgentId}`

---

## Non-Goals

- Changing the `relay.agent.{agentId}` subject schema (stays as-is)
- Altering Mesh registration or discovery flows
- Modifying the BindingRouter path (`relay.human.*`)
- Per-sender session isolation (`{agentId}:{fromEndpoint}` session keys)
- UI changes for relay sessions
- The `relay_inbox` payload gap and `publishAgentResult` trace recording bugs (tracked separately)

---

## Technical Dependencies

| Dependency                       | Version   | Notes                                             |
| -------------------------------- | --------- | ------------------------------------------------- |
| `@dorkos/mesh`                   | workspace | `MeshCore.getProjectPath()` exists at line 460    |
| `@dorkos/relay`                  | workspace | `ClaudeCodeAdapter`, `AgentManagerLike` interface |
| `@dorkos/shared`                 | workspace | `AgentManifest` Zod schema                        |
| `@anthropic-ai/claude-agent-sdk` | current   | `query()` concurrency constraint                  |
| Node.js `fs/promises`            | built-in  | Atomic file writes (tmp + rename)                 |

---

## Detailed Design

### ID Glossary (for this spec and the codebase going forward)

| Term              | Type      | Purpose                                                                                                       | Example                                |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **agentId**       | Mesh ULID | Routing key; extracted from relay subject; stable across restarts                                             | `01JN4M2X5SZMHXP3EZFM9DWRXFK`          |
| **sdkSessionId**  | SDK UUID  | Conversation thread; assigned by Claude SDK on first message; maps to JSONL file                              | `550e8400-e29b-41d4-a716-446655440000` |
| **ccaSessionKey** | string    | CCA's internal session lookup key; equals agentId until Phase 2, then equals sdkSessionId after first message | —                                      |

---

### Phase 1 — Three Wiring Bug Fixes

#### 1a. Fix initialization order — `apps/server/src/index.ts`

**Problem:** `adapterManager` is constructed inside the `if (relayEnabled)` block at ~line 116.
`meshCore` is always-on and initialized at ~line 143, after the relay block.

**Fix:** Split the relay initialization into two sub-phases:

```
Phase A (inside if (relayEnabled)):
  - adapterRegistry = new AdapterRegistry()
  - traceStore = new TraceStore(db)
  - relayCore = new RelayCore(...)

Phase B (always-on, after relayCore init):
  - meshCore = new MeshCore({ db, relayCore, ... })
  - agentManager.setMeshCore(meshCore)

Phase C (back inside if (relayEnabled), after meshCore):
  - adapterManager = new AdapterManager(..., { agentManager, traceStore, pulseStore, relayCore, meshCore })
  - await adapterManager.initialize()
  - relayCore.setAdapterContextBuilder(adapterManager.buildContext.bind(adapterManager))
```

MeshCore has no dependency on AdapterManager so this reorder is safe.

#### 1b. Fix `AdapterManagerDeps.meshCore` type — `apps/server/src/services/relay/adapter-manager.ts`

**Problem:** The `meshCore?` field declares `getAgent(id)` which doesn't exist on `MeshCore`.

**Fix:** Replace the ad-hoc inline interface with a minimal structural interface that matches the
real public API:

```typescript
/** Minimal MeshCore interface needed by AdapterManager for CWD resolution. */
export interface AdapterMeshCoreLike {
  getProjectPath(agentId: string): string | undefined;
}

export interface AdapterManagerDeps {
  agentManager: ClaudeCodeAgentManagerLike;
  traceStore: TraceStoreLike;
  pulseStore?: PulseStoreLike;
  relayCore?: RelayCoreLike;
  meshCore?: AdapterMeshCoreLike;
}
```

The real `MeshCore` satisfies this interface structurally.

#### 1c. Fix `buildContext()` — `apps/server/src/services/relay/adapter-manager.ts`

**Problem:** Calls `this.deps.meshCore.getAgent(sessionId)` and accesses `agentInfo.manifest.directory`.

**Fix:**

```typescript
buildContext(subject: string): AdapterContext | undefined {
  if (!this.deps.meshCore) return undefined;
  if (!subject.startsWith('relay.agent.')) return undefined;

  const agentId = subject.split('.')[2];
  if (!agentId) return undefined;

  const projectPath = this.deps.meshCore.getProjectPath(agentId);
  if (!projectPath) return undefined;

  return {
    agent: {
      directory: projectPath,
      runtime: 'claude-code',
    },
  };
}
```

Note: The variable is renamed from `sessionId` to `agentId` as part of Phase 5 naming cleanup.

#### 1d. Fix `RELAY_TOOLS_CONTEXT` doc label — `apps/server/src/services/core/context-builder.ts`

**Problem:** Lines 25 and 27 reference `{theirSessionId}` in two places:

```
relay.agent.{sessionId}          — activate a specific agent session
mesh_inspect(agentId) to get their relay endpoint (relay.agent.{theirSessionId})
relay_send(subject="relay.agent.{theirSessionId}", ...)
```

**Fix:**

- Line 17: Rename column label `relay.agent.{sessionId}` → `relay.agent.{agentId}`
- Line 25: Change `{theirSessionId}` → `{theirAgentId}`
- Line 27: Change `{theirSessionId}` → `{theirAgentId}`
- Update inline comment: "their relay endpoint is their Mesh agent ULID (not their SDK session UUID)"

The `_RELAY_TOOLS_CONTEXT` export for tests must be updated accordingly. The existing test in
`context-builder.ts` tests should be checked for string matches.

---

### Phase 2 — Persistent Session Mapping

#### 2a. New file: `apps/server/src/services/relay/agent-session-store.ts`

JSON-file-backed store following the `BindingStore` atomic-write pattern.

```typescript
/**
 * Persistent store mapping Mesh agent ULIDs to their SDK session UUIDs.
 *
 * Survives server restarts so conversation threads are not lost.
 * Stored at {relayDir}/agent-sessions.json.
 *
 * @module services/relay/agent-session-store
 */

export interface AgentSessionRecord {
  sdkSessionId: string;
  createdAt: string; // ISO timestamp when first created
  updatedAt: string; // ISO timestamp of last update
}

export class AgentSessionStore {
  private readonly filePath: string;
  private sessions: Map<string, AgentSessionRecord> = new Map();

  constructor(relayDir: string) {
    this.filePath = join(relayDir, 'agent-sessions.json');
  }

  async init(): Promise<void>; // Load from disk; non-fatal if file missing

  get(agentId: string): string | undefined; // Returns sdkSessionId or undefined

  set(agentId: string, sdkSessionId: string): void; // Update in-memory + persist

  delete(agentId: string): void; // Remove mapping + persist

  private async persist(): Promise<void>; // Atomic tmp+rename write
}
```

Storage format (`~/.dork/relay/agent-sessions.json`):

```json
{
  "01JN4M2X5SZMHXP3EZFM9DWRXFK": {
    "sdkSessionId": "550e8400-e29b-41d4-a716-446655440000",
    "createdAt": "2026-03-04T10:00:00.000Z",
    "updatedAt": "2026-03-04T10:05:00.000Z"
  }
}
```

#### 2b. Wire `AgentSessionStore` into `AdapterManager` — `apps/server/src/services/relay/adapter-manager.ts`

- Construct `AgentSessionStore` in `initialize()` using `relayDir`
- Pass via `ClaudeCodeAdapterDeps.agentSessionStore`

#### 2c. Integrate session mapping in CCA — `packages/relay/src/adapters/claude-code-adapter.ts`

**Add to `AgentManagerLike` interface:**

```typescript
getSdkSessionId(sessionId: string): string | undefined;
```

**Add to `ClaudeCodeAdapterDeps`:**

```typescript
agentSessionStore?: AgentSessionStoreLike;  // minimal: get(agentId), set(agentId, sdkId)
```

**Update `handleAgentMessage()` session key resolution:**

```typescript
// Resolve the CCA session key:
// 1. Check persistent store for a previously mapped SDK session UUID
// 2. Fall back to agentId (ULID) for new agents
const persistedSdkId = this.deps.agentSessionStore?.get(agentId);
const ccaSessionKey = persistedSdkId ?? agentId;

this.deps.agentManager.ensureSession(ccaSessionKey, {
  permissionMode: 'default',
  hasStarted: !!persistedSdkId, // true only if we have a persisted SDK session
  ...(agentCwd ? { cwd: agentCwd } : {}),
});
```

**After `sendMessage()` stream drains**, persist the real SDK UUID:

```typescript
const realSdkId = this.deps.agentManager.getSdkSessionId(ccaSessionKey);
if (realSdkId && realSdkId !== agentId) {
  this.deps.agentSessionStore?.set(agentId, realSdkId);
}
```

When `hasStarted: true` and the persisted session is stale (JSONL deleted), `isResumeFailure()`
in AgentManager retries as a new session. CCA detects the new `realSdkId` after the stream drains
and updates the store automatically.

---

### Phase 3 — Dual-ID Traceability

#### 3a. Update `formatPromptWithContext()` — `packages/relay/src/adapters/claude-code-adapter.ts`

Add two lines to the `<relay_context>` block so receiving agents can access both IDs:

```
Agent-ID: {agentId}                 ← Mesh ULID for routing (use in relay_send subjects)
Session-ID: {sdkSessionId}          ← SDK UUID for conversation continuity (informational)
```

The `agentId` is always available (from the subject). The `sdkSessionId` should be the resolved
`ccaSessionKey` after Phase 2 integration (which will be the real SDK UUID after the first message).

#### 3b. Update trace span `toEndpoint` format

Change from:

```typescript
toEndpoint: `agent:${sessionId}`,
```

To:

```typescript
toEndpoint: `agent:${agentId}/${sdkSessionId ?? agentId}`,
```

#### 3c. Update `RELAY_TOOLS_CONTEXT` — `apps/server/src/services/core/context-builder.ts`

Extend the workflow section to explain the dual-ID model:

```
Note: Each relay message you receive includes both:
  Agent-ID — your Mesh ULID, use this in relay_send subjects and mesh_inspect calls
  Session-ID — your SDK conversation UUID, use this only if you need to reference your own session
```

---

### Phase 4 — In-CCA Async Queue (Concurrency Safety)

#### 4a. Add per-agentId promise queue — `packages/relay/src/adapters/claude-code-adapter.ts`

The SDK throws "Already connected to a transport" if two `query()` calls run concurrently on the
same session. The fix is a simple per-agentId promise chain:

```typescript
/** Per-agentId promise chain for serializing concurrent messages. */
private agentQueues = new Map<string, Promise<void>>();

private async processWithQueue(agentId: string, fn: () => Promise<DeliveryResult>): Promise<DeliveryResult> {
  const current = this.agentQueues.get(agentId) ?? Promise.resolve();
  let result!: DeliveryResult;
  const next = current.then(() => fn().then(r => { result = r; }));
  this.agentQueues.set(agentId, next.catch(() => {}));
  await next;
  return result;
}
```

In `handleAgentMessage()`, wrap the `sendMessage` call through `processWithQueue(agentId, ...)`.

On `stop()`, clear `agentQueues` (in-flight messages will still complete; new arrivals after stop
will be rejected by the semaphore since `activeCount` tracking still applies).

#### 4b. Expose queue depth in `AdapterStatus`

Add `queuedMessages?: number` to `AdapterStatus` (if it doesn't already exist) and populate it
from `agentQueues.size` in `getStatus()`. This makes queue depth visible in the Relay UI.

---

### Phase 5 — Naming Audit (sessionId vs agentId)

Audit all relay-related files for `sessionId` variables that actually hold Mesh agent ULIDs.

#### Files to audit and fix

| File                                                     | Variables/comments to rename                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/relay/src/adapters/claude-code-adapter.ts`     | `extractSessionId()` → `extractAgentId()`; internal `sessionId` local → `agentId`; `toEndpoint: agent:${sessionId}` → use agentId |
| `packages/relay/src/adapter-delivery.ts`                 | Check for any `sessionId` in comments referring to relay subjects                                                                 |
| `apps/server/src/services/relay/adapter-manager.ts`      | `const sessionId = segments[2]` → `const agentId = segments[2]` (Phase 1c already does this)                                      |
| `apps/server/src/services/core/context-builder.ts`       | `relay.agent.{sessionId}` → `relay.agent.{agentId}` in RELAY_TOOLS_CONTEXT                                                        |
| `apps/server/src/services/core/mcp-tools/relay-tools.ts` | Review any comments explaining relay subjects                                                                                     |
| `apps/server/src/services/core/interactive-handlers.ts`  | Check for sessionId/agentId in relay context                                                                                      |

#### Add glossary comment block to CCA

At the top of `packages/relay/src/adapters/claude-code-adapter.ts`, add a JSDoc comment block
explaining the three ID types and their flow (see ID Glossary above). This prevents the naming
confusion from re-emerging.

---

### Data Flow After All Fixes

```
Agent A calls relay_send(subject="relay.agent.{agentBId}", ...)
  → RelayCore delivers envelope
  → AdapterDelivery calls contextBuilder("relay.agent.{agentBId}")
  → AdapterManager.buildContext("relay.agent.{agentBId}")
      agentId = "agentBId" (extracted from subject)
      meshCore.getProjectPath("agentBId") → "/path/to/agentB"
      returns AdapterContext { agent: { directory: "/path/to/agentB", runtime: "claude-code" } }
  → CCA.handleAgentMessage()
      agentCwd = context.agent.directory = "/path/to/agentB"
      persistedSdkId = agentSessionStore.get("agentBId")  → "550e8400-..." (after first msg)
      ccaSessionKey = "550e8400-..."  (or "agentBId" on first ever message)
      enqueued via agentQueues.get("agentBId")  → serialized with any concurrent messages
      agentManager.ensureSession("550e8400-...", { cwd: "/path/to/agentB", hasStarted: true })
      agentManager.sendMessage("550e8400-...", prompt, { cwd: "/path/to/agentB" })
          → effectiveCwd = "/path/to/agentB"  ✓ correct
          → loads agentB's AGENTS.md, tools, project context  ✓
      after stream drains: agentSessionStore.set("agentBId", "550e8400-...")
```

---

## API Changes

No external HTTP API changes. The fix is entirely in the server-internal adapter pipeline.

**`AgentManagerLike` interface** (in `packages/relay/src/adapters/claude-code-adapter.ts`) gains:

```typescript
getSdkSessionId(sessionId: string): string | undefined;
```

**`AdapterManagerDeps`** gains:

```typescript
meshCore?: AdapterMeshCoreLike;
```

where `AdapterMeshCoreLike` is:

```typescript
interface AdapterMeshCoreLike {
  getProjectPath(agentId: string): string | undefined;
}
```

**`ClaudeCodeAdapterDeps`** gains an optional:

```typescript
agentSessionStore?: AgentSessionStoreLike;
```

---

## File Organization

### Files to modify

| File                                                     | Phase                 | Change type                                       |
| -------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| `apps/server/src/index.ts`                               | 1a                    | Init reorder: meshCore before adapterManager      |
| `apps/server/src/services/relay/adapter-manager.ts`      | 1b, 1c, 2b            | Fix types + buildContext + wire AgentSessionStore |
| `apps/server/src/services/core/context-builder.ts`       | 1d, 3c                | Doc labels + dual-ID guidance                     |
| `packages/relay/src/adapters/claude-code-adapter.ts`     | 2c, 3a, 3b, 4a, 4b, 5 | Session store + traceability + queue + naming     |
| `packages/relay/src/adapter-delivery.ts`                 | 5                     | Naming audit only                                 |
| `apps/server/src/services/core/mcp-tools/relay-tools.ts` | 5                     | Naming audit only                                 |

### Files to create

| File                                                                   | Phase                  | Purpose                                    |
| ---------------------------------------------------------------------- | ---------------------- | ------------------------------------------ |
| `apps/server/src/services/relay/agent-session-store.ts`                | 2a                     | Persistent agentId→SDK UUID mapping        |
| `apps/server/src/services/relay/__tests__/agent-session-store.test.ts` | 2a                     | Unit tests                                 |
| `apps/server/src/routes/__tests__/relay-conversations.test.ts`         | Pre-existing untracked | Existing test file (already in git status) |

---

## User Experience

This fix has no UI surface. Agents using `relay_send` to `relay.agent.{agentId}` subjects will
now correctly invoke the target agent's project context.

**Before:** Agent B responds with a generic Claude assistant at repo root with no project tools.

**After:** Agent B responds with its full project context: AGENTS.md instructions, `.dork/agent.json`
persona, project-scoped tools, and correct working directory.

The relay context block received by Agent B will now include:

```
<relay_context>
From: agent:01JN4M2X...
Agent-ID: 01JN4M2X5SZMHXP3EZFM9DWRXFK
Session-ID: 550e8400-e29b-41d4-a716-446655440000
...
</relay_context>
```

---

## Testing Strategy

### Unit Tests

**`packages/mesh/src/__tests__/mesh-core.test.ts`** (or create if missing)

- `getProjectPath()` returns the project path for a known agent ULID
- `getProjectPath()` returns `undefined` for an unknown ULID
- `getProjectPath()` returns `undefined` when agent has no projectPath set

**`apps/server/src/services/relay/__tests__/adapter-manager.test.ts`** (existing)

- `buildContext()` returns valid `AdapterContext` with correct `directory` when meshCore resolves a path
- `buildContext()` returns `undefined` when agentId not found in Mesh
- `buildContext()` returns `undefined` when meshCore is not injected (backward compat)
- `buildContext()` correctly parses `relay.agent.{agentId}` subjects with nested segments
- `buildContext()` returns `undefined` for non-agent subjects (`relay.human.*`)

**`apps/server/src/services/relay/__tests__/agent-session-store.test.ts`** (new)

- `get()` returns `undefined` for unknown agentId
- `set()` + `get()` round-trip stores and retrieves sdkSessionId
- `init()` loads persisted data from disk on startup
- `set()` persists to disk atomically (verify via re-init)
- `delete()` removes the mapping and persists the removal
- `init()` with missing file succeeds silently (non-fatal)
- `init()` with corrupt JSON logs a warning and starts with empty state

### Integration Tests

**`packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts`** (existing, extend)

- `handleAgentMessage()` passes `cwd` matching `context.agent.directory` to `ensureSession()`
  (currently exists as a regression test, verify it covers the directory field correctly)
- `handleAgentMessage()` uses persisted SDK session UUID from store when available
- `handleAgentMessage()` calls `agentSessionStore.set()` after stream drains
- Two concurrent `deliver()` calls to the same agentId are serialized: second starts only after
  first completes (use mock that tracks call order and timing)
- Concurrent `deliver()` calls to DIFFERENT agentIds run in parallel (no cross-agent blocking)

**`packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`** (existing)

- Verify CWD is correctly propagated end-to-end through the full pipeline

### Regression Tests

- CLI-originated sessions (`DORKOS_RELAY_ENABLED=false`) are unaffected — verify `ensureSession`
  is not called with unexpected args
- BindingRouter sessions (`relay.human.*`) are unaffected — `buildContext()` returns `undefined`
  for non-agent subjects
- Pulse dispatch sessions (`relay.system.pulse.*`) are unaffected — handled by `handlePulseMessage()`
  which uses payload CWD directly

### Test Documentation Convention

Each test should include a purpose comment:

```typescript
it('uses persisted SDK session ID to resume existing conversation', async () => {
  // Purpose: verifies that agentSessionStore.get() is consulted before ensureSession(),
  // so server restarts don't create new conversation threads for known agents.
  ...
});
```

---

## Performance Considerations

- **`AgentSessionStore.set()`** performs a synchronous Map update + async file write. File writes
  use atomic tmp+rename to prevent corruption. Under high message throughput, the write could lag
  behind; the in-memory Map is always the authoritative source within a process lifetime.
- **Per-agentId queues** add a microtask overhead per message (Promise chain), negligible vs.
  the cost of an SDK `query()` call.
- **`buildContext()`** now calls `getProjectPath()` which is a single `Map.get()` on the
  `AgentRegistry` (SQLite-backed but cached in memory). O(1) lookup, no measurable overhead.

---

## Security Considerations

- `buildContext()` returns `projectPath` from the Mesh registry. The registry only contains
  paths that passed through discovery/registration (user-approved). The `validateBoundary()` call
  in `AgentManager.sendMessage()` provides the final defense against path traversal.
- `agent-sessions.json` is stored in `~/.dork/relay/` alongside other relay data. No new
  attack surface beyond what already exists.
- Phase 5 naming audit is cosmetic only — no security implications.

---

## Documentation

- Update `contributing/architecture.md` section on Relay agent routing to describe the fixed
  pipeline and dual-ID model.
- The context-builder.ts `RELAY_TOOLS_CONTEXT` change (Phase 1d) is the agent-facing docs update.
- No external `docs/` changes needed (this is internal plumbing, not user-facing API).

---

## Implementation Phases

### Phase 1 — Three Wiring Bug Fixes (critical path)

Files: `apps/server/src/index.ts`, `apps/server/src/services/relay/adapter-manager.ts`,
`apps/server/src/services/core/context-builder.ts`

Acceptance: Agent B's `cwd` is set to its `projectPath` for relay messages. Verified by the
existing CCA test suite and manual repro with two registered agents.

### Phase 2 — Persistent Session Mapping

Files: new `agent-session-store.ts`, updates to `adapter-manager.ts` and `claude-code-adapter.ts`

Acceptance: After a server restart, the next relay message to the same agent resumes the existing
SDK conversation thread (JSONL file) rather than starting a new one.

### Phase 3 — Dual-ID Traceability

Files: `claude-code-adapter.ts`, `context-builder.ts`

Acceptance: `<relay_context>` received by agents includes `Agent-ID` and `Session-ID` lines.
Trace spans include both IDs in `toEndpoint`.

### Phase 4 — In-CCA Async Queue

Files: `claude-code-adapter.ts`

Acceptance: A test proves two concurrent `deliver()` calls to the same agentId are serialized.
The "Already connected to a transport" error cannot be triggered under concurrent relay load.

### Phase 5 — Naming Audit

Files: `claude-code-adapter.ts`, `adapter-delivery.ts`, `relay-tools.ts`, others per audit

Acceptance: No relay-related file uses `sessionId` to refer to a Mesh ULID. Glossary comment
block present in CCA.

---

## Open Questions

None — all decisions resolved during ideation-to-spec review.

---

## Related ADRs

- **ADR-0043** — Agent Storage: File-First Write-Through (`decisions/0043-agent-storage.md`)
  — The `AgentRegistryEntry.projectPath` exposed via `getProjectPath()` is populated via this pattern.
- **ADR-0062** — Mesh is always-on (referenced in `index.ts` comments) — confirms that
  `meshCore` will always be available when relay is enabled, making Phase 1a safe.

---

## References

- Ideation document: `specs/fix-relay-agent-routing-cwd/01-ideation.md`
- `MeshCore.getProjectPath()`: `packages/mesh/src/mesh-core.ts:460`
- `AgentRegistryEntry.projectPath`: `packages/mesh/src/agent-registry.ts:19-26`
- `CCA.handleAgentMessage()`: `packages/relay/src/adapters/claude-code-adapter.ts:259-421`
- `AdapterManager.buildContext()`: `apps/server/src/services/relay/adapter-manager.ts:233-252`
- `RELAY_TOOLS_CONTEXT`: `apps/server/src/services/core/context-builder.ts:13-35`
- Relay init block in `index.ts`: `apps/server/src/index.ts:100-134`
- Mesh init block in `index.ts`: `apps/server/src/index.ts:136-169`
- BindingRouter session persistence pattern: `apps/server/src/services/relay/binding-router.ts:9-10`
