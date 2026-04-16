---
slug: codex-runtime-adapter-prework
number: 244
created: 2026-04-16
status: implemented
---

# Codex Runtime & Adapter Pre-Work

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-04-16
**Ideation:** `specs/codex-runtime-adapter-prework/01-ideation.md`

---

## Overview

This is a **meta-spec** for the platform hardening required before a first-class Codex runtime and relay adapter can land in DorkOS. The `AgentRuntime` contract introduced in spec #97 is sound — the gaps are in the surrounding server, Relay, and client layers that still assume a single default (Claude) runtime. The existing `test-mode` runtime already proves the contract is runtime-agnostic; production code has not yet caught up.

The spec organizes the pre-work into three **sequential phases**. Phase 1 lands per-session runtime ownership so every session route resolves its runtime deterministically. Phase 2 expands and re-wires the capability surface so the client gates UI by the **active** session's runtime, not by the server's default. Phase 3 generalizes Relay's internal runtime adapter so a second runtime can register alongside `ClaudeCodeAdapter` without duplicating its pattern.

The **actual CodexRuntime and CodexAdapter implementation is deliberately out of scope** — it is the fourth sequential spec in the overall plan from Decision 2 of ideation, and will be worked separately once this pre-work is complete.

## Background / Problem Statement

Spec #97 (`agent-runtime-abstraction`) extracted `AgentRuntime` and `RuntimeRegistry` as the universal backend contract. Spec #? (`agent-runtime-review-remediation`) cleaned up known seams. But the 2026-03-06 Claude Code adapter audit (`plans/2026-03-06-claude-code-adapter-audit.md`) correctly predicted that three classes of issue would remain:

1. **Routing** — most production routes still call `runtimeRegistry.getDefault()` rather than resolving per-session or per-agent.
2. **Capability consumption** — the client's `useRuntimeCapabilities` hook collapses to the default runtime; the `Transport` surface still has Claude-specific docstrings and method names (`reloadPlugins`, "Claude models", `'claudeai'` config scope, `McpServerEntry.status` documented against the Claude Agent SDK).
3. **Relay internals** — `adapter-manager.ts` imports a `ClaudeCodeAgentRuntimeLike` type; `binding-router.ts` and the relay runtime port in `packages/relay/src/adapters/claude-code/` are branded and typed for Claude.

Verification performed during ideation (2026-04-16) confirmed:

- Every production handler in `apps/server/src/routes/sessions.ts` calls `runtimeRegistry.getDefault()`. Same for `models.ts`, `subagents.ts`, `commands.ts`.
- `/api/capabilities` aggregates dynamically (`runtimeRegistry.getAllCapabilities()`), but `/api/system/requirements` is the only endpoint whose clients genuinely consume per-runtime data today.
- `RuntimeCapabilities` is a flat boolean bag (`supportsPermissionModes`, `supportsToolApproval`, `supportsCostTracking`, `supportsResume`, `supportsMcp`, `supportsQuestionPrompt`) — too coarse to express Codex's permission model, which differs from Claude's four-mode approach (see `research/20260315_agent_runtime_permission_modes.md`).
- `apps/server/src/services/runtimes/` already contains two implementations (`claude-code`, `test-mode`). The abstraction works; the platform around it does not yet.

Dropping a `CodexRuntime` on top today would produce "fake" multi-runtime support — it would compile and register, but every session would still be routed through whatever runtime is set as default, and the UI would gate all behavior off the default runtime's capabilities.

## Goals

- Every production server session flow resolves its runtime per-session, never through `runtimeRegistry.getDefault()` in the hot path.
- Session-to-runtime ownership is **persisted** and stable across restarts, not recomputed from agent manifests on every request.
- `RuntimeCapabilities` expands beyond flat booleans where it needs to (especially permission modes) without breaking existing clients.
- Client code (status bar, command palette, model selector, permission-mode picker, approval UI) reads capabilities for the **active session's** runtime.
- Relay's internal adapter abstraction is runtime-neutral in naming and types; a second adapter can register with no additional Claude-branded seams.
- `test-mode` runtime gains a parallel Relay adapter as a permanent integration test fixture, proving the generalized pattern without waiting for CodexRuntime.

