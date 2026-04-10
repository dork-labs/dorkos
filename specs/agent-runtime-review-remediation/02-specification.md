# Agent Runtime Abstraction — Review Remediation

**Status:** Draft
**Authors:** Claude Code, Dorian Collier (decisions)
**Created:** 2026-03-06
**Spec Number:** 99
**Ideation:** [01-ideation.md](./01-ideation.md)
**Code Review:** `.temp/agent-runtime-abstraction-review-findings.md`
**Research:** `research/20260306_agent_runtime_interface_design_patterns.md`

---

## Overview

Address 12 issues identified in the code review of the agent-runtime-abstraction refactor (commit `bc0fe8b`). This is a cleanup/remediation spec — no user-visible behavior changes. All 1168 server tests currently pass.

The issues fall into four groups:

- **Group A (Route Migration):** Two routes bypass `RuntimeRegistry`, creating duplicate service instances and defeating the abstraction
- **Group B (Import Cleanup):** Stale import paths, backward-compatibility shims, old naming conventions, and misplaced test files
- **Group C (Interface Refinement):** Type safety gaps in the `AgentRuntime` interface — an overly broad `SseResponse`, a dead `watchSession()` stub, and `unknown` DI types
- **Group D (File Size):** `claude-code-runtime.ts` at 687 lines exceeds the 500-line threshold

## Background / Problem Statement

