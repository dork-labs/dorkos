---
slug: fix-relay-agent-routing-cwd
number: 90
created: 2026-03-04
status: ideation
---

# Fix Relay Agent-to-Agent Routing CWD Bug

**Slug:** fix-relay-agent-routing-cwd
**Author:** Claude Code
**Date:** 2026-03-04
**Branch:** preflight/fix-relay-agent-routing-cwd

---

## 1) Intent & Assumptions

- **Task brief:** When agent A sends a relay message to `relay.agent.{agentId}`, the wrong Claude session
  responds — a blank session at the server's default CWD (repo root) rather than the target agent's
  project. Three implementation bugs in the `adapterContextBuilder` pipeline silently prevent the target
  agent's `projectPath` from being resolved and injected as the session's CWD. The result is that
  agent-to-agent communication via Relay is fundamentally broken at a routing level.
- **Assumptions:**
  - The conceptual architecture is correct: Mesh agent IDs are the right key for relay subjects, and the
    `adapterContextBuilder` pattern is the right abstraction for CWD injection.
  - The BindingRouter path (human→agent via `relay.human.*`) is unaffected and continues to work.
  - The SDK explicitly disallows concurrent `query()` calls on the same session (causes
    `"Already connected to a transport"` errors), so concurrent agent messages need either serialization
    or session isolation.
  - Bug fixes must not break the existing CLI-originated session path or the BindingRouter path.
- **Out of scope:**
  - Changing the relay subject schema (`relay.agent.{agentId}` stays as-is).
  - Altering the Mesh registration/discovery flow.
  - The `relay_inbox` payload gap and `publishAgentResult` trace recording bugs (tracked separately in
    the fluttering-mixing-rose plan).
  - Per-sender session isolation (deferred — see Decision 3 below).

---

## 2) Pre-reading Log

- `apps/server/src/index.ts`: Server startup wiring. Revealed that `adapterManager` is constructed at
  line ~116 **before** `meshCore` is initialized (lines ~142–169). `meshCore` is never passed to
  `AdapterManagerDeps`.
- `apps/server/src/services/relay/adapter-manager.ts`: Houses `AdapterManagerDeps` (with a `meshCore?`
  field typed with wrong method name `getAgent`), `buildContext()` (uses wrong field
  `manifest.directory`), and the overall adapter lifecycle.
- `packages/mesh/src/mesh-core.ts`: `MeshCore.get(agentId)` returns `AgentManifest | undefined`.
  The `AgentRegistryEntry` type (internal) extends `AgentManifest` and adds `projectPath: string`, but
  this is not exposed via any public API. No `getProjectPath()` method exists.
- `packages/relay/src/adapter-delivery.ts`: `deliver()` calls `contextBuilder?.(subject)` and passes
  the result to `adapterRegistry.deliver(subject, envelope, context)`.
- `packages/relay/src/adapters/claude-code-adapter.ts`: `handleAgentMessage()` reads
  `context?.agent?.directory` for `agentCwd`, then calls `agentManager.ensureSession(sessionId, { cwd: agentCwd })`.
  When `context` is `undefined`, `agentCwd = undefined` and the session falls back to server default CWD.
- `apps/server/src/services/core/agent-manager.ts`: `ensureSession()` stores `cwd` once at creation.
  `sendMessage()` uses `session.cwd || this.cwd` fallback chain. Concurrent `query()` calls on the same
  session cause SDK errors (`"Already connected to a transport"`).
- `apps/server/src/services/core/context-builder.ts`: `RELAY_TOOLS_CONTEXT` confirms design intent —
  label `{theirSessionId}` should actually be `{theirAgentId}` (Mesh ID). Comment says
  `mesh_inspect(agentId) to get their relay endpoint` confirming agents should route via Mesh IDs.
- `apps/server/src/services/relay/binding-router.ts`: Creates sessions with `binding.projectPath` as CWD
  directly via `agentManager.createSession(binding.projectPath)`. This path works because CWD is baked
  into the session, not resolved via context builder.