## Non-Goals

- Implementing `CodexRuntime` itself (separate follow-up spec).
- Implementing `CodexAdapter` for Relay (separate follow-up spec).
- Designing a universal cross-runtime protocol abstraction (ACP-style) — explicitly deferred per ideation Research option 3.
- Replacing Claude's JSONL transcript storage for existing Claude sessions.
- Full Codex plugin marketplace integration.
- Changes to the `Transport` method set beyond renaming Claude-specific leakage and documenting runtime-conditional availability.
- Agent-manifest schema changes (`codex` is already a valid runtime value).

## Technical Dependencies

- `@anthropic-ai/claude-agent-sdk` — remains confined to `services/runtimes/claude-code/`.
- No new external dependencies.
- Reuses the existing `test-mode` runtime (`apps/server/src/services/runtimes/test-mode/`) as the second-runtime fixture across all three phases.

## Detailed Design

### Phase 1 — Per-Session Runtime Ownership & Route Resolution

**Goal.** Every session has a persisted `runtime` owner, and every production server route resolves the runtime via session context instead of `runtimeRegistry.getDefault()`.

**Target surface.**

- `apps/server/src/services/core/runtime-registry.ts` — add `resolveForSession(sessionId)` (or a similar per-session resolver) that returns the session's owning runtime, falling back to `getDefault()` only when no session is involved (e.g., server bootstrap).
- `apps/server/src/routes/sessions.ts` — all 14+ `runtimeRegistry.getDefault()` call sites (lines ~33, 48, 67, 99, 127, 178, 194, 229, 319, 340, 360, 377, 435, 455, 482) refactored to `runtimeRegistry.resolveForSession(sessionId)` or equivalent. Session creation is the single place where a new session's runtime is chosen (from agent manifest or explicit request) and persisted.
- `apps/server/src/routes/models.ts`, `subagents.ts`, `commands.ts` — accept a `sessionId` or `runtime` query parameter. When provided, resolve per-session; when absent (cold discovery), fall back to default. Callers in the client that have a session context will pass it.
- Storage layer — a durable home for `sessionId -> runtime`. Resolution of the storage mechanism is captured in Open Question 1.

**Session-creation flow.**

1. `POST /api/sessions` receives (optionally) an `agentPath` or explicit `runtime` hint.
2. Server resolves the effective runtime: explicit `runtime` > `agentManifest.runtime` > `runtimeRegistry.getDefaultType()`.
3. The chosen runtime type is persisted alongside the session before the first stream event is sent.
4. All subsequent requests for that `sessionId` read the persisted runtime.

**Legacy sessions.** Sessions created before this spec lands have no persisted runtime. See Open Question 2 for the back-fill approach.

**Tests.**

- Add fixtures that register **both** `claude-code` and `test-mode` runtimes, create one session against each, and exercise the full session route surface (create → list → get → messages → update → approvals → history → tasks → interrupt).
- Explicit regression: every endpoint in `routes/sessions.ts` is covered by at least one test that runs under the `test-mode` runtime.

### Phase 2 — Capability Matrix & UI Gating

**Goal.** `RuntimeCapabilities` shape carries enough information to drive runtime-specific UI without booleans-per-detail sprawl; client components read the **active** session's runtime capabilities, not the default.

**Shared layer.**

- `packages/shared/src/agent-runtime.ts` — evolve `RuntimeCapabilities`. The ideation's Decision 3 flagged the current shape as too coarse. The shape change must be additive (existing boolean flags retained during migration) so Phase 2 does not cascade into breaking all runtime implementations simultaneously. Final shape captured in Open Question 3.
- `packages/shared/src/transport.ts` — remove or soften Claude-specific wording: the `McpServerEntry.status` docstring ("reported by the Claude Agent SDK"), the `'claudeai'` literal in the `scope` docstring, the `getModels` docstring ("Claude models"), and the `reloadPlugins` method. Resolution for `reloadPlugins` captured in Open Question 4.