The agent-runtime-abstraction spec (#97) successfully extracted a universal `AgentRuntime` interface, created `RuntimeRegistry`, and moved Claude-specific services into `services/runtimes/claude-code/`. However, the implementation left several loose ends:

1. **Incomplete route migration:** `relay.ts` and `commands.ts` still bypass the registry, importing Claude Code services directly. This creates duplicate `TranscriptReader` instances (two metadata caches), defeats the abstraction, and hardcodes routes to Claude Code.

2. **Stale compatibility shims:** The Obsidian plugin imports from `@dorkos/server/services/agent-manager` (the old path). `core/index.ts` re-exports `ClaudeCodeRuntime as AgentManager`. The relay package uses `AgentManagerLike` naming. Four test files are named `agent-manager-*` in the wrong directory.

3. **Interface lies:** `watchSession()` returns `() => {}` while routes use `getSessionBroadcaster()` (a non-interface escape hatch). `SseResponse` is too broad, forcing an `as Response` cast. DI methods use `unknown`, providing zero type safety at call sites.

4. **File size:** `claude-code-runtime.ts` at 687 lines violates the project's 500-line threshold, with `sendMessage()` alone spanning 224 lines.

## Goals

- Migrate all routes to use `runtimeRegistry.getDefault()` — no direct imports of Claude Code services from routes
- Eliminate all backward-compatibility shims and stale naming
- Make the `AgentRuntime` interface honest: `watchSession()` works, `SseResponse` expresses domain intent, DI methods are type-safe
- Reduce `claude-code-runtime.ts` below 500 lines
- Maintain all existing tests (rename/relocate, not rewrite)

## Non-Goals

- Adding a second runtime implementation
- Changing runtime behavior or the SDK integration
- Redesigning the SessionBroadcaster architecture
- Modifying the Transport interface or client code
- Optimizing TranscriptReader caching beyond consolidating the singleton

## Technical Dependencies

- No new external dependencies
- Existing: `@anthropic-ai/claude-agent-sdk`, `chokidar`, `gray-matter`

---

## Detailed Design

### Phase 1: Interface Refinement (Group C — Issues #5, #6, #7)

These changes form the foundation that other phases depend on.

#### 1.1 Narrow `SseResponse` Interface (Issue #5)

**File:** `packages/shared/src/agent-runtime.ts`

**Current:**

```typescript
export interface SseResponse {
  on(event: string, cb: () => void): void;
}
```

**Change to:**

```typescript
/** Minimal response interface for session locking — only needs close event detection. */
export interface SseResponse {
  on(event: 'close', cb: () => void): void;
}
```

**File:** `apps/server/src/services/runtimes/claude-code/session-lock.ts`

**Current (line 23):**

```typescript
acquireLock(sessionId: string, clientId: string, res: Response): boolean {
```

**Change to:**

```typescript
import type { SseResponse } from '@dorkos/shared/agent-runtime';

acquireLock(sessionId: string, clientId: string, res: SseResponse): boolean {
```

Remove the `import type { Response } from 'express'` import.

**File:** `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`

**Remove the cast (line 590):**

```typescript
// Before
return this.lockManager.acquireLock(sessionId, clientId, res as Response);
// After
return this.lockManager.acquireLock(sessionId, clientId, res);
```

Express `Response` satisfies `{ on(event: 'close', cb: () => void): void }` structurally — no adapter needed.

#### 1.2 Define Narrow DI Port Interfaces (Issue #7)

**File:** `packages/shared/src/agent-runtime.ts`

Add before the `AgentRuntime` interface:

```typescript
/**
 * Narrow port interface for agent registry operations.
 * MeshCore satisfies this structurally — no `implements` clause needed.
 */
export interface AgentRegistryPort {
  getRegisteredAgents(): Array<{
    id: string;
    projectPath: string;
    name?: string;
    runtime?: string;
  }>;
  getByPath(cwd: string): { id: string; name?: string } | undefined;
  updateLastSeen(agentId: string, event: string): void;
}

/**
 * Narrow port interface for relay messaging operations.
 * RelayCore satisfies this structurally — no `implements` clause needed.
 */
export interface RelayPort {
  publish(subject: string, envelope: unknown): Promise<void>;
  isEnabled(): boolean;
}
```

**Update the interface methods:**

```typescript
// Before
setMeshCore?(meshCore: unknown): void;
setRelay?(relay: unknown): void;

// After
setMeshCore?(meshCore: AgentRegistryPort): void;
setRelay?(relay: RelayPort): void;
```

**File:** `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`

Update `setMeshCore()` and `setRelay()` to use the port types instead of `MeshCore` / `unknown`:

```typescript
import type { AgentRegistryPort, RelayPort } from '@dorkos/shared/agent-runtime';

// Field declarations
private meshCore?: AgentRegistryPort;

setMeshCore(meshCore: AgentRegistryPort): void {
  this.meshCore = meshCore;
}

setRelay(relay: RelayPort): void {
  if (relay && typeof relay === 'object') {
    this.broadcaster.setRelay(relay as Parameters<SessionBroadcaster['setRelay']>[0]);
  }
}
```

**Note:** The `AgentRegistryPort` must include all methods that `ClaudeCodeRuntime` actually calls on `meshCore`. Audit the runtime for all `this.meshCore.someMethod()` calls and ensure the port interface covers them. The ideation listed `getRegisteredAgents()` and `getByPath()` — verify this is exhaustive during implementation by grepping for `this.meshCore.` in the runtime.

**File:** `apps/server/src/index.ts`

No changes needed at the call site — `meshCore` (MeshCore) and `relayCore` (RelayCore) satisfy the port interfaces structurally.

#### 1.3 Make `watchSession()` Functional (Issue #6)

**File:** `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`

Add a `registerCallback()` method alongside the existing `registerClient()`:

```typescript
/**
 * Register a callback-based listener for session changes.
 * Returns an unsubscribe function.
 * Used by ClaudeCodeRuntime.watchSession() to satisfy the AgentRuntime interface.
 */
registerCallback(
  sessionId: string,
  projectDir: string,
  callback: (event: StreamEvent) => void,
  clientId?: string
): () => void {
  const id = clientId ?? `cb-${Date.now()}`;
  // Store callback in a Map alongside the existing SSE clients
  // When broadcastUpdate fires, invoke all registered callbacks too
  // Return unsubscribe function that removes the callback
}
```

The implementation should:

1. Store callbacks in a `Map<string, { callback, sessionId, projectDir }>` (parallel to the existing SSE client map)
2. In `broadcastUpdate()`, iterate callbacks for the session and invoke them with the parsed events
3. Start file watcher for the session if not already watching (same logic as `registerClient`)
4. Return `() => void` that removes the callback and stops the watcher if no more listeners exist

**File:** `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`

Replace the stub:

```typescript
watchSession(
  sessionId: string,
  projectDir: string,
  callback: (event: StreamEvent) => void,
  clientId?: string
): () => void {
  return this.broadcaster.registerCallback(sessionId, projectDir, callback, clientId);
}
```

### Phase 2: Route Migration (Group A — Issues #2, #3, #8, #10)

#### 2.1 Migrate `commands.ts` to RuntimeRegistry (Issue #3)

**File:** `apps/server/src/routes/commands.ts`

This is the simpler migration. The route currently maintains a per-CWD `CommandRegistryService` cache with LRU eviction (max 50). The `AgentRuntime` interface has `getCommands(forceRefresh?: boolean)` and `ClaudeCodeRuntime` implements it.

**However**, the route's per-CWD caching is not captured by the current interface — `getCommands()` has no `cwd` parameter. Two options:

**Option A (minimal):** Add `cwd` parameter to `AgentRuntime.getCommands()`:

```typescript
getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry>;
```

And implement per-CWD dispatch in `ClaudeCodeRuntime`:

```typescript
async getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry> {
  const root = cwd || this.cwd;
  // Use internal cache keyed by root
  if (!this.commandRegistries) this.commandRegistries = new Map();
  let registry = this.commandRegistries.get(root);
  if (!registry) {
    registry = new CommandRegistryService(root);
    this.commandRegistries.set(root, registry);
  }
  return registry.getCommands(forceRefresh);
}
```

**Option B (simpler):** Since commands are scoped to `.claude/commands/` in the CWD, and the runtime already has a CWD, just use the runtime's built-in command registry. The per-CWD caching in the route was a workaround for not having the runtime.

**Decision: Option A.** The route legitimately needs per-CWD commands (different working directories have different `.claude/commands/`).

**Updated route:**

```typescript
import { runtimeRegistry } from '../services/core/runtime-registry.js';

router.get('/', async (req, res) => {
  // ... validation ...
  const runtime = runtimeRegistry.getDefault();
  const commands = await runtime.getCommands(refresh, validatedCwd);
  res.json(commands);
});
```

Remove the `CommandRegistryService` import, `registryCache`, and `getRegistry()` function.

#### 2.2 Migrate `relay.ts` to RuntimeRegistry (Issue #2)

**File:** `apps/server/src/routes/relay.ts`

The route uses `transcriptReader.getSession(vaultRoot, id)` at line 243 for subject label resolution. Replace with `runtimeRegistry.getDefault().getSession()`:

```typescript
import { runtimeRegistry } from '../services/core/runtime-registry.js';

// Before
const resolverDeps = {
  getSession: async (id: string) => transcriptReader.getSession(vaultRoot, id),
  readManifest: async (cwd: string) => readManifest(cwd),
};

// After
const resolverDeps = {
  getSession: async (id: string) => {
    const runtime = runtimeRegistry.getDefault();
    return runtime.getSession(vaultRoot, id);
  },
  readManifest: async (cwd: string) => readManifest(cwd),
};
```

Remove the `transcriptReader` import from the route.

#### 2.3 Remove TranscriptReader Singleton (Issue #8)

**File:** `apps/server/src/services/runtimes/claude-code/transcript-reader.ts`

After relay.ts migration (2.2), the module-level singleton is unused. Remove:

```typescript
// DELETE this line
export const transcriptReader = new TranscriptReader();
```

Keep the `TranscriptReader` class export — it's used by `ClaudeCodeRuntime`'s constructor.

Verify no other files import the singleton by grepping for `from.*transcript-reader` and checking for named `transcriptReader` imports.

#### 2.4 Remove `sessionBroadcaster` from `app.locals` (Issue #10)

**File:** `apps/server/src/index.ts`

With `watchSession()` now functional (Phase 1.3), routes can call the runtime interface instead of accessing `app.locals.sessionBroadcaster`.

**Current (lines 274-279):**

```typescript
const sessionBroadcaster = claudeRuntime.getSessionBroadcaster();
if (relayCore) {
  sessionBroadcaster.setRelay(relayCore);
}
app.locals.sessionBroadcaster = sessionBroadcaster;
```

**After:**

```typescript
// Configure relay on the runtime's broadcaster (internal to the runtime)
if (relayCore) {
  claudeRuntime.getSessionBroadcaster().setRelay(relayCore);
}
// No app.locals — routes use runtime.watchSession()
```

**Note:** `getSessionBroadcaster()` is still needed here for relay setup. Consider adding a `setRelayOnBroadcaster(relay)` method to the runtime if we want to fully encapsulate the broadcaster, but this is not required for this spec — the relay setup in `index.ts` is a server bootstrap concern, not a route concern.

**File:** `apps/server/src/routes/sessions.ts`

Replace `req.app.locals.sessionBroadcaster.registerClient(...)` with `runtime.watchSession(...)`. The SSE stream route (GET `/api/sessions/:id/stream`) currently calls:

```typescript
const sessionBroadcaster = req.app.locals.sessionBroadcaster as SessionBroadcaster;
sessionBroadcaster.registerClient(internalSessionId, cwd, res, clientId);
```

This needs to become:

```typescript
const runtime = runtimeRegistry.getDefault();
// For SSE streaming, we still need the Express Response for HTTP SSE protocol
// watchSession() returns a callback-based unsubscribe, which doesn't serve SSE directly
```

**Design tension:** The SSE stream route needs to pipe events directly to an Express `Response` object, not through a callback. Two approaches:

1. **Keep `registerClient()` accessible** through a method on the runtime (e.g., `runtime.registerSseClient(sessionId, projectDir, res, clientId)`) — this makes the runtime responsible for SSE wiring.
2. **Use `watchSession()` + manual SSE** — the route calls `watchSession()` with a callback that writes SSE events to `res`.

**Decision: Approach 2.** The route calls `watchSession()` and the callback writes to the SSE response. This keeps the runtime interface clean. The callback received by `watchSession()` can write SSE events:

```typescript
const runtime = runtimeRegistry.getDefault();
const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

initSSEStream(res);
sendSSEEvent(res, { type: 'sync_connected', data: { sessionId } });

const unsubscribe = runtime.watchSession(
  internalSessionId,
  cwd,
  (event) => sendSSEEvent(res, event),
  clientId
);

res.on('close', () => unsubscribe());
```

Remove `SessionBroadcaster` import from `sessions.ts`.

### Phase 3: Import Cleanup (Group B — Issues #1, #4, #9, #12)

#### 3.1 Update Obsidian Plugin Imports (Issue #1)

**File:** `apps/obsidian-plugin/src/views/CopilotView.tsx`

First, verify that `apps/server/package.json` already has the canonical export:

```json
"./services/runtimes/claude-code": "./src/services/runtimes/claude-code/index.ts"
```

This exists. But we need to verify what's exported from the barrel. Check/update `apps/server/src/services/runtimes/claude-code/index.ts` to export `ClaudeCodeRuntime`, `TranscriptReader`, and `CommandRegistryService`.

**Update imports:**

```typescript
// Before
import { ClaudeCodeRuntime } from '@dorkos/server/services/agent-manager';
import { TranscriptReader } from '@dorkos/server/services/transcript-reader';
import { CommandRegistryService } from '@dorkos/server/services/command-registry';

// After
import {
  ClaudeCodeRuntime,
  TranscriptReader,
  CommandRegistryService,
} from '@dorkos/server/services/runtimes/claude-code';
```

**File:** `apps/server/package.json`

Remove old export shims:

```json
// REMOVE these three lines
"./services/agent-manager": "./src/services/runtimes/claude-code/claude-code-runtime.ts",
"./services/transcript-reader": "./src/services/runtimes/claude-code/transcript-reader.ts",
"./services/command-registry": "./src/services/runtimes/claude-code/command-registry.ts",
```

Keep only:

```json
"exports": {
  "./services/runtimes/claude-code": "./src/services/runtimes/claude-code/index.ts"
}
```

#### 3.2 Clean Up `core/index.ts` Barrel (Issue #4)

**File:** `apps/server/src/services/core/index.ts`

Remove all Claude Code-specific re-exports. The barrel should only export core infrastructure:

**Remove:**

- `ClaudeCodeRuntime as AgentManager` alias
- `AgentSession`, `ToolState`, `createToolState` re-exports
- `buildSystemPromptAppend` re-export
- `mapSdkMessage` re-export
- `CommandRegistryService` re-export
- MCP tool server re-exports
- Interactive handler re-exports

**Keep:**

- `RuntimeRegistry` / `runtimeRegistry` exports
- `StreamAdapter` / SSE helper exports
- `ConfigManager` exports
- `FileLister` exports
- `GitStatus` exports
- `OpenApiRegistry` exports
- `UpdateChecker` exports
- Any other core infrastructure exports

After cleanup, grep the codebase for any imports from `services/core` that reference the removed exports. Update those imports to use canonical claude-code paths.

#### 3.3 Rename `AgentManagerLike` in Relay Package (Issue #9)

**File:** `packages/relay/src/adapters/claude-code-adapter.ts`

```typescript
// Before (line 114)
export interface AgentManagerLike {

// After
export interface AgentRuntimeLike {
```

Update all internal references within the file.

**File:** `packages/relay/src/index.ts`

```typescript
// Before
export type {
  AgentManagerLike as ClaudeCodeAgentManagerLike,

// After
export type {
  AgentRuntimeLike as ClaudeCodeAgentRuntimeLike,
```

**Also add a deprecated re-export for safety:**

```typescript
/** @deprecated Use ClaudeCodeAgentRuntimeLike instead */
export type { AgentRuntimeLike as ClaudeCodeAgentManagerLike } from './adapters/claude-code-adapter.js';
```

Wait — per user decision, we're doing immediate removal, not deprecation. So just update the export name and grep for all consumers of `ClaudeCodeAgentManagerLike` to update them.

**File:** `apps/server/src/services/relay/adapter-manager.ts` (and any other consumers)

Update imports from `AgentManagerLike` / `ClaudeCodeAgentManagerLike` to `AgentRuntimeLike` / `ClaudeCodeAgentRuntimeLike`.

#### 3.4 Rename and Relocate Test Files (Issue #12)

Move 4 test files from `apps/server/src/services/core/__tests__/` to `apps/server/src/services/runtimes/claude-code/__tests__/`:

| Old Path                                           | New Path                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `core/__tests__/agent-manager.test.ts`             | `runtimes/claude-code/__tests__/claude-code-runtime.test.ts`             |
| `core/__tests__/agent-manager-locking.test.ts`     | `runtimes/claude-code/__tests__/claude-code-runtime-locking.test.ts`     |
| `core/__tests__/agent-manager-models.test.ts`      | `runtimes/claude-code/__tests__/claude-code-runtime-models.test.ts`      |
| `core/__tests__/agent-manager-interactive.test.ts` | `runtimes/claude-code/__tests__/claude-code-runtime-interactive.test.ts` |

Inside each file:

- Update `describe` block names from `AgentManager` to `ClaudeCodeRuntime`
- Update import paths if they reference `../../core/` (adjust to relative paths from new location)
- Verify mock paths are correct for the new location

**Do not rewrite test logic** — only rename/relocate and fix imports.

### Phase 4: File Size Reduction (Group D — Issue #11)

#### 4.1 Extract `sendMessage()` into `message-sender.ts`

**File:** `apps/server/src/services/runtimes/claude-code/message-sender.ts` (new)

Extract the `sendMessage()` body (lines 271-494, ~224 lines) into an async generator function:

```typescript
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AgentSession } from './agent-types.js';
// ... other imports

/**
 * Execute an SDK query and yield StreamEvent objects.
 * Extracted from ClaudeCodeRuntime.sendMessage() for file size management.
 */
export async function* executeSdkQuery(
  sessionId: string,
  content: string,
  session: AgentSession,
  opts: MessageSenderOpts
): AsyncGenerator<StreamEvent> {
  // ... body from sendMessage() lines ~285-493
}

/** Options bundle for executeSdkQuery, avoiding a long parameter list. */
export interface MessageSenderOpts {
  cwd: string;
  claudeCliPath: string;
  meshCore?: AgentRegistryPort;
  transcriptReader: TranscriptReader;
  mcpServerFactory?: McpServerFactory;
  permissionMode?: string;
  model?: string;
  // ... other fields needed from the runtime
}
```

**File:** `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`

`sendMessage()` becomes a thin wrapper:

```typescript
async *sendMessage(
  sessionId: string,
  content: string,
  opts?: MessageOpts
): AsyncGenerator<StreamEvent> {
  const session = this.ensureSessionExists(sessionId);
  // ... pre-flight (3-4 lines: update lastActivity, clear eventQueue)

  yield* executeSdkQuery(sessionId, content, session, {
    cwd: opts?.cwd ?? this.cwd,
    claudeCliPath: this.claudeCliPath,
    meshCore: this.meshCore,
    transcriptReader: this.transcriptReader,
    mcpServerFactory: this.mcpServerFactory,
    permissionMode: opts?.permissionMode,
    model: opts?.model,
  });
}
```

**Target:** `claude-code-runtime.ts` drops from ~687 lines to ~470 lines (well under 500).

---

## Testing Strategy

### Existing Tests (Rename Only)

The 4 test files (2,180 lines total) are relocated and renamed but **not rewritten**. Verify all tests pass after relocation:

```bash
pnpm vitest run apps/server/src/services/runtimes/claude-code/__tests__/
```

### New Tests

#### `watchSession()` Integration

Add tests to `claude-code-runtime.test.ts`:

- `watchSession()` returns an unsubscribe function
- Calling the unsubscribe function stops callback invocation
- Callback receives `StreamEvent` objects when session changes

Add tests to a new `session-broadcaster-callback.test.ts`:

- `registerCallback()` stores the callback
- `broadcastUpdate()` invokes registered callbacks
- Unsubscribe removes the callback
- File watcher lifecycle (start on first listener, stop on last unsubscribe)

#### `SseResponse` Narrowing

Add a type-level test (or compile-time assertion) that Express `Response` satisfies `SseResponse`:

```typescript
import type { Response } from 'express';
import type { SseResponse } from '@dorkos/shared/agent-runtime';

// Type assertion — fails at compile time if incompatible
const _: SseResponse = {} as Response;
```

#### Port Interface Structural Typing

Similar type-level assertions that `MeshCore` satisfies `AgentRegistryPort` and `RelayCore` satisfies `RelayPort`:

```typescript
import type { MeshCore } from '@dorkos/mesh';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';

const _: AgentRegistryPort = {} as MeshCore;
```

#### Route Migration Tests

Existing route tests should continue passing. No new route tests needed — the behavior is unchanged.

### Test Commands

```bash
pnpm test -- --run                    # All tests
pnpm vitest run apps/server/          # Server tests only
pnpm typecheck                        # Type checking across all packages
pnpm lint                             # Lint across all packages
```

## Performance Considerations

- **Cache consolidation:** Removing the duplicate `TranscriptReader` singleton means relay.ts now shares the runtime's metadata cache instead of maintaining a separate one. This is a minor memory improvement.
- **No behavioral changes:** All data flows remain identical; only the access path changes (direct import → registry → runtime method).
- **`watchSession()` overhead:** Adding `registerCallback()` is minimal — it's a Map insertion. The file watcher already exists for SSE clients.

## Security Considerations

- No new attack surfaces. The changes are internal refactoring.
- Directory boundary enforcement is unchanged — routes still validate `cwd` parameters.

## Documentation

After implementation, update `AGENTS.md`:

- Remove references to `app.locals.sessionBroadcaster`
- Update the `core/index.ts` barrel description
- Update test file locations
- Document `AgentRegistryPort` and `RelayPort` interfaces
- Note that `watchSession()` is functional

## Implementation Phases

### Phase 1: Interface Refinement (Group C)

1. Narrow `SseResponse` to `on(event: 'close', ...)`
2. Update `SessionLockManager` to accept `SseResponse`
3. Remove `as Response` cast in `ClaudeCodeRuntime`
4. Define `AgentRegistryPort` and `RelayPort` in shared
5. Update `setMeshCore()` / `setRelay()` signatures
6. Add `registerCallback()` to `SessionBroadcaster`
7. Implement `watchSession()` in `ClaudeCodeRuntime`

### Phase 2: Route Migration (Group A)

1. Add `cwd` parameter to `AgentRuntime.getCommands()`
2. Migrate `commands.ts` to use `runtimeRegistry.getDefault().getCommands()`
3. Migrate `relay.ts` to use `runtimeRegistry.getDefault().getSession()`
4. Remove `transcriptReader` singleton export
5. Migrate `sessions.ts` SSE stream to use `runtime.watchSession()`
6. Remove `sessionBroadcaster` from `app.locals`

### Phase 3: Import Cleanup (Group B)

1. Update Obsidian plugin imports to canonical paths
2. Remove old `package.json` export shims
3. Clean up `core/index.ts` barrel
4. Rename `AgentManagerLike` → `AgentRuntimeLike` in relay
5. Rename and relocate 4 test files

### Phase 4: File Size Reduction (Group D)

1. Extract `executeSdkQuery()` into `message-sender.ts`
2. Update `sendMessage()` to delegate
3. Verify file is under 500 lines

### Phase 5: Verification

1. Run `pnpm test -- --run` (all 1168+ tests pass)
2. Run `pnpm typecheck` (all packages clean)
3. Run `pnpm lint` (no new errors)
4. Verify Obsidian plugin builds: `turbo build --filter=@dorkos/obsidian-plugin`

## Acceptance Criteria

- [ ] All 12 issues from the code review are addressed
- [ ] No routes directly import Claude Code-specific services (all go through `runtimeRegistry`)
- [ ] No `unknown` types in `AgentRuntime` DI methods
- [ ] No `as Response` casts in the runtime
- [ ] `watchSession()` is functional, not a stub
- [ ] `core/index.ts` barrel only exports core infrastructure
- [ ] Test files are in `services/runtimes/claude-code/__tests__/` with correct names
- [ ] `claude-code-runtime.ts` is under 500 lines
- [ ] All 1168+ server tests pass
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] Obsidian plugin builds successfully

## Related ADRs

- **ADR-0085** (`decisions/0085-agent-runtime-interface-as-universal-abstraction.md`) — Defines the `AgentRuntime` interface design
- **ADR-0086** (`decisions/0086-multi-runtime-registry-keyed-by-type.md`) — Establishes the `RuntimeRegistry` pattern
- **ADR-0087** (`decisions/0087-runtime-owns-session-storage.md`) — Runtime owns session data (transcript reader, broadcaster)

## References

- Code review findings: `.temp/agent-runtime-abstraction-review-findings.md`
- Original spec: `specs/agent-runtime-abstraction/02-specification.md`
- Research: `research/20260306_agent_runtime_interface_design_patterns.md`
- Ideation: `specs/agent-runtime-review-remediation/01-ideation.md`
