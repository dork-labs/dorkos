# Task Breakdown: Agent Tools Elevation

Generated: 2026-03-04
Source: specs/agent-tools-elevation/02-specification.md
Last Decompose: 2026-03-04

## Overview

Evolve DorkOS's agent-tool management from global-only toggles into a per-agent tool system. Four interconnected goals:

1. Per-agent tool enable/disable stored in agent manifests with global defaults
2. Agent-scoped sidebar indicators showing per-agent tool status
3. Natural language cross-tool orchestration via enhanced, agent-aware context injection
4. Agent-first Pulse scheduling (agent identity instead of raw CWD paths)

All changes are backward-compatible.

---

## Phase 1: Schema & Shared Types

### Task 1.1: Add EnabledToolGroupsSchema to mesh-schemas and extend AgentManifest
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:
- Add `EnabledToolGroupsSchema` Zod schema with optional boolean fields: pulse, relay, mesh, adapter
- Default to `{}` for backward compatibility
- Add `enabledToolGroups` to `AgentManifestSchema`
- Add `enabledToolGroups` to `UpdateAgentRequestSchema` pick set
- Export schema and type from barrel

**Acceptance Criteria**:
- [ ] `EnabledToolGroupsSchema` exported from `mesh-schemas.ts`
- [ ] `AgentManifestSchema` includes `enabledToolGroups` field
- [ ] `UpdateAgentRequestSchema` includes `enabledToolGroups` in pick set
- [ ] Existing manifests without `enabledToolGroups` parse with `{}` default
- [ ] Schema tests pass

---

### Task 1.2: Add pulseTools to global agentContext config schema
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:
- Add `pulseTools: z.boolean().default(true)` to `agentContext` in `UserConfigSchema`
- Update default factory function
- Verify `USER_CONFIG_DEFAULTS` includes new field

**Acceptance Criteria**:
- [ ] `pulseTools` added to `agentContext` config
- [ ] Existing configs parse successfully
- [ ] All existing tests pass

---

### Task 1.3: Add agentId to PulseSchedule schema and DB migration
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2

**Technical Requirements**:
- Add `agentId: z.string().nullable().default(null)` to `PulseScheduleSchema`
- Add `agentId: z.string().optional()` to `CreateScheduleRequestSchema`
- Add `agentId: z.string().nullable().optional()` to `UpdateScheduleRequestSchema`
- SQLite migration: `ALTER TABLE pulse_schedules ADD COLUMN agent_id TEXT`
- Update PulseStore CRUD methods for agentId field

**Acceptance Criteria**:
- [ ] Zod schemas updated with agentId
- [ ] Database migration runs successfully
- [ ] PulseStore CRUD handles agentId
- [ ] New tests for agentId CRUD pass
- [ ] All existing pulse tests pass

---

## Phase 2: Server Tool Filtering

### Task 2.1: Create tool-filter.ts with resolveToolConfig and buildAllowedTools
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, 1.2
**Can run parallel with**: None

**Technical Requirements**:
- Create `apps/server/src/services/core/tool-filter.ts`
- `resolveToolConfig()`: merge agent overrides with global defaults, gate by feature flags
- `buildAllowedTools()`: return allowedTools array or undefined (all enabled)
- Tool name constants for CORE, PULSE, RELAY, MESH, ADAPTER, BINDING, TRACE groups
- Implicit grouping: binding follows adapter, trace follows relay

**Acceptance Criteria**:
- [ ] `resolveToolConfig` merges correctly with feature flag gating
- [ ] `buildAllowedTools` returns undefined when all enabled
- [ ] Core tools always included
- [ ] Implicit grouping works correctly
- [ ] 14+ unit tests pass

---

### Task 2.2: Enhance context-builder with agent-aware gating, pulse block, and peer agents
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, 1.2, 2.1
**Can run parallel with**: None

**Technical Requirements**:
- Update `buildSystemPromptAppend` signature to accept optional `meshCore` and `toolConfig`
- Agent-aware block gating: use `toolConfig` when provided, fall back to global config
- New `PULSE_TOOLS_CONTEXT` block with schedule tool documentation
- Enhanced `RELAY_TOOLS_CONTEXT` with cross-agent workflow recipe
- New `buildPeerAgentsBlock` for listing registered agents
- Backward compatible (existing callers with only `cwd` still work)

**Acceptance Criteria**:
- [ ] Signature change is backward compatible
- [ ] Block gating respects toolConfig
- [ ] Pulse and peer agents blocks work correctly
- [ ] Relay block includes workflow recipe
- [ ] All new and existing tests pass

---

### Task 2.3: Integrate tool filtering into agent-manager sendMessage
**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1, 2.2
**Can run parallel with**: None

**Technical Requirements**:
- Load agent manifest in `sendMessage()` via `readManifest(effectiveCwd)`
- Call `resolveToolConfig` with manifest's `enabledToolGroups` and global config
- Pass `toolConfig` and `meshCore` to `buildSystemPromptAppend`
- Apply `buildAllowedTools` result to SDK `query()` options
- Add `meshCore` property to AgentManager if not present

**Acceptance Criteria**:
- [ ] Tool config resolved per-session from agent manifest
- [ ] `allowedTools` applied to SDK query
- [ ] Context builder receives tool config
- [ ] No manifest = all tools enabled (backward compatible)
- [ ] Tests verify integration

---

## Phase 3: Server: Agent-First Pulse

### Task 3.1: Add CWD resolution via agent and cascade disable on unregister
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.3, 2.1
**Can run parallel with**: None