**Server layer.**

- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts` — declare the evolved capability shape with the full Claude values.
- `apps/server/src/services/runtimes/test-mode/` — declare a deliberately different capability shape (different permission modes list, different approval behavior) to prove the client correctly varies behavior per runtime.
- `apps/server/src/routes/capabilities.ts` — unchanged in structure (already dynamic); response shape updates naturally as the capability schema evolves.

**Client layer.**

- `apps/client/src/layers/entities/runtime/model/use-runtime-capabilities.ts` — add `useActiveCapabilities(sessionId)` (or equivalent) that resolves the active session's runtime type and returns its capabilities. `useDefaultCapabilities()` remains for screens that genuinely have no session context (e.g., first-run onboarding).
- `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx` — migrate from `useDefaultCapabilities()` to the active-session variant. Same for any other component reading capabilities for UI gating (permission-mode picker, model selector, command palette).
- `apps/client/src/layers/shared/lib/direct-transport.ts` — update `getCapabilities()` to return the full per-runtime map, matching the HTTP transport. Embedded-mode no longer collapses to a single runtime view.

**Tests.**

- Client tests simulate two sessions — one `claude-code`, one `test-mode` with a deliberately different capability shape. Assert status bar, permission-mode picker, and command palette render correctly in both.
- Shared schema tests confirm the evolved `RuntimeCapabilities` still parses existing runtime constant declarations.

### Phase 3 — Relay Runtime Adapter Generalization

**Goal.** Relay's internal runtime adapter surface is runtime-neutral; registering a second internal adapter is additive, not invasive.

**Type layer.**

- `packages/relay/src/adapters/claude-code/types.ts` — the `AgentRuntimeLike` interface (currently narrow and Claude-specific in assumptions) is promoted to a runtime-neutral interface. Location and name resolution captured in Open Question 5.
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts` — refactor so Claude-specific logic lives in this file, but the adapter implements a shared `RuntimeAdapter` base that any runtime can implement.

**Composition root.**

- `apps/server/src/services/relay/adapter-manager.ts` — replace the `ClaudeCodeAgentRuntimeLike` dependency with a runtime-neutral port. The manager accepts a map of runtime-type -> adapter instance and dispatches by the session's runtime (which Phase 1 has made available).
- `apps/server/src/services/relay/binding-router.ts` — publish on `relay.agent.<runtime>.*` subjects (or equivalent) so the router no longer special-cases `ClaudeCodeAdapter` by name.

**Permanent test fixture.**

- Introduce a minimal `TestModeAdapter` in `packages/relay/src/adapters/test-mode/` that composes over the existing `test-mode` runtime. This adapter is **not** for production; it exists so the generalized composition is exercised in CI. Resolution captured in Open Question 6.

**Tests.**

- Relay adapter-manager tests that register both `ClaudeCodeAdapter` and `TestModeAdapter`, publish a message to each via binding-router, and assert correct dispatch.
- No regression in existing `ClaudeCodeAdapter` tests — they continue to pass unchanged.

## Test Plan

Following the MEMORY-noted convention of holistic batch-level gates for `/spec:execute` on this repo (rather than per-task two-stage review), each phase has one batch-level gate:

- **Phase 1 gate.** All session route tests pass under both `claude-code` and `test-mode` runtimes; `grep` for `runtimeRegistry.getDefault()` in `apps/server/src/routes/` returns zero hits in hot paths (only bootstrap/discovery).
- **Phase 2 gate.** Both `claude-code` and `test-mode` runtimes declare differing capability shapes; client tests render the correct UI per runtime; `grep` for `useDefaultCapabilities` in `apps/client/src/layers/features/` returns zero hits (only in onboarding/no-session surfaces).
- **Phase 3 gate.** `TestModeAdapter` is registered in relay fixtures; a message routed via `binding-router` reaches the correct adapter for both runtimes; `grep` for `ClaudeCode` in `apps/server/src/services/relay/` returns zero hits in dispatch logic (only in configuration/imports where explicit).

