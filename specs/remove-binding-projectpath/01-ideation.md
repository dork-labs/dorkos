---
slug: remove-binding-projectpath
number: 131
created: 2026-03-14
status: ideation
---

# Remove projectPath from AdapterBinding — Derive CWD from Agent Registry

**Slug:** remove-binding-projectpath
**Author:** Claude Code
**Date:** 2026-03-14
**Branch:** preflight/remove-binding-projectpath

---

## 1) Intent & Assumptions

- **Task brief:** Remove `projectPath` from the `AdapterBinding` schema and derive it at routing time from the agent registry via `meshCore.getProjectPath(agentId)`. Currently, bindings store both `agentId` and `projectPath`, but agents have a 1:1 mapping with projectPath (UNIQUE constraint in DB). This creates redundancy, discrepancy risk, and empty-string bugs when the UI doesn't ask for projectPath during setup.
- **Assumptions:**
  - An agent's projectPath is always available in the mesh registry when routing occurs (meshCore initializes before AdapterManager)
  - No valid use case exists for binding an adapter to an agent but routing to a _different_ working directory — the agent _is_ its directory
  - The `agentDir → projectPath` legacy migration in BindingStore is no longer needed
  - External MCP tool consumers may need a brief transition period for the `binding_create` tool schema change
- **Out of scope:**
  - Changes to how agents store or register their projectPath
  - Changes to the agent discovery/scanning system
  - UI redesign of the binding creation flow beyond removing the projectPath field

## 2) Pre-reading Log

- `packages/shared/src/relay-adapter-schemas.ts`: `AdapterBindingSchema` has `projectPath: z.string()` (line 277). `CreateBindingRequestSchema` inherits it via `.omit()`. Both types auto-infer from Zod.
- `apps/server/src/services/relay/binding-router.ts`: Uses `binding.projectPath` in two places — payload CWD enrichment (lines 131-136) and session creation (line 239). `BindingRouterDeps` does not currently include `meshCore`.
- `apps/server/src/services/relay/adapter-manager.ts`: Already defines `AdapterMeshCoreLike` interface (lines 52-54) with `getProjectPath(agentId: string): string | undefined`. Already has `meshCore` in its deps but does not pass it to `BindingRouter`.
- `apps/server/src/services/relay/binding-store.ts`: Has legacy `agentDir → projectPath` migration (lines 195-203) that can be replaced with a `projectPath` stripping migration.
- `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`: Has a visible "Project Path" text input (lines 254-262) that users manually type into. `BindingFormValues` interface includes `projectPath: string`.
- `apps/client/src/layers/features/relay/ui/BindingList.tsx`: Has `projectPathName()` utility (lines 57-60) used as agent name fallback (line 210). Duplicate binding creation passes `projectPath` (line 341).
- `apps/client/src/layers/features/mesh/ui/use-topology-handlers.ts`: Passes `targetProjectPath` from agent data to binding creation (lines 175, 188).
- `apps/client/src/layers/features/relay/ui/ConversationRow.tsx`: Creates bindings with `projectPath: ''` (line 140) — confirming the bug.
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`: Creates bindings with `projectPath: ''` (line 289) — also confirms the bug.
- `apps/server/src/services/runtimes/claude-code/mcp-tools/binding-tools.ts`: MCP `binding_create` tool accepts `projectPath` as a parameter.
- `apps/server/src/services/core/mcp-server.ts`: MCP server defines `projectPath` in `binding_create` tool schema.
- `apps/server/.temp/.dork/relay/bindings.json`: Current Slack binding has `projectPath: ""` — the live manifestation of this bug.
- `packages/mesh/src/mesh-core.ts`: `getProjectPath(agentId)` delegates to `agentMgmt.getProjectPath()` which does `registry.get(agentId)?.projectPath`.
- `apps/server/src/routes/relay.ts`: Binding CRUD endpoints. `PATCH` already excludes `projectPath` from mutable fields — no changes needed there.
- `packages/shared/src/transport.ts`: `updateBinding()` already excludes `projectPath` from mutable fields.

## 3) Codebase Map

**Primary components/modules:**

- `packages/shared/src/relay-adapter-schemas.ts` — Schema source of truth for `AdapterBinding`, `CreateBindingRequest`
- `apps/server/src/services/relay/binding-router.ts` — Core routing logic; enriches payload CWD, creates sessions
- `apps/server/src/services/relay/adapter-manager.ts` — Wires BindingRouter; already has `AdapterMeshCoreLike` and `meshCore` dep
- `apps/server/src/services/relay/binding-store.ts` — Persistence layer; loads/saves `bindings.json`
- `apps/server/src/services/runtimes/claude-code/mcp-tools/binding-tools.ts` — MCP `binding_create` tool handler
- `apps/server/src/services/core/mcp-server.ts` — MCP server tool definitions
- `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx` — Binding create/edit dialog with projectPath input
- `apps/client/src/layers/features/relay/ui/BindingList.tsx` — Binding list display and actions
- `apps/client/src/layers/features/mesh/ui/use-topology-handlers.ts` — Topology drag-to-connect binding creation
- `apps/client/src/layers/features/relay/ui/ConversationRow.tsx` — Quick-route binding creation
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx` — Setup wizard binding creation