**Technical Requirements**:
- `PulseStore.disableSchedulesByAgentId()`: disable linked schedules on agent unregister
- `SchedulerService.resolveEffectiveCwd()`: resolve CWD via MeshCore when agentId is set
- `onUnregister` callback on MeshCore for cascade pattern
- Pulse route validation: verify agentId exists in Mesh on create/update
- Failed agent resolution records a failed run

**Acceptance Criteria**:
- [ ] `disableSchedulesByAgentId` disables only enabled schedules
- [ ] `resolveEffectiveCwd` resolves via MeshCore or falls back to CWD
- [ ] Descriptive error when agent not found
- [ ] Cascade wired into Mesh unregister flow
- [ ] Pulse routes validate agentId
- [ ] All tests pass

---

## Phase 4: Client UI

### Task 4.1: Add Tool Groups section to CapabilitiesTab
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 4.2, 4.3

**Technical Requirements**:
- "Tool Groups" section in CapabilitiesTab with per-domain switches
- 3-state display: inherited (enabled/disabled), overridden (on/off)
- Reset button to clear per-agent override
- Server-disabled features show disabled switch with tooltip
- Core tools row (always enabled, no toggle)

**Acceptance Criteria**:
- [ ] Four domain toggles render
- [ ] Inherited/overridden state labels correct
- [ ] Toggle calls onUpdate with enabledToolGroups
- [ ] Reset button works
- [ ] Server-disabled features handled
- [ ] Tests cover all states

---

### Task 4.2: Move global tool defaults from AgentDialog ContextTab to SettingsDialog ToolsTab
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.2
**Can run parallel with**: Task 4.1, 4.3

**Technical Requirements**:
- Create `ToolsTab` component with global tool toggles + XML block previews
- Add "Tools" tab to SettingsDialog (6 tabs total)
- Remove "Context" tab from AgentDialog (4 tabs total)
- Clean up unused ContextTab file

**Acceptance Criteria**:
- [ ] ToolsTab created with all four toggles
- [ ] SettingsDialog has 6 tabs
- [ ] AgentDialog has 4 tabs
- [ ] Config saves work from ToolsTab
- [ ] No broken imports

---

### Task 4.3: Create useAgentToolStatus hook and update AgentContextChips
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 4.1, 4.2

**Technical Requirements**:
- `useAgentToolStatus(projectPath)` hook combining agent config + feature flags
- 3-state ChipState type: enabled, disabled-by-agent, disabled-by-server
- Update `AgentContextChips` to use hook for per-agent rendering
- enabled: normal chip, disabled-by-agent: muted + [off], disabled-by-server: hidden

**Acceptance Criteria**:
- [ ] Hook returns correct ChipState per domain
- [ ] AgentContextChips uses hook
- [ ] 3-state rendering works
- [ ] All hook and component tests pass

---

### Task 4.4: Add agent/directory toggle and AgentCombobox to CreateScheduleDialog
**Size**: Large
**Priority**: Medium
**Dependencies**: Task 1.3, 3.1
**Can run parallel with**: None

**Technical Requirements**:
- Radio group: "Run for agent" vs "Run in directory"
- AgentCombobox: searchable agent picker with color dots, icons, paths
- ScheduleRow: show agent info, warning for unresolved agents, CWD fallback
- Default target: agent if agents exist, directory otherwise

**Acceptance Criteria**:
- [ ] Radio group works
- [ ] AgentCombobox is searchable
- [ ] Form payload correct for both modes
- [ ] ScheduleRow displays all three states
- [ ] Tests pass

---

## Phase 5: Documentation & Polish

### Task 5.1: Update CLAUDE.md and contributing guides
**Size**: Medium
**Priority**: Low
**Dependencies**: All prior tasks
**Can run parallel with**: Task 5.2

**Technical Requirements**:
- CLAUDE.md: new modules, hooks, UI changes, tab counts, schema fields
- architecture.md: tool filtering data flow
- data-fetching.md: useAgentToolStatus hook pattern
- design-system.md: 3-state chip pattern

**Acceptance Criteria**:
- [ ] All documentation accurately reflects implemented code

---

### Task 5.2: Create ADRs for per-agent tool filtering and cascade disable
**Size**: Small
**Priority**: Low
**Dependencies**: Task 2.3, 3.1
**Can run parallel with**: Task 5.1

**Technical Requirements**:
- ADR: Per-Agent Tool Filtering via allowedTools
- ADR: Implicit Tool Group Hierarchy
- ADR: Cascade Disable on Agent Unregister
- Update decisions/manifest.json

**Acceptance Criteria**:
- [ ] Three ADR files created with correct frontmatter
- [ ] manifest.json updated
- [ ] Michael Nygard format followed

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 ──┐
  1.2 ──┤──> 2.1 ──> 2.2 ──> 2.3
  1.3 ──┤──────────────────────┐
        │                      v
        ├──> 4.1 (parallel) ──> 5.1
        ├──> 4.2 (parallel) ──> 5.1
        ├──> 4.3 (parallel) ──> 5.1
        │                      │
  1.3 + 3.1 ──> 4.4 ──────────> 5.1
  2.1 + 1.3 ──> 3.1 ──────────> 5.2
```

## Critical Path

1.1/1.2 -> 2.1 -> 2.2 -> 2.3 -> 5.1

## Parallel Opportunities

- Phase 1: Tasks 1.1, 1.2, 1.3 can all run in parallel
- Phase 4: Tasks 4.1, 4.2, 4.3 can run in parallel (all depend only on Phase 1)
- Phase 5: Tasks 5.1 and 5.2 can run in parallel