## Risks & Mitigations

- **Risk:** Phase 1 storage choice creates legacy-session incompatibility. **Mitigation:** Open Question 2 locks the back-fill approach; legacy sessions migrate on first access or are back-filled by a one-time script.
- **Risk:** Capability shape evolution cascades into every runtime implementation and client consumer at once. **Mitigation:** Shape change is additive first (new fields alongside existing booleans); deprecation of old fields happens in a follow-up.
- **Risk:** Relay rename breaks an external integration. **Mitigation:** External `ClaudeCodeAdapter` type name and manifest remain stable; only _internal_ Relay port types are renamed.
- **Risk:** Scope creep into the actual Codex runtime. **Mitigation:** Non-Goals section is explicit; any Codex-implementation work surfaced during this spec is deferred to spec #4 in Decision 2's four-spec plan.
- **Risk:** Phases run concurrently despite the "strictly sequential" decision and cause merge thrash. **Mitigation:** `/spec:decompose` tasks are grouped by phase; the decomposer should not schedule Phase 2 tasks against an incomplete Phase 1.

## Acceptance Criteria

Overall:

1. No `runtimeRegistry.getDefault()` call sites remain in hot-path production code (session routes, message streaming, approvals, models/subagents/commands with session context). Bootstrap and cold discovery paths may still call `getDefault()`.
2. A session created against the `test-mode` runtime and a session created against the `claude-code` runtime coexist, each routing to its own runtime across the full session lifecycle.
3. Client UI (status bar, permission-mode picker, command palette, model selector) gates correctly off the active session's runtime capabilities.
4. `Transport` interface in `packages/shared/src/transport.ts` has no Claude-specific wording in public docstrings of runtime-shared methods; Claude-only capabilities are documented as capability-gated.
5. Relay's internal adapter dispatch table registers both `ClaudeCodeAdapter` and `TestModeAdapter`; a message on a `test-mode`-owned session reaches `TestModeAdapter`; a message on a `claude-code`-owned session reaches `ClaudeCodeAdapter`.
6. Adding `CodexRuntime` + `CodexAdapter` in the follow-up spec requires **no** further platform-layer changes — only new implementation files under `services/runtimes/codex/` and `packages/relay/src/adapters/codex/`.

## Open Questions

