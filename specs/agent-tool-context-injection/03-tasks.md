# Task Breakdown: Agent Tool Context Injection
Generated: 2026-03-04
Source: specs/agent-tool-context-injection/02-specification.md
Last Decompose: 2026-03-04

## Overview

DorkOS provides 28 MCP tools but agents receive zero instructions on how to use them together. This feature adds three static XML context blocks (`<relay_tools>`, `<mesh_tools>`, `<adapter_tools>`) to the agent system prompt via `context-builder.ts`, with user config toggles and a UI tab for controlling injection.

## Phase 1: Foundation

### Task 1.1: Add agentContext section to UserConfigSchema
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

Add `agentContext` section to `UserConfigSchema` in `packages/shared/src/config-schema.ts` with three boolean toggles (`relayTools`, `meshTools`, `adapterTools`), all defaulting to `true`. No route changes needed since the existing PATCH handler already deep-merges and validates via the schema.

**Acceptance Criteria**:
- [ ] `agentContext` section exists in `UserConfigSchema` with three boolean fields
- [ ] All three fields default to `true`
- [ ] `UserConfig` type includes `agentContext` property
- [ ] `USER_CONFIG_DEFAULTS` includes `agentContext` with all defaults
- [ ] `pnpm typecheck` passes

---

### Task 1.2: Add static XML context block constants to context-builder
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

Add three static string constants (`RELAY_TOOLS_CONTEXT`, `MESH_TOOLS_CONTEXT`, `ADAPTER_TOOLS_CONTEXT`) to `context-builder.ts` containing the full XML context blocks. Also add `@internal` test exports for all constants and builder functions.

**Acceptance Criteria**:
- [ ] `RELAY_TOOLS_CONTEXT` contains full XML block with subject hierarchy, workflows, error codes
- [ ] `MESH_TOOLS_CONTEXT` contains full XML block with 8-step lifecycle, workflows, runtimes
- [ ] `ADAPTER_TOOLS_CONTEXT` contains full XML block with subject conventions, adapter management, binding routing
- [ ] All constants and builder functions exported with `@internal` annotation
- [ ] `pnpm typecheck` passes

---

### Task 1.3: Add builder functions and wire into buildSystemPromptAppend
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

Add three synchronous builder functions (`buildRelayToolsBlock`, `buildMeshToolsBlock`, `buildAdapterToolsBlock`) that gate injection on feature flags (`isRelayEnabled()`) and config toggles (`configManager.get('agentContext')`). Wire them into `buildSystemPromptAppend()` after the async `Promise.allSettled` block. Config uses `=== false` check for backward compatibility with pre-existing configs.

**Acceptance Criteria**:
- [ ] Relay block gated on `isRelayEnabled()` AND `agentContext.relayTools !== false`
- [ ] Mesh block gated only on `agentContext.meshTools !== false` (always-on per ADR-0062)
- [ ] Adapter block gated on `isRelayEnabled()` AND `agentContext.adapterTools !== false`
- [ ] `buildSystemPromptAppend()` includes all three blocks in output
- [ ] Existing env/git/agent blocks unchanged
- [ ] `pnpm typecheck` passes

---

### Task 1.4: Add server unit tests for context builder tool blocks
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: None

Add unit tests to `context-builder.test.ts` for the three new builder functions. Tests cover: feature enabled/disabled, config on/off, config undefined (default behavior), and integration with `buildSystemPromptAppend()`. Adds mocks for `relay-state.js` and `config-manager.js`.

**Acceptance Criteria**:
- [ ] Each builder function tested under all 4 state combinations (feature+config on/off)
- [ ] Backward compatibility tested (undefined config returns content)
- [ ] Mesh not affected by relay feature flag
- [ ] Integration tests verify tool blocks in `buildSystemPromptAppend` output
- [ ] All existing tests continue to pass
- [ ] `pnpm test -- --run` passes

---

## Phase 2: Client UI

### Task 2.1: Create useAgentContextConfig hook
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.2

Create `use-agent-context-config.ts` in `features/agent-settings/model/`. Hook reads from the shared `['config']` query key, merges with defaults (all true), and provides an `updateConfig` mutation that patches the `agentContext` section via `transport.updateConfig()`.

**Acceptance Criteria**:
- [ ] Returns `config` with three boolean fields and `updateConfig` function
- [ ] Defaults to all-true when server has no agentContext section
- [ ] Invalidates `['config']` query on mutation success
- [ ] Uses `useTransport()` for HTTP calls
- [ ] `pnpm typecheck` passes

---

### Task 2.2: Create ContextTab component
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.1

Create `ContextTab.tsx` in `features/agent-settings/ui/`. Renders three toggle sections (Relay Tools, Mesh Tools, Adapter Tools) with `ContextBlockSection` helper component. Each section has a label, description, switch, and conditional read-only preview. Relay and adapter sections are disabled when relay is off. Preview strings match server-side XML content without outer tags.

**Acceptance Criteria**:
- [ ] Three toggle sections render with labels, descriptions, switches
- [ ] Preview shows when toggle on AND feature available
- [ ] Relay/adapter switches disabled when relay off
- [ ] "Relay is disabled" badge shown when relay off
- [ ] All switches have `aria-label` for accessibility
- [ ] `pnpm typecheck` passes

---

### Task 2.3: Integrate ContextTab into AgentDialog as fifth tab
**Size**: Small
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: None

Update `AgentDialog.tsx`: import ContextTab, add fifth tab trigger ("Context"), update `grid-cols-4` to `grid-cols-5`, add `TabsContent` for context tab. ContextTab receives no props (operates on global config, not per-agent manifest).

**Acceptance Criteria**:
- [ ] "Context" tab appears as fifth tab in AgentDialog
- [ ] Clicking tab renders ContextTab component
- [ ] Tab grid accommodates 5 tabs without overflow
- [ ] Existing tabs unaffected
- [ ] `pnpm typecheck` passes

---

### Task 2.4: Add client component tests for ContextTab
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.2
**Can run parallel with**: None

Create `ContextTab.test.tsx` in `features/agent-settings/__tests__/`. Tests cover: all sections render, preview visibility (on/off, available/unavailable), switch disabled states, badge rendering, toggle calls `updateConfig` with correct key, accessibility labels.

**Acceptance Criteria**:
- [ ] All three toggle sections render
- [ ] Preview visibility tested (4 combinations)
- [ ] Disabled switch states tested when relay off
- [ ] Badge rendering tested
- [ ] Toggle click calls `updateConfig` correctly
- [ ] Accessibility labels verified
- [ ] `pnpm test -- --run` passes

---

## Phase 3: Verification

### Task 3.1: Run full typecheck and test suite
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.4, Task 2.3, Task 2.4
**Can run parallel with**: None

Run `pnpm typecheck`, `pnpm test -- --run`, and `pnpm lint` across the full monorepo to verify no regressions. Verify types flow correctly through shared schema, server context-builder, and client hook/component.

**Acceptance Criteria**:
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- --run` exits 0
- [ ] `pnpm lint` shows no new errors
- [ ] No regressions in existing functionality