- `packages/@dorkos/shared/src/mesh-schemas.ts`: `AgentManifest` has `projectPath?: string` as an
  optional field per the Zod schema — but `MeshCore.get()` returns `AgentManifest | undefined`, so
  `projectPath` may not be populated.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/index.ts` — Server startup; controls initialization order of `meshCore` and
  `adapterManager`.
- `apps/server/src/services/relay/adapter-manager.ts` — `AdapterManager.buildContext()` and
  `AdapterManagerDeps`; the broken CWD resolution pipeline lives here.
- `packages/mesh/src/mesh-core.ts` — `MeshCore` registry; needs a new `getProjectPath(agentId)` public
  method that reads `AgentRegistryEntry.projectPath`.
- `packages/relay/src/adapters/claude-code-adapter.ts` — `handleAgentMessage()` CWD injection; reads
  `context?.agent?.directory`. Will work once `buildContext()` is fixed to return the right value.
- `apps/server/src/services/core/context-builder.ts` — `RELAY_TOOLS_CONTEXT` docs; label
  `{theirSessionId}` is misleading and should say `{theirAgentId}`.

**Shared Dependencies:**

- `packages/relay/src/adapter-delivery.ts` — Calls `contextBuilder?.(subject)` and forwards context to
  adapter. No changes needed here.
- `@dorkos/shared/mesh-schemas.ts` — `AgentManifest` Zod schema; `projectPath` exists as optional
  field.

**Data Flow (broken today → fixed):**

```
Agent A calls relay_send(subject="relay.agent.{agentBId}", ...)
  → RelayCore delivers envelope
  → AdapterDelivery calls contextBuilder("relay.agent.{agentBId}")
  → AdapterManager.buildContext()
      [TODAY: meshCore is undefined → returns undefined]
      [FIXED: meshCore.getProjectPath("agentBId") → "/path/to/agentB"]
      → returns AdapterContext { agent: { directory: "/path/to/agentB" } }
  → CCA.handleAgentMessage() reads context.agent.directory = "/path/to/agentB"
  → agentManager.ensureSession(sessionId, { cwd: "/path/to/agentB" })
      [TODAY: cwd = undefined → session uses server default CWD → WRONG agent responds]
      [FIXED: cwd = "/path/to/agentB" → correct agent responds]
```

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` — gates entire relay subsystem; must be `true` for any of this to run.

**Potential Blast Radius:**

- **Direct changes:** `index.ts` (init order), `adapter-manager.ts` (deps interface + buildContext),
  `mesh-core.ts` (new method), `context-builder.ts` (doc label only).
- **Indirect:** No callers of the new `getProjectPath()` method outside adapter-manager, so MeshCore
  change is additive-only.
- **Tests:** `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` (verify CWD injection
  with context), `apps/server/src/services/relay/__tests__/adapter-manager.test.ts` (if it exists),
  `packages/mesh/src/__tests__/` (new method coverage).

---

## 4) Root Cause Analysis

**Repro steps:**

1. Register two agents in DorkOS (e.g., "Empty" at `/Users/.../empty`, "LifeOS" at `/Users/.../lifeos`).
2. From the "Empty" session, call `relay_send(subject="relay.agent.{lifeOsAgentId}", payload={task})`.
3. Observe: a generic Claude session at the server's repo root responds, not LifeOS.

**Observed vs Expected:**

