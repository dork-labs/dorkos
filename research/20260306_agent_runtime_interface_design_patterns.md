---
title: "AgentRuntime Interface Design Patterns: SseResponse, watchSession, Cross-Package DI, Shim Removal"
date: 2026-03-06
type: internal-architecture
status: active
tags: [agent-runtime, interface-design, hexagonal-architecture, dependency-injection, sse, observer-pattern, typescript, monorepo]
feature_slug: agent-runtime-review-remediation
searches_performed: 12
sources_count: 22
---

# AgentRuntime Interface Design Patterns

## Research Summary

This report addresses four interface design questions arising from a code review of the
`AgentRuntime` abstraction in DorkOS. It covers: (1) how to define a narrow, framework-agnostic
`SseResponse` interface that eliminates the `as Response` cast in `SessionLockManager`; (2) whether
`watchSession()` belongs on the interface or should be removed in favour of `getSessionBroadcaster()`;
(3) how to inject `MeshCore` and `RelayCore` without using `unknown`; and (4) how to safely remove
backward-compatibility re-export shims. All recommendations are grounded in the existing DorkOS
codebase and TypeScript structural typing.

---

## Key Findings

### 1. SseResponse Interface — Expand to Capture What `SessionLockManager` Actually Needs

The current `SseResponse` interface is:

```typescript
export interface SseResponse {
  on(event: string, cb: () => void): void;
}
```

`SessionLockManager.acquireLock()` accepts `Response` from Express, then `ClaudeCodeRuntime`
bridges the gap with `res as Response`. This cast is the red flag: the interface is too narrow for
what the lock manager actually does — it calls `res.on('close', ...)`.

The fix is to make the interface match what is actually used: exactly `on(event: 'close', cb: () => void): void`.
A narrower, more specific overload eliminates the cast entirely.

**Pattern origin**: Hexagonal architecture "secondary port" principle — define the interface from the
application's perspective, not the framework's. The port expresses what the application needs
(`on('close', ...)`) not what Express provides (full `Response`).

### 2. watchSession() — Keep but Implement It

`watchSession()` is a stub that says "routes use `getSessionBroadcaster()` instead." This is an
architectural leak: the interface promises something it doesn't deliver, and routes bypass it. The
correct fix is one of two paths:

- **Keep `watchSession()` and make it real**: implement it in `ClaudeCodeRuntime` by delegating to
  `broadcaster.registerClient()`. Remove `getSessionBroadcaster()` from the public API entirely.
  Routes call `runtime.watchSession()`.
- **Remove `watchSession()` from the interface**: move it to a `ClaudeCodeRuntime`-only optional
  method and use the `getSessionBroadcaster()` pattern exclusively.

VS Code's API precedent strongly favours the first path: watcher/observer contracts belong on the
interface, return a cleanup function (`() => void`), and implementations manage the subscription
lifecycle internally. The stub is the anti-pattern; a real implementation is the fix.

### 3. Cross-Package DI — "Narrow Port" Pattern in `@dorkos/shared`

`setMeshCore?(meshCore: unknown)` and `setRelay?(relay: unknown)` use `unknown` to avoid circular
imports. The correct pattern is to define narrow "port" interfaces in `@dorkos/shared` that capture
only what `ClaudeCodeRuntime` actually calls — no full `MeshCore` or `RelayCore` needed.

TypeScript's structural typing makes this zero-cost: the concrete `MeshCore` class from
`@dorkos/mesh` satisfies the port interface automatically without any explicit `implements` clause.

### 4. Shim Removal — `@deprecated` Tag + `no-deprecated` ESLint Rule + Grep + Delete

The standard pattern for monorepo shim removal is a three-phase process: (1) add `@deprecated`
JSDoc to the re-export, (2) run `typescript-eslint`'s `no-deprecated` rule to surface all consumers
in CI, (3) migrate consumers and delete the shim in the same PR. Phase 2 catches things grep misses
(aliased imports, barrel re-exports).

---

## Detailed Analysis

