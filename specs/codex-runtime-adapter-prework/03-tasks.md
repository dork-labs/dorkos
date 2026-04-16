# Task Breakdown: Codex Runtime Adapter Pre-Work

Generated: 2026-04-16
Source: specs/codex-runtime-adapter-prework/02-specification.md
Last Decompose: 2026-04-16

## Overview

Pre-work in three sequential phases to unblock a future CodexRuntime + CodexAdapter:

1. **Phase 1** persists per-session runtime ownership in a Drizzle `session_metadata` table and migrates every session hot-path to per-session resolution.
2. **Phase 2** evolves `RuntimeCapabilities` (structured `permissionModes` + `features` extension point), strips Claude-specific leakage from `Transport`, and re-wires client UI to gate off the active session's capabilities.
3. **Phase 3** promotes Relay's behavioral logic into a shared abstract `RuntimeAdapter` base, refactors `ClaudeCodeAdapter` as a thin subclass, ships a permanent `TestModeAdapter` as a CI fixture, and makes `adapter-manager` + `binding-router` dispatch by session runtime.

Each phase closes with a holistic batch-level gate (per MEMORY convention for `/spec:execute` on this repo).

---

## Phase 1: Per-Session Runtime Ownership & Route Resolution

### Task 1.1: Add session_metadata Drizzle schema and migration

**Size:** Small **Priority:** High **Dependencies:** None **Parallel with:** —

New `packages/db/src/schema/sessions.ts` declaring `session_metadata(sessionId, runtime, agentPath, createdAt)`. Generate and commit the Drizzle migration. Mirror column conventions used by existing schema files (`a2a.ts`, `activity.ts`, `mesh.ts`, `relay.ts`, `tasks.ts`).

**Acceptance:** table exported, migration applies cleanly, `@dorkos/db` typechecks.

---

### Task 1.2: Implement resolveForSession in runtime-registry with infer-on-access

**Size:** Medium **Priority:** High **Dependencies:** 1.1 **Parallel with:** —

Add `resolveForSession`, `persistSessionRuntime`, `getSessionRuntimeType` to `apps/server/src/services/core/runtime-registry.ts`. Legacy sessions infer as `claude-code` and persist on first access; `persistSessionRuntime` is idempotent (first-write wins). Unregistered runtimes throw `RuntimeNotRegisteredError` — no silent fallback.

**Acceptance:** 4 unit-test scenarios (new/legacy/test-mode/unregistered) all pass.

---

### Task 1.3: Migrate routes/sessions.ts to resolveForSession + persist on create

**Size:** Large **Priority:** High **Dependencies:** 1.2 **Parallel with:** 1.4

Replace every `runtimeRegistry.getDefault()` call in `apps/server/src/routes/sessions.ts` (14+ sites). Session creation resolves the runtime in priority order `explicit > agent-manifest > default` and persists BEFORE streaming.

**Acceptance:** zero `getDefault()` hits in sessions.ts; new sessions persist metadata row; legacy sessions transparently infer; all existing session-route tests pass.

---

### Task 1.4: Migrate models/subagents/commands routes to session-scoped resolution

**Size:** Medium **Priority:** High **Dependencies:** 1.2 **Parallel with:** 1.3

Add `sessionId` query-param support to `/api/models`, `/api/subagents`, `/api/commands`. When provided, resolve per-session; when absent (cold discovery), fall back to default. Update client callers that have session context to pass `sessionId`.

**Acceptance:** session-scoped and default-fallback paths both tested for all three routes; client model selector uses active session's models.

---

### Task 1.5: Multi-runtime integration tests covering full session surface

**Size:** Large **Priority:** High **Dependencies:** 1.3, 1.4 **Parallel with:** —

New `apps/server/src/routes/__tests__/sessions-multi-runtime.test.ts` that registers both runtimes and exercises every session endpoint (create, list, get, messages, update, approvals, history, tasks, interrupt) for both claude-code and test-mode sessions. Legacy-inference + unregistered-runtime cases included.

**Acceptance:** every endpoint covered under test-mode; no crosstalk between sessions.

---

### Task 1.6: Phase 1 batch gate — grep + test + smoke

**Size:** Small **Priority:** High **Dependencies:** 1.5 **Parallel with:** —

Holistic gate. Grep for residual `getDefault()`, run test + typecheck, manual dev-server smoke (create both runtime sessions, restart, verify persistence), DB inspection for back-filled rows. Append changelog entry.

**Acceptance:** gate passes, Phase 2 unblocked.