1. ~~**Per-session runtime persistence mechanism**~~ (RESOLVED)
   **Answer:** SQLite (Drizzle) `session_metadata` table in `packages/db/src/schema/sessions.ts`, columns `(sessionId, runtime, agentPath, createdAt)`.
   **Rationale:** DB consolidation (spec #63) has already landed. The established DorkOS pattern is "primary data in files, operational metadata in SQLite" (relay index, mesh agents, pulse runs all follow this). Session _content_ stays in JSONL (or Codex's equivalent); per-session operational metadata sits in the consolidated DB. Enables concrete future queries (sidebar filter by runtime, per-runtime observability counts) without a later sidecar→SQLite migration.

   Original context preserved:
   - Option A: Store the `runtime` type in the existing Claude JSONL transcript header — reuses existing infrastructure but tightly couples the per-session runtime marker to JSONL (which is a Claude-specific storage format).
   - Option B: Sidecar metadata file `{dorkHome}/sessions/{sessionId}.meta.json` with `{ runtime, createdAt, agentPath }`. Independent of any runtime's transcript format.
   - Option C: SQLite table (Drizzle) alongside other DorkOS durable state. Aligns with the `db-drizzle-consolidation` direction if that spec has landed; introduces a migration if not.
   - Original recommendation: Option B (corrected to Option C during spec review — DB consolidation already landed).

2. ~~**Legacy session runtime back-fill**~~ (RESOLVED)
   **Answer:** Infer-on-access as `claude-code` and persist into `session_metadata` on first touch.
   **Rationale:** Every pre-existing session was in fact Claude, so the inference is safe. O(per-session-read) cost is negligible; avoids a startup-time migration and its associated flag-tracking complexity.

   Original context preserved:
   - Option A: Infer all existing sessions as `claude-code` on first access and persist. Safe (every existing session was in fact Claude).
   - Option B: One-time migration script run at server startup that back-fills all known sessions.
   - Option C: Lazy — only persist when a legacy session is next touched; until then, resolve via default.
   - Recommendation: Option A.

3. ~~**Expanded `RuntimeCapabilities` shape**~~ (RESOLVED)
   **Answer:** Booleans for genuinely-boolean concepts (`supportsResume`, `supportsMcp`, `supportsCostTracking`, `supportsToolApproval`, `supportsQuestionPrompt`), structured `permissionModes: { supported: boolean, values: PermissionModeDescriptor[] }` where runtimes demonstrably differ, plus a typed `features: Record<string, unknown>` extension point for runtime-specific metadata.
   **Rationale:** Future-proof for the 3rd/4th/Nth runtime without forcing every runtime + consumer to migrate for hypothetical benefit. Targeted richness where it matters today (permission modes, per research 20260315); booleans elsewhere; escape hatch for runtime-specific metadata so new capabilities do not require a schema change every time.

   Original context preserved:
   - Option A: Keep flat booleans, add more flags as needed (e.g., `supportsPlugins`, `supportsAgentsMd`, `supportsSkills`). Minimal churn.
   - Option B: Evolve the highest-leverage fields to richer schemas — specifically `permissionModes: { supported: boolean, values: PermissionModeDescriptor[] }`. Keep other flags as booleans unless a concrete runtime difference demands otherwise.
   - Option C: Full schema overhaul with nested objects for every capability class (permissions, approvals, models, plugins, session semantics). Maximum expressiveness, maximum migration cost.
   - Final answer: Option B + `features` extension point (evolved during review to accommodate future runtimes beyond Codex).

4. ~~**`reloadPlugins` on `Transport`**~~ (RESOLVED)
   **Answer:** Remove from the universal `Transport` surface. Expose via a capability-gated sub-interface the client only uses when `capabilities.supportsPlugins` is true.
   **Rationale:** Keeps the universal `Transport` clean of runtime-specific leakage and makes Claude plugin reload a first-class capability-gated feature. Non-supporting runtimes can't accidentally receive calls.

   Original context preserved:
   - Option A: Keep the method; non-supporting runtimes return a no-op. Hides a runtime-specific concept behind a universal method.
   - Option B: Rename to runtime-neutral `reloadRuntimeExtensions` and document that it is capability-gated.
   - Option C: Remove from the universal `Transport` surface; expose Claude-specific endpoints via a capability-gated sub-interface that the client only uses when `capabilities.supportsPlugins` is true.
   - Recommendation: Option C.

5. ~~**Relay adapter generalization shape**~~ (RESOLVED)
   **Answer:** Shared abstract base class (streaming, delivery, retry) with runtime-specific thin subclasses. `ClaudeCodeAdapter` and future `CodexAdapter`/`TestModeAdapter` extend the base.
   **Rationale:** Behavioral base lives once and stays DRY; runtime-specific overrides are localized and legible. Best balance of code reuse and debuggability as runtimes multiply.

   Original context preserved:
   - Option A: Keep `ClaudeCodeAdapter` as a concrete class implementing a new shared `RuntimeAdapter` interface; `CodexAdapter` and friends are sibling concrete classes. Preserves the existing, well-tested Claude adapter with minimal change.
   - Option B: Collapse to a single generic `RuntimeAdapter<R extends AgentRuntime>` parameterized by the runtime interface. Maximum code reuse, but obscures runtime-specific behavior that may exist in the Claude adapter today.
   - Option C: Promote the _behavioral_ base (streaming, delivery, retry) to a shared abstract class, keep runtime-specific adapters as thin subclasses. A middle ground between A and B.
   - Recommendation: Option C.

## Changelog

- **2026-04-16** — Phase 1 code complete (tasks #1–#5). `session_metadata` table live, `runtimeRegistry.resolveForSession` + `persistSessionRuntime` + `getSessionRuntimeType` + `has` + `setDb` in place, `sessions.ts` + discovery routes migrated to per-session resolution, `relay.ts` label resolver patched (best-effort skip on unregistered runtime), 28-test multi-runtime integration suite added. Full server suite: 2570/2570 passing. Phase 1 gate (#6) awaiting manual smoke test + DB inspection.
- **2026-04-16** — Phase 2 complete (tasks #7–#14). `RuntimeCapabilities` evolved: structured `permissionModes`, `supportsPlugins`, `features` extension point. Claude leakage removed from `Transport` (`reloadPlugins` now capability-gated via `asClaudePluginTransport`). `useActiveCapabilities(sessionId)` hook added; UI migrated to consume permission-mode descriptors from capabilities (Claude: 4 modes, test-mode: 3 deliberately different modes). DirectTransport gained `getSessionRuntimeType` + optional `reloadPlugins` bridge on `DirectTransportServices.runtime`. Phase 2 gate automated checks all pass: grep clean (zero runtime-identity gating in features; zero Claude leakage in Transport); typecheck 21/21; tests: shared 465/465, server 2584/2584, client 4032/4032.
- **2026-04-16** — Phase 3 complete (tasks #15–#20). `RuntimeAdapter` abstract base shipped in `packages/relay/src/adapters/runtime-adapter.ts` with shared per-session queueing + open/stream/close lifecycle. `ClaudeCodeAdapter` refactored as `ClaudeCodeRuntimeAdapter` subclass — external name + constructor preserved, all existing tests pass byte-unchanged, `AgentQueue` deleted. Permanent `TestModeAdapter` shipped at `packages/relay/src/adapters/test-mode/` (79-line scripted-event adapter, hygiene-tested). `adapter-manager.ts` rewired to dispatch via `Map<string, RelayAdapter>` keyed on `runtimeRegistry.getSessionRuntimeType`; `ClaudeCodeAgentRuntimeLike` import removed; `AdapterNotRegisteredError` added. `binding-router.ts` publishes on `relay.agent.<runtimeType>.<sessionId>` subjects. Subject-format propagation: shared `parseAgentSubject` helper in `packages/relay/src/lib/subject-parser.ts` uses UUID-shape heuristic to tolerate both legacy and runtime-scoped subjects; all downstream parsers migrated. Phase 3 gate: grep clean (zero `ClaudeCodeAgentRuntimeLike` in relay/services, zero Claude SDK in test-mode adapter, only test-assertion hit of `instanceof ClaudeCodeAdapter`); full monorepo typecheck + test green (20/20 pipelines). Codex runtime/adapter now unblocked — adding a CodexRuntime + CodexAdapter requires only new files under `services/runtimes/codex/` and `packages/relay/src/adapters/codex/` plus a composition-root `manager.register('codex', codexAdapter)` line.

## Open Questions (original; all RESOLVED)

6. ~~**`TestModeAdapter` permanence**~~ (RESOLVED)
   **Answer:** Ship a permanent `TestModeAdapter` under `packages/relay/src/adapters/test-mode/` that composes the existing `test-mode` runtime. Exercised in CI as a standing integration fixture.
   **Rationale:** Cheap to maintain and catches real regressions that purely-mock tests would miss — e.g., Claude-specific imports creeping back into adapter-manager, binding-router losing its runtime-neutral dispatch, or the shared abstract base diverging from what a real second adapter needs.

   Original context preserved:
   - Option A: Inline mock adapter in tests only — not shipped to `packages/relay/src/adapters/test-mode/`. Smaller blast radius, adapter-manager tests are responsible for proving the seam works.
   - Option B: Permanent `TestModeAdapter` under `packages/relay/src/adapters/test-mode/` that composes the existing `test-mode` runtime. Exercised in CI as a standing integration fixture. Any future regression in the generalized composition fails the build.
   - Recommendation: Option B.