### Topic 1: SseResponse Interface Design

#### The Problem

`SessionLockManager.acquireLock()` accepts `res: Response` from Express and calls `res.on('close', ...)`.
`ClaudeCodeRuntime.acquireLock()` bridges the gap:

```typescript
// Current — unsafe cast
acquireLock(sessionId: string, clientId: string, res: SseResponse): boolean {
  return this.lockManager.acquireLock(sessionId, clientId, res as Response);
}
```

The cast exists because `SseResponse` only declares `on(event: string, cb: () => void): void` but
`SessionLockManager` expects `Response`. Neither type is wrong — the gap is that the shared
interface is too loose to be passed through without a cast.

#### Solution: Expand SseResponse to Match What's Actually Used

The application only calls `res.on('close', callback)` on the response object when acquiring a lock.
That is the complete set of operations. Define the interface to capture exactly that:

```typescript
// packages/shared/src/agent-runtime.ts

/**
 * Minimal SSE connection interface required for session lock lifecycle.
 *
 * Captures only what the lock manager needs: close-event subscription.
 * Compatible with Express Response, Node.js IncomingMessage, and any
 * framework whose response object emits a 'close' event.
 */
export interface SseResponse {
  /** Subscribe to connection close events for lock release. */
  on(event: 'close', cb: () => void): void;
}
```

Changing the signature from `on(event: string, ...)` to `on(event: 'close', ...)` is a breaking
narrowing. Express's `Response` satisfies this because `Response extends EventEmitter` and
`EventEmitter.on(event: string | symbol, ...)` satisfies a narrower overload via structural typing.

Then update `SessionLockManager` to accept `SseResponse` instead of `Response`:

```typescript
// session-lock.ts — remove the Express import entirely
import type { SseResponse } from '@dorkos/shared/agent-runtime';

export class SessionLockManager {
  acquireLock(sessionId: string, clientId: string, res: SseResponse): boolean {
    // ...
    res.on('close', () => {
      const current = this.locks.get(sessionId);
      if (current === lock) this.locks.delete(sessionId);
    });
    return true;
  }
}
```

And the cast in `ClaudeCodeRuntime` becomes unnecessary:

```typescript
// claude-code-runtime.ts — no more cast
acquireLock(sessionId: string, clientId: string, res: SseResponse): boolean {
  return this.lockManager.acquireLock(sessionId, clientId, res);
}
```

Routes pass `res` (Express `Response`) directly to `runtime.acquireLock(sessionId, clientId, res)`.
This works because Express's `Response` structurally satisfies `SseResponse`'s `on('close', ...)` call.

#### Why This Works

TypeScript's structural typing guarantees compatibility without explicit `implements`. The minimal
port interface (hexagonal architecture "secondary port") defines only what the application
needs — nothing more. This is the pattern used throughout hexagonal architectures for avoiding
framework coupling in shared modules.

#### Approaches Considered

| Approach | Pros | Cons |
|---|---|---|
| **Expand `SseResponse` to `on(event: 'close', cb: () => void): void`** (recommended) | Eliminates cast, expresses intent, framework-agnostic | Slightly breaking change for any mocks that pass `on(event: string, ...)` |
| Keep `SseResponse = { on(event: string, ...) }` and update `SessionLockManager` to accept it | No interface change | Still too broad — doesn't express the domain requirement |
| Move `SessionLockManager` to accept `Express.Response` directly | Simple | Couples `session-lock.ts` to Express — defeats the purpose of the interface |
| Use a union type `SseResponse = Pick<Response, 'on'>` | Concise | Still brings Express into `@dorkos/shared` |

**Recommendation**: Narrow `SseResponse` to `on(event: 'close', cb: () => void): void` and update
`SessionLockManager` to accept `SseResponse`. Eliminates the cast and makes the interface's purpose
immediately obvious.

---

### Topic 2: watchSession() — Keep or Remove?

#### The Current State