- **Observed:** Empty's relay message is handled by an SDK session with `cwd = undefined`, falling back
  to `this.cwd` (the server process's working directory). A blank Claude assistant responds.
- **Expected:** The message is handled by LifeOS's SDK session with `cwd = /Users/.../lifeos`, so LifeOS
  agents tools, AGENTS.md, and project context are active.

**Evidence:**

- `apps/server/src/index.ts` line ~116: `adapterManager = new AdapterManager({ agentManager, traceStore, pulseStore, relayCore })` — no `meshCore` in deps.
- `apps/server/src/services/relay/adapter-manager.ts` `buildContext()`: first check is `if (!this.deps.meshCore) return undefined` — always hits due to above.
- `AdapterManagerDeps.meshCore` declares `getAgent()` — but `MeshCore` only has `get()` (method name mismatch, would fail at runtime even if meshCore were passed).
- `buildContext()` accesses `agentInfo.manifest.directory` — `AgentManifest` has no `directory` field (wrong field name, would also fail at runtime).

**Root-cause hypotheses:**

1. **[HIGH CONFIDENCE] `meshCore` never injected** — Initialization order in `index.ts` puts
   `adapterManager` before `meshCore`. Even if the other two bugs were fixed, `buildContext()` would
   still short-circuit at the `!this.deps.meshCore` guard.
2. **[HIGH CONFIDENCE] Wrong method name** — `deps.meshCore.getAgent(id)` doesn't exist on `MeshCore`;
   the method is `get(id)`. TypeScript would catch this if the interface matched the real type.
3. **[HIGH CONFIDENCE] Wrong field name** — `agentInfo.manifest.directory` doesn't exist; project path
   is stored as `AgentRegistryEntry.projectPath` (not on `AgentManifest`). Need `MeshCore.getProjectPath()` to safely expose it.

**Decision:** All three bugs are real and must be fixed together. The init order bug alone would prevent
any fix from working; the method and field name bugs would cause runtime errors if the order were
corrected without fixing them.

---

## 5) Research

**SDK Concurrency Finding:**

A comment in `apps/server/src/services/core/agent-manager.ts` (line ~80) states:

> "Each SDK query() call needs its own McpServer instance because the SDK's internal Protocol can only
> be connected to one transport at a time. Reusing the same instance across concurrent queries causes
> 'Already connected to a transport' errors."

This means **concurrent relay messages to the same target agent session would crash the SDK**. Two strategies are viable:

**1. One session per target agent + in-CCA message queue**

- Description: CCA maintains a per-agentId queue; messages are serialized and processed one at a time.
- Pros: Consistent conversation context across senders; fewer sessions; simpler external reasoning.
- Cons: Adds queue complexity inside CCA; slow senders block others; need queue drain logic on shutdown.
- Complexity: Medium.
- Maintenance: Medium.

**2. One session per (sender → target) pair**

- Description: Session ID becomes `{agentId}:{fromEndpoint}`. Each unique sender gets isolation.
- Pros: No queue needed; natural concurrency; crash in one pair doesn't affect others.
- Cons: Session proliferation (N×M); each session lacks cross-sender context; harder to reason about
  which session is "the" target agent.
- Complexity: Low to implement, High to reason about.
- Maintenance: Medium-High (session cleanup).

**Recommendation for now:** **Defer concurrency handling to the specification phase.** The three wiring
bugs are the critical path. In practice, the initial use case is sequential (one agent querying another
at a time), so the concurrency issue won't surface immediately. The spec should propose a concrete
approach (likely option 1 with a simple async queue) as part of the implementation design.

---

## 6) Decisions

| #   | Decision                                                | Choice                                                                 | Rationale                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | How to expose `projectPath` from MeshCore               | Add `getProjectPath(agentId): string \| undefined` method              | Clean, minimal, additive-only change. `buildContext()` doesn't need to know about `AgentRegistryEntry` internals. Confirmed by user.                                                                                                                          |
| 2   | How to fix meshCore initialization order                | Move `meshCore` construction before `adapterManager` in `index.ts`     | MeshCore has no dependency on AdapterManager, so reordering is safe and produces the minimal possible diff. Confirmed by user.                                                                                                                                |
| 3   | Session strategy for concurrent agent-to-agent messages | **Open — defer to specification phase**                                | User requested research first. SDK disallows concurrent queries on the same session. Two viable approaches (shared session + queue vs. per-sender sessions). Not needed for the wiring fix; should be designed in the spec with explicit concurrency testing. |
| 4   | `context-builder.ts` documentation label                | Change `{theirSessionId}` to `{theirAgentId}` in `RELAY_TOOLS_CONTEXT` | The label has always been misleading — the value is a Mesh agent ID, not an SDK session UUID. Agents following the incorrect label would construct wrong relay subjects. Fixing label does not change any runtime behavior.                                   |

---

## 7) Proposed Fix Summary

Three files need code changes; one needs a doc-only update:

| File                                                | Change Type  | Summary                                                                                                                 |
| --------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/index.ts`                          | Init reorder | Construct `MeshCore` before `AdapterManager`; pass `meshCore` in `AdapterManagerDeps`                                   |
| `packages/mesh/src/mesh-core.ts`                    | New method   | Add `getProjectPath(agentId: string): string \| undefined` reading `AgentRegistryEntry.projectPath`                     |
| `apps/server/src/services/relay/adapter-manager.ts` | Bug fix      | Fix `AdapterManagerDeps.meshCore` type to match real `MeshCore` API; update `buildContext()` to call `getProjectPath()` |
| `apps/server/src/services/core/context-builder.ts`  | Docs only    | Change `{theirSessionId}` → `{theirAgentId}` in `RELAY_TOOLS_CONTEXT`                                                   |

**Test additions:**

- Unit test for `MeshCore.getProjectPath()`.
- Unit test for `AdapterManager.buildContext()` returning a valid `AdapterContext` with `directory` set.
- Integration test in CCA test suite asserting that `ensureSession` receives the correct `cwd` when
  context builder returns a valid context.

---

## 8) Open Questions (for Specification Phase)

1. **Concurrent agent messages** — Should CCA serialize messages to the same target agent via an in-process queue, or use per-(sender→target) sessions? The spec must make this call and include a concurrency test.
2. **Session lifecycle** — When should a CCA-managed agent session be torn down? Today `hasStarted: true` prevents recreation, but there's no cleanup for relay-initiated sessions.
3. **Mesh agent ID vs SDK session ID naming** — Several places in docs/code say "sessionId" when they mean Mesh agent ID. A cleanup pass in the spec should audit all `relay.agent.*` references.