**Shared dependencies:**

- `packages/mesh/src/mesh-core.ts` — `getProjectPath(agentId)` API
- `packages/mesh/src/agent-registry.ts` — Agent registry with projectPath storage
- `packages/shared/src/transport.ts` — Transport interface (auto-reflects schema changes)

**Data flow:**
Inbound message → `BindingRouter.handleInbound()` → `bindingStore.resolve()` → **currently reads `binding.projectPath`** → enriches payload with `cwd` → `agentManager.createSession(projectPath)` → publishes to `relay.agent.{sessionId}`

**After change:** `binding.agentId` → `meshCore.getProjectPath(agentId)` → enriches payload with `cwd` → same downstream flow

**Feature flags/config:** None. This is a schema and routing change.

**Potential blast radius:**

- Direct: ~11 source files need changes
- Tests: ~15 test files need `projectPath` removed from mock data
- Persisted data: Existing `bindings.json` files need `projectPath` stripped on load
- MCP external consumers: `binding_create` tool schema changes (breaking for callers passing `projectPath`)

## 4) Root Cause Analysis

N/A — this is a design improvement, not a bug fix (though it does fix the empty-projectPath bug as a side effect).

## 5) Research

**Potential solutions:**

**1. Remove projectPath entirely (derive at routing time)**

- Description: Drop `projectPath` from the binding schema. BindingRouter resolves it from `meshCore.getProjectPath(binding.agentId)` at routing time.
- Pros:
  - Single source of truth — agent registry owns the path
  - No drift, no discrepancies, no empty strings
  - Simpler schema, simpler UI (no projectPath input)
  - Agent path changes automatically reflected in routing
- Cons:
  - Breaking schema change (migration needed for persisted data)
  - MCP `binding_create` tool API changes (external consumer impact)
  - BindingRouter gains a new dependency (meshCore)
- Complexity: Medium
- Maintenance: Lower long-term

**2. Auto-populate projectPath from agentId on creation**

- Description: Keep `projectPath` in the schema but auto-fill it from the agent registry when creating a binding. Remove from UI.
- Pros:
  - Backward-compatible schema
  - No migration needed for existing data
- Cons:
  - Still stores redundant data
  - Still drifts if agent path changes
  - Doesn't solve the fundamental single-source-of-truth problem
  - "Less wrong" rather than correct
- Complexity: Low
- Maintenance: Same or higher (drift risk remains)

**3. Make projectPath optional with fallback**

- Description: Make `projectPath` optional in the schema. If present, use it; if absent, derive from agent registry.
- Pros:
  - Backward-compatible
  - Allows override for advanced use cases
- Cons:
  - More complex routing logic (two code paths)
  - "Override" use case doesn't actually exist and creates confusion
  - Defers the real fix
- Complexity: Low
- Maintenance: Higher (two code paths to maintain)

**Recommendation:** Option 1 — remove entirely. This is the correct solution. The other options are half-measures that preserve a design flaw. Per the project's quality standard: "We never tolerate deprecated or legacy patterns; when something is superseded, we remove it."

## 6) Decisions

| #   | Decision                                                          | Choice                                                                      | Rationale                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Error handling when `meshCore.getProjectPath()` returns undefined | Log warning and skip routing                                                | Consistent with existing pattern for missing bindings (line 123-126). The binding references a deleted/unregistered agent — routing would fail anyway.                                                                    |
| 2   | `meshCore` dependency on BindingRouter                            | Required, not optional                                                      | BindingRouter cannot function without CWD resolution. meshCore is guaranteed available (inits before AdapterManager). Avoiding unnecessary null-checks.                                                                   |
| 3   | Migration of existing `bindings.json`                             | Strip `projectPath` from raw JSON before Zod parse in `BindingStore.load()` | Replaces the existing `agentDir → projectPath` migration. Clean and backward-compatible — existing data loads without error.                                                                                              |
| 4   | MCP `binding_create` tool transition                              | Remove `projectPath` from schema directly                                   | External consumers will get a clear Zod validation error if they pass the old field. The tool description will document the change. No transition period — the field was broken anyway (consumers had to guess the path). |