```typescript
// In ClaudeCodeRuntime — stub that does nothing
watchSession(
  _sessionId: string,
  _projectDir: string,
  _callback: (event: StreamEvent) => void,
  _clientId?: string
): () => void {
  // Routes access the internal broadcaster via getSessionBroadcaster().
  // This is a no-op stub satisfying the AgentRuntime interface contract.
  return () => {};
}
```

Routes call `sessionBroadcaster.registerClient()` directly via `app.locals.sessionBroadcaster`.
The interface method is a lie.

#### The VS Code Precedent

VS Code's API is the canonical TypeScript model for multi-backend runtime abstractions. Its pattern
for change notification is:

1. Events are defined on the type they belong to when the type is "private" (constructed by the caller)
2. Return a `Disposable` (or unsubscribe function) from subscription calls
3. Never expose the underlying implementation (`FileSystemWatcher` internals are not public)

The `FileSystemWatcher` pattern:
```typescript
// vscode API — never exposes internal chokidar watcher
interface FileSystemWatcher extends Disposable {
  onDidChange: Event<Uri>;
  onDidCreate: Event<Uri>;
  onDidDelete: Event<Uri>;
}
// Usage
const watcher = workspace.createFileSystemWatcher('**/*.ts');
const subscription = watcher.onDidChange(uri => handleChange(uri));
// Later:
subscription.dispose(); // unsubscribe
```

The DorkOS equivalent should look like:
```typescript
// On AgentRuntime interface
watchSession(
  sessionId: string,
  projectDir: string,
  callback: (event: StreamEvent) => void,
  clientId?: string
): () => void; // unsubscribe function
```

And the implementation should actually work:

```typescript
// ClaudeCodeRuntime — real implementation
watchSession(
  sessionId: string,
  projectDir: string,
  callback: (event: StreamEvent) => void,
  clientId?: string
): () => void {
  // Delegate to the internal broadcaster
  this.broadcaster.registerClient(sessionId, projectDir, { write: callback, on: () => {} }, clientId);
  return () => {
    this.broadcaster.deregisterClient(sessionId, clientId);
  };
}
```

But wait — the current `broadcaster.registerClient()` takes `res: Response` (an Express-specific
object) and calls `res.write()` and `res.on('close', ...)`. If `watchSession()` is to be
framework-agnostic, it needs a callback-based delegation path into the broadcaster.

#### Two Viable Paths

**Path A: Implement `watchSession()` via callback delegation** (recommended for correctness)

Add a callback-based registration path to `SessionBroadcaster`:

```typescript
// In SessionBroadcaster
registerCallback(
  sessionId: string,
  projectDir: string,
  callback: (event: StreamEvent) => void,
  clientId?: string
): () => void {
  // Internal subscription logic, returns unsubscribe
  const listener = { callback, clientId };
  this.callbackClients.get(sessionId)?.push(listener);
  return () => { /* remove listener */ };
}
```

Then `watchSession()` delegates to `registerCallback()`, while the SSE route continues to use
`registerClient()` (which takes `res: Response` directly for the full SSE protocol).

This makes both paths real: `watchSession()` for programmatic consumers, `registerClient()` for
HTTP SSE routes. The interface contract is honest.

**Path B: Remove `watchSession()` from the interface**

If no route or service actually calls `runtime.watchSession()` (which is the current state), the
method should be removed from `AgentRuntime` and `getSessionBroadcaster()` promoted to an optional
runtime-specific method. Routes would access it via casting:

```typescript
if ('getSessionBroadcaster' in runtime) {
  (runtime as ClaudeCodeRuntime).getSessionBroadcaster().registerClient(...);
}
```

This is honest (the interface doesn't promise what it can't deliver) but sacrifices the abstraction
for a runtime-specific escape hatch.

#### Recommendation

**Path A is correct**. A stub that satisfies an interface with a no-op is always wrong — it
signals that the interface design is being driven by something external (the linter/compiler) rather
than domain intent. If the interface declares `watchSession()`, it must work.