---

## Phase 2: Capability Matrix & UI Gating

### Task 2.1: Evolve RuntimeCapabilities — structured permissionModes + features extension

**Size:** Medium **Priority:** High **Dependencies:** 1.6 **Parallel with:** —

Update `packages/shared/src/agent-runtime.ts`: keep booleans for genuinely-boolean capabilities (`supportsResume`, `supportsMcp`, `supportsCostTracking`, `supportsToolApproval`, `supportsQuestionPrompt`, `supportsPlugins`), promote `permissionModes` to `{ supported, values: PermissionModeDescriptor[] }`, add typed `features: Record<string, unknown>` extension point.

**Acceptance:** shape tests pass; all consumers updated in same commit; monorepo typechecks.

---

### Task 2.2: Remove Claude leakage from Transport; add capability-gated ClaudePluginTransport

**Size:** Medium **Priority:** High **Dependencies:** 2.1 **Parallel with:** —

Remove `reloadPlugins` from universal `Transport` surface; re-word `getModels`, `McpServerEntry.status`, `'claudeai'` scope docstrings to runtime-neutral. Add `ClaudePluginTransport` sub-interface accessed via `transport.asClaudePluginTransport()` which returns `null` when `capabilities.supportsPlugins === false`.

**Acceptance:** zero Claude leakage hits in transport.ts (outside the new sub-interface); type-level test confirms removal.

---

### Task 2.3: Update ClaudeCodeRuntime capabilities

**Size:** Small **Priority:** High **Dependencies:** 2.1 **Parallel with:** 2.4

Declare the evolved shape in `apps/server/src/services/runtimes/claude-code/runtime-constants.ts` with four permission-mode descriptors (`default`, `acceptEdits`, `plan`, `bypassPermissions`) and `features: { claudeSkills, claudeHooks, claudeSlashCommands }`. Verify permission-mode ids match the Claude SDK enum.

**Acceptance:** snapshot test locks shape; SDK ids match; tests pass.

---

### Task 2.4: Give TestModeRuntime deliberately different capabilities

**Size:** Small **Priority:** High **Dependencies:** 2.1 **Parallel with:** 2.3

Declare `TEST_MODE_CAPABILITIES` with non-overlapping permission-mode ids (`always-allow`, `always-deny`, `scripted`), `supportsMcp: false`, `supportsPlugins: false`, and a distinct `features` payload (`testModeScenarios`, `deterministicLatencyMs`). Different shape forces the client to gate off capabilities, not identity.

**Acceptance:** cross-runtime test confirms permission-mode ids do not overlap with Claude.

---

### Task 2.5: Add useActiveCapabilities(sessionId) hook

**Size:** Medium **Priority:** High **Dependencies:** 2.2, 2.3, 2.4 **Parallel with:** —

`apps/client/src/layers/entities/runtime/model/use-runtime-capabilities.ts`: add `useActiveCapabilities(sessionId)` that reads the session's runtime type and returns that runtime's capabilities. Extend `Transport` with `getSessionRuntimeType` and the full-map `getCapabilities()`. `useDefaultCapabilities` stays for onboarding/no-session screens.

**Acceptance:** hook returns correct caps per runtime; new Transport methods implemented on both HttpTransport and DirectTransport.

---

### Task 2.6: Migrate ChatStatusSection and related UI to useActiveCapabilities

**Size:** Large **Priority:** High **Dependencies:** 2.5 **Parallel with:** —

Migrate every component under `apps/client/src/layers/features/` that currently uses `useDefaultCapabilities`. Permission-mode picker renders `caps.permissionModes.values`. Claude-specific UI hints gate off `caps.features.claudeSkills` etc., never off runtime identity string.

**Acceptance:** grep for `useDefaultCapabilities` in `features/` returns zero hits; component tests pass for both runtime shapes.

---

### Task 2.7: Update DirectTransport to expose per-runtime capability map + sub-interface

**Size:** Medium **Priority:** High **Dependencies:** 2.2, 2.5 **Parallel with:** 2.6

`DirectTransport.getCapabilities()` returns `Record<string, RuntimeCapabilities>`; `getSessionRuntimeType` delegates to embedded registry; `asClaudePluginTransport` returns a concrete wrapper for claude-code sessions, null for others. Contract test asserts shape parity with HttpTransport.

**Acceptance:** parity test passes; no hardcoded `'claude-code'` literal remains outside documented fallbacks.

---

### Task 2.8: Phase 2 batch gate