The implementation cost is low: add a `registerCallback()` method to `SessionBroadcaster` that uses
the same subscription tracking without requiring an Express `Response`. The SSE route continues to
use `registerClient()` for the full HTTP SSE protocol.

---

### Topic 3: Cross-Package DI Without `unknown`

#### The Problem

```typescript
// Current — `unknown` sacrifices type safety
setMeshCore?(meshCore: unknown): void;
setRelay?(relay: unknown): void;
```

The `unknown` type was used to avoid importing `MeshCore` from `@dorkos/mesh` and `RelayCore` from
`@dorkos/relay` into `@dorkos/shared`, which would create circular package dependencies
(`shared` → `mesh` → `shared`).

#### The Correct Pattern: Narrow Port Interfaces in `@dorkos/shared`

Define minimal "port" interfaces in `@dorkos/shared` that describe exactly what `ClaudeCodeRuntime`
calls on `MeshCore` and `RelayCore`. The concrete classes from `@dorkos/mesh` and `@dorkos/relay`
satisfy these ports via TypeScript's structural typing — no explicit `implements` needed.

**Step 1: Identify what `ClaudeCodeRuntime` actually calls**

From `context-builder.ts` and MCP tools, `ClaudeCodeRuntime` calls on MeshCore:
- `meshCore.getRegisteredAgents()` — get peer agents
- `meshCore.getAgent(agentId)` — resolve agent manifest

From relay integration, `ClaudeCodeRuntime` calls on RelayCore:
- `relayCore.publish(subject, payload)` — publish messages
- `relayCore.subscribe(subject, handler)` — subscribe to subjects

**Step 2: Define narrow ports in `@dorkos/shared`**

```typescript
// packages/shared/src/agent-runtime.ts

/**
 * Minimal agent registry port — what ClaudeCodeRuntime needs from MeshCore.
 * The concrete MeshCore from @dorkos/mesh satisfies this structurally.
 */
export interface AgentRegistryPort {
  getRegisteredAgents(): Array<{ id: string; projectPath: string; name?: string }>;
  getAgent(agentId: string): { id: string; projectPath: string; runtime?: string } | null;
}

/**
 * Minimal relay port — what ClaudeCodeRuntime needs from RelayCore.
 * The concrete RelayCore from @dorkos/relay satisfies this structurally.
 */
export interface RelayPort {
  publish(subject: string, payload: unknown): Promise<void>;
  subscribe(subject: string, handler: (msg: unknown) => void): () => void;
}
```

**Step 3: Update `AgentRuntime` interface**

```typescript
export interface AgentRuntime {
  // ...

  // --- Dependency injection (optional) ---

  /** Inject agent registry for peer-agent context. */
  setMeshCore?(meshCore: AgentRegistryPort): void;

  /** Inject relay bus for Relay-aware context and messaging. */
  setRelay?(relay: RelayPort): void;
}
```

**Step 4: Update `ClaudeCodeRuntime`**

```typescript
// claude-code-runtime.ts
import type { AgentRegistryPort, RelayPort } from '@dorkos/shared/agent-runtime';

export class ClaudeCodeRuntime implements AgentRuntime {
  private meshCore?: AgentRegistryPort;
  private relay?: RelayPort;

  setMeshCore(meshCore: AgentRegistryPort): void {
    this.meshCore = meshCore;
    // Pass to context builder
    this.contextBuilder.setMeshCore(meshCore);
  }

  setRelay(relay: RelayPort): void {
    this.relay = relay;
    // Pass to broadcaster and MCP tools
    this.broadcaster.setRelay(relay);
  }
}
```

The server startup code passes the concrete `MeshCore` and `RelayCore` instances — TypeScript verifies
compatibility structurally without any explicit casts:

```typescript
// index.ts — no cast needed, structural compatibility is checked
claudeRuntime.setMeshCore(meshCore); // MeshCore satisfies AgentRegistryPort structurally
claudeRuntime.setRelay(relayCore);   // RelayCore satisfies RelayPort structurally
```

If `MeshCore` adds or changes methods, the port interface is unaffected. If `ClaudeCodeRuntime`
needs more methods from `MeshCore`, those are added to `AgentRegistryPort`. The port is the
dependency contract, defined by the consumer.

#### Dependency Direction

```
@dorkos/shared defines:  AgentRegistryPort, RelayPort
@dorkos/mesh provides:   MeshCore implements AgentRegistryPort (structurally)
@dorkos/relay provides:  RelayCore implements RelayPort (structurally)
apps/server wires:       claudeRuntime.setMeshCore(meshCore)
```

No circular import. `@dorkos/shared` does not import from `@dorkos/mesh` or `@dorkos/relay`.

#### Approaches Considered

| Approach | Pros | Cons |
|---|---|---|
| **Narrow port interfaces in `@dorkos/shared`** (recommended) | Type-safe, no circular deps, structural compatibility is automatic | Requires identifying exact API surface; ports must be maintained |
| `unknown` with runtime type guards in implementations | No interface changes needed | Zero type safety, casts required internally, no IDE support |
| Generic type parameters `setMeshCore?<T>(meshCore: T): void` | Avoids naming the type | Provides no safety guarantee — caller can pass anything |
| Move `AgentRuntime` to `apps/server` and import MeshCore directly | Full type safety, simple | Breaks the shared abstraction — client can't use `AgentRuntime` type |
| `interface` with `import type` from the concrete package | Full API surface, type-safe | Creates `@dorkos/shared → @dorkos/mesh` dependency (circular) |

**Recommendation**: Define narrow port interfaces in `@dorkos/shared`. The total API surface that
`ClaudeCodeRuntime` needs from `MeshCore` is small (2-4 methods). Defining a port interface for
that surface is minimal work and eliminates `unknown` entirely.

---

### Topic 4: Backward-Compatibility Shim Removal

#### The Standard Pattern

Shim removal in a monorepo follows a three-phase approach. All phases can be done in sequence
within a single sprint since DorkOS is an internal monorepo (no external npm consumers).

**Phase 1: Mark deprecated**

Add `@deprecated` JSDoc to the re-export shim:

```typescript
// services/core/agent-manager.ts (the re-export shim)

/**
 * @deprecated Import from `services/runtimes/claude-code/claude-code-runtime` instead.
 *   This re-export will be removed in the next sprint.
 */
export { ClaudeCodeRuntime as AgentManager } from '../runtimes/claude-code/claude-code-runtime.js';
```

VSCode immediately shows strikethrough on all usages. The `@deprecated` tag is recognized by
TypeScript's language server.

**Phase 2: Surface all consumers**

Use two complementary tools:

```bash
# Grep — fast, catches literal import paths
grep -r "services/core/agent-manager" apps/ packages/ --include="*.ts" -l

# ESLint no-deprecated — catches aliased imports and barrel re-exports
pnpm lint --rule "@typescript-eslint/no-deprecated: error" -- apps/ packages/
```

The `@typescript-eslint/no-deprecated` rule requires type information (it uses the TypeScript
compiler API), so it catches cases where the import path is different but the deprecated symbol
is still used. This is complementary to grep.

**Phase 3: Migrate consumers and delete**

Update each consumer file to import from the new canonical path. Then delete the shim file and
run `pnpm typecheck` + `pnpm lint` to verify no remaining references.

```bash
# Final verification before deletion
grep -r "agent-manager" apps/ packages/ --include="*.ts"
# Should return zero results
```

#### For Internal Monorepos (No External Consumers)

Since all consumers of `agent-manager.ts` are in the same repo, a shorter path is acceptable:

1. **Batch migration**: Use `sed` or the IDE's "find and replace across files" to update all import
   paths in one pass
2. **Delete immediately**: Delete the shim in the same PR as the migration
3. **Verify with typecheck**: `pnpm typecheck` catches any missed reference

The `@deprecated` tag + waiting period is primarily for published npm packages. For internal
monorepos, the batch migration approach is faster and cleaner.

#### ESLint `no-restricted-imports` as a Guardrail