**Size:** Small **Priority:** High **Dependencies:** 2.6, 2.7 **Parallel with:** —

Grep for `useDefaultCapabilities` in features/, Claude leakage in transport, identity-string gating. Run full typecheck + test suite. Manual UI smoke confirming permission-mode picker, status bar, model selector re-render per active session. Append changelog entry.

---

## Phase 3: Relay Runtime Adapter Generalization

### Task 3.1: Extract shared abstract RuntimeAdapter base in packages/relay/src/adapters/

**Size:** Medium **Priority:** High **Dependencies:** 2.8 **Parallel with:** —

New `packages/relay/src/adapters/runtime-adapter.ts` containing the abstract base with retry, queueing, delivery, ordering concrete in the base; three abstract hooks (`openSession`, `normalizeEvent`, `closeSession`) for subclasses. Behavioral tests using a minimal `FakeAdapter`.

**Acceptance:** behavioral tests pass; no Claude-specific imports in the base file.

---

### Task 3.2: Refactor ClaudeCodeAdapter as thin subclass

**Size:** Medium **Priority:** High **Dependencies:** 3.1 **Parallel with:** 3.3

`packages/relay/src/adapters/claude-code/claude-code-adapter.ts` extends the shared base; only three abstract-method overrides plus Claude-specific helpers remain. External name `ClaudeCodeAdapter` and constructor signature preserved.

**Acceptance:** every existing claude-code adapter test passes UNCHANGED (pure refactor).

---

### Task 3.3: Create permanent TestModeAdapter

**Size:** Medium **Priority:** High **Dependencies:** 3.1 **Parallel with:** 3.2

New `packages/relay/src/adapters/test-mode/test-mode-adapter.ts` — permanent CI fixture. Zero Claude imports. Streams scripted test-mode scenarios through the base's pipeline.

**Acceptance:** end-to-end scenario test passes; import-hygiene test confirms no Claude SDK / claude-code imports.

---

### Task 3.4: Rewire adapter-manager to dispatch by session runtime

**Size:** Medium **Priority:** High **Dependencies:** 3.2, 3.3 **Parallel with:** 3.5

Replace `ClaudeCodeAgentRuntimeLike` dependency with a `Map<string, RuntimeAdapter>`. Dispatch via `runtimeRegistry.getSessionRuntimeType(sessionId)`. Throws `AdapterNotRegisteredError` for unknown runtimes; never silent-falls-back.

**Acceptance:** dispatch tests pass for both runtimes; zero `ClaudeCodeAgentRuntimeLike` hits.

---

### Task 3.5: Make binding-router publish on runtime-neutral subjects

**Size:** Medium **Priority:** High **Dependencies:** 3.2, 3.3 **Parallel with:** 3.4

Subject templates use `relay.agent.<runtimeType>.<event>` derived from session's runtime. No `instanceof ClaudeCodeAdapter` or identity-string branches in dispatch logic. Integration test through adapter-manager confirms routing.

**Acceptance:** zero identity-string dispatch branches; both runtimes publish to correct subjects.

---

### Task 3.6: Phase 3 batch gate — final acceptance sign-off

**Size:** Small **Priority:** High **Dependencies:** 3.4, 3.5 **Parallel with:** —

Grep (ClaudeCode in relay dispatch logic, ClaudeCodeAgentRuntimeLike, claude SDK in test-mode adapter), run full relay + server test suites, end-to-end multi-adapter smoke (two sessions routing through two adapters, runtime-neutral subjects visible in relay logs). Ten-minute CodexRuntime stub spike proves spec Acceptance Criterion #6. Mark spec as `implemented`; flag ADRs 0255–0258 for curation.

---

## Parallel Execution Summary

- **Phase 1:** 1.3 ∥ 1.4 can run simultaneously after 1.2 lands.
- **Phase 2:** 2.3 ∥ 2.4 can run simultaneously after 2.1 lands. 2.6 ∥ 2.7 after 2.5.
- **Phase 3:** 3.2 ∥ 3.3 after 3.1 lands. 3.4 ∥ 3.5 after 3.2 + 3.3.
- **Phases are strictly sequential** — gate tasks (1.6, 2.8, 3.6) block the next phase's first task.

## Critical Path

1.1 → 1.2 → 1.3 (or 1.4) → 1.5 → 1.6 → 2.1 → 2.2 → 2.5 → 2.6 (or 2.7) → 2.8 → 3.1 → 3.2 (or 3.3) → 3.4 (or 3.5) → 3.6