After migration, add a lint rule to prevent re-use of the old path:

```javascript
// eslint.config.js
{
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['*/services/core/agent-manager'],
        message: 'Deprecated. Import from services/runtimes/claude-code/claude-code-runtime instead.',
      }],
    }],
  }
}
```

This is especially useful during a multi-PR migration — it stops new code from importing the old
path while the migration is in progress.

---

## Sources & Evidence

- `packages/shared/src/agent-runtime.ts` — Current `SseResponse` interface definition (line 23-25)
- `apps/server/src/services/runtimes/claude-code/session-lock.ts` — `acquireLock(sessionId, clientId, res: Response)` uses Express type directly (line 23)
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — `res as Response` cast (line 590), stub `watchSession()` (lines 572-581), `getSessionBroadcaster()` (lines 188-191)
- VS Code Extension API guidelines: events defined on private types, Disposable return pattern — [Extension API guidelines](https://github.com/microsoft/vscode-wiki/blob/main/Extension-API-guidelines.md)
- TypedEvent/Disposable pattern: typed events with `dispose()` unsubscribe — [TypeScript Deep Dive: Typed Event](https://basarat.gitbook.io/typescript/main-1/typed-event)
- Hexagonal architecture secondary ports principle: "ports express what the application needs, not what the framework provides" — [Ports and Adapters with TypeScript](https://betterprogramming.pub/how-to-ports-and-adapter-with-typescript-32a50a0fc9eb)
- `typescript-eslint/no-deprecated` rule: surfaces `@deprecated` JSDoc violations with type information — [no-deprecated rule](https://typescript-eslint.io/rules/no-deprecated/)
- Circular dependency resolution via interfaces: define interface in shared module, both packages implement without importing each other — [Fixing Circular Dependencies in TypeScript](https://medium.com/visual-development/how-to-fix-nasty-circular-dependency-issues-once-and-for-all-in-javascript-typescript-a04c987cf0de)
- Proper deprecation in TypeScript: `@deprecated` tag + ESLint + `console.warn` — [How to properly deprecate](https://dev.to/dgreene1/how-to-properly-deprecate-3027)
- better-sse framework-agnostic design: accepts both Node.js HTTP module and Fetch API responses — [better-sse GitHub](https://github.com/MatthewWid/better-sse)

---

## Research Gaps & Limitations

- The `SessionBroadcaster.registerClient()` signature was not inspected in detail. Path A for
  `watchSession()` requires adding a callback-based registration path; the exact API depends on
  `SessionBroadcaster`'s current internal structure.
- The exact set of methods `ClaudeCodeRuntime` calls on `MeshCore` and `RelayCore` was inferred
  from `CLAUDE.md` descriptions. The port interface definitions should be verified against the
  actual `context-builder.ts` and MCP tool implementations before committing.

---

## Contradictions & Disputes

- **`watchSession()`: stub vs real** — One perspective is that a no-op stub is acceptable "until a
  second runtime is added." The counter-argument (recommended here) is that a stub that returns
  `() => {}` while routes bypass it via `getSessionBroadcaster()` is an architectural lie that
  compounds over time. The spec's own Phase 4 cleanup goal ("zero behavioral changes, all contracts
  honest") supports the real implementation.

- **Port width for `AgentRegistryPort`** — Narrow ports are easier to maintain but may become
  obstacles if `ClaudeCodeRuntime` needs more `MeshCore` methods in the future (requiring port
  updates). Wide ports are more stable but approach the anti-pattern of importing the full concrete
  type. Current scope (2-4 methods) makes narrow ports clearly correct.

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: "hexagonal architecture secondary port narrow interface TypeScript",
  "VS Code Disposable onDidChange watcher abstraction", "TypeScript no-deprecated eslint shim
  removal monorepo", "SseResponse minimal interface on close framework-agnostic"
- Primary information sources: github.com/microsoft/vscode-wiki, typescript-eslint.io,
  basarat.gitbook.io, dev.to deprecation guides, DorkOS codebase direct inspection
