# Task Breakdown: Agents as First-Class Entity

Generated: 2026-02-26
Source: specs/agents-first-class-entity/02-specification.md
Last Decompose: 2026-02-26

## Overview

Elevate the Agent concept from a Mesh-only abstraction to a first-class entity across all of DorkOS. After this work, agents become the primary identity users see in the sidebar, directory picker, Pulse schedules, and tab title -- regardless of whether Mesh is enabled. A dedicated Agent Settings Dialog provides configuration for identity, persona, capabilities, and cross-subsystem connections.

---

## Phase 1: Foundation

### Task 1.1: Extend AgentManifestSchema with persona, color, and icon fields

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

Add four new optional fields (`persona`, `personaEnabled`, `color`, `icon`) to `AgentManifestSchema` and `UpdateAgentRequestSchema` in `packages/shared/src/mesh-schemas.ts`. Add three new request/response schemas (`ResolveAgentsRequestSchema`, `ResolveAgentsResponseSchema`, `CreateAgentRequestSchema`) for the agent identity API endpoints.

**Acceptance Criteria**:

- [ ] AgentManifestSchema includes persona, personaEnabled, color, icon fields
- [ ] UpdateAgentRequestSchema includes persona, personaEnabled, color, icon fields
- [ ] New request/response schemas exported with types
- [ ] Schema unit tests written and passing
- [ ] `pnpm typecheck` passes

---

### Task 1.2: Extract manifest I/O to @dorkos/shared package

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

Move `readManifest()`, `writeManifest()`, `removeManifest()` and constants from `packages/mesh/src/manifest.ts` to `packages/shared/src/manifest.ts`. Update the mesh package to re-export from shared. Add `./manifest` export to shared package.json.

**Acceptance Criteria**:

- [ ] `packages/shared/src/manifest.ts` contains all manifest I/O functions
- [ ] `packages/shared/package.json` exports `./manifest`
- [ ] `packages/mesh/src/manifest.ts` re-exports from `@dorkos/shared/manifest`
- [ ] Existing Mesh imports still work
- [ ] Unit tests in shared package written and passing
- [ ] `pnpm build` and `pnpm typecheck` pass

---

### Task 1.3: Create /api/agents routes for agent identity CRUD

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 1.4

Create `apps/server/src/routes/agents.ts` with four endpoints: GET /current, POST /resolve, POST /, PATCH /current. Always mounted (no feature flag). Uses shared manifest module and boundary validation. Mount in app.ts.

**Acceptance Criteria**:

- [ ] GET /api/agents/current returns manifest or 404
- [ ] POST /api/agents/resolve batch-resolves up to 20 paths
- [ ] POST /api/agents creates agent with ULID id
- [ ] PATCH /api/agents/current updates existing agent
- [ ] All endpoints enforce directory boundary
- [ ] Unit tests written and passing

---

### Task 1.4: Add agent identity methods to Transport interface and adapters

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 1.3

Add `getAgentByPath`, `resolveAgents`, `createAgent`, `updateAgentByPath` to the Transport interface. Implement in HttpTransport (HTTP calls) and DirectTransport (direct manifest I/O). Update mock transport in test-utils.

**Acceptance Criteria**:

- [ ] Transport interface includes four new methods
- [ ] HttpTransport implements with correct HTTP calls
- [ ] DirectTransport implements with direct manifest I/O
- [ ] Mock transport updated
- [ ] `pnpm typecheck` passes

---

### Task 1.5: Add persona injection to context-builder

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 1.3, Task 1.4, Task 1.6

Add `buildAgentBlock()` to `apps/server/src/services/core/context-builder.ts`. Reads `.dork/agent.json` via shared manifest module and injects `<agent_identity>` (always) and `<agent_persona>` (when enabled and non-empty) XML blocks into the system prompt.

**Acceptance Criteria**:

- [ ] Identity block always included when manifest exists
- [ ] Persona block only included when enabled AND non-empty
- [ ] Runs in parallel with env/git blocks via Promise.allSettled
- [ ] Never throws
- [ ] Unit tests written and passing

---

### Task 1.6: Add agent_get_current MCP tool

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.2
**Can run parallel with**: Task 1.3, Task 1.4, Task 1.5

Add `agent_get_current` tool to `apps/server/src/services/core/mcp-tool-server.ts`. Always available (not behind feature flag). Returns agent manifest for the current working directory or null.

**Acceptance Criteria**:

- [ ] Tool registered and not behind any feature flag
- [ ] Returns manifest or null with message
- [ ] `pnpm typecheck` passes

---

### Task 1.7: Add database migration for new agent manifest fields

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.2, Task 1.3

Add `persona`, `persona_enabled`, `color`, `icon` columns to the agents table. Create Drizzle migration. Update AgentRegistry methods to handle new fields.

**Acceptance Criteria**:

- [ ] Schema includes new columns with correct types and defaults
- [ ] Migration runs without error on existing databases
- [ ] AgentRegistry upsert/update/get/list handle new fields
- [ ] Existing Mesh tests pass
- [ ] `pnpm build` passes

---

## Phase 2: Entity Layer & Sidebar

### Task 2.1: Create entities/agent FSD layer with query hooks

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3, Task 1.4
**Can run parallel with**: None

Create `apps/client/src/layers/entities/agent/` with TanStack Query hooks: `useCurrentAgent`, `useCreateAgent`, `useUpdateAgent`, `useResolvedAgents`, `useAgentVisual`. Query key factory in `api/queries.ts`. Barrel exports in `index.ts`.

**Acceptance Criteria**:

- [ ] All five hooks created and functional
- [ ] useUpdateAgent implements optimistic updates with rollback
- [ ] useAgentVisual implements 3-tier priority (override > hash from id > hash from cwd)
- [ ] Barrel exports all public hooks and types
- [ ] FSD layer rules respected
- [ ] `pnpm typecheck` passes

---

### Task 2.2: Create AgentHeader component for sidebar

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Task 2.3

Create `AgentHeader` component showing agent identity (colored dot, emoji, name, description, gear icon) or directory path with "+ Agent" CTA. Replace current breadcrumb area in SessionSidebar. Quick create flow: create agent then open dialog.

**Acceptance Criteria**:

- [ ] Shows agent identity when agent registered
- [ ] Shows folder + path + "+ Agent" when no agent
- [ ] Quick create flow works
- [ ] Integrated into SessionSidebar
- [ ] Component tests written and passing

---

### Task 2.3: Integrate agent identity into favicon and tab title

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.1
**Can run parallel with**: Task 2.2

Update favicon and tab title to reflect agent identity. Favicon uses agent color (override or hash from agent.id). Tab title shows `[emoji] AgentName -- DorkOS`. Badge count prefix preserved.

**Acceptance Criteria**:

- [ ] Favicon reflects agent color when agent exists
- [ ] Tab title shows agent emoji + name
- [ ] CWD-based behavior preserved when no agent
- [ ] Badge count prefix preserved
- [ ] `pnpm typecheck` passes

---

## Phase 3: Agent Dialog

### Task 3.1: Create AgentDialog shell with Identity tab

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: None

Create `features/agent-settings/` with AgentDialog (ResponsiveDialog + Tabs), IdentityTab (name, description, color palette, emoji grid, runtime dropdown, read-only CWD), and Zustand dialog state. Color picker shows 10 presets with Reset. Emoji picker shows 30-emoji EMOJI_SET grid with Reset.

**Acceptance Criteria**:

- [ ] AgentDialog renders with 4 tabs
- [ ] Identity tab has all fields working
- [ ] Color and emoji pickers with Reset buttons
- [ ] Zustand store manages dialog state
- [ ] Component tests written and passing
- [ ] FSD layer rules respected

---

### Task 3.2: Implement Persona tab with live preview

**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: Task 3.3

Create PersonaTab with persona textarea (monospace, 8-10 rows, 4000 char max), enabled toggle, character count, and live XML preview matching context-builder output. Textarea disabled when toggle off.

**Acceptance Criteria**:

- [ ] Toggle controls personaEnabled
- [ ] Textarea disabled when off
- [ ] Character count updates live
- [ ] Preview matches context-builder XML format
- [ ] Component tests written and passing

---

### Task 3.3: Implement Capabilities and Connections tabs

**Size**: Large
**Priority**: Medium
**Dependencies**: Task 3.1
**Can run parallel with**: Task 3.2

Create CapabilitiesTab (tag/chip input for capabilities, namespace, response mode, budget fields) and ConnectionsTab (read-mostly view of Pulse schedules, Relay endpoints, Mesh health). Connections tab gracefully hides sections when subsystems disabled.

**Acceptance Criteria**:

- [ ] Capabilities tab with tag input (Enter/comma to add, X to remove)
- [ ] Namespace, response mode, budget fields editable
- [ ] Connections tab shows subsystem sections with empty states
- [ ] Sections hide when subsystems disabled
- [ ] Component tests written and passing

---

## Phase 4: Surface Integration

### Task 4.1: Enhance DirectoryPicker to show agent identity in recents

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.1
**Can run parallel with**: Task 4.2

Add optional `resolvedAgents` prop to DirectoryPicker. Parent component resolves agents via `useResolvedAgents` (batch POST /api/agents/resolve) and passes down. Recent items show agent identity (dot, emoji, name) for registered dirs, folder icon for others.

**Acceptance Criteria**:

- [ ] DirectoryPicker accepts resolvedAgents prop
- [ ] Agent identity shown in recents for registered dirs
- [ ] No FSD layer violations
- [ ] Existing behavior unchanged when prop not provided
- [ ] Component tests written and passing

---

### Task 4.2: Add agent identity display to Pulse schedule rows

**Size**: Small
**Priority**: Low
**Dependencies**: Task 2.1
**Can run parallel with**: Task 4.1

Update PulsePanel to batch-resolve agents for schedule CWDs. ScheduleRow shows agent identity when available. CreateScheduleDialog shows agent identity after CWD selection.

**Acceptance Criteria**:

- [ ] ScheduleRow shows agent name, dot, emoji when available
- [ ] PulsePanel batch-resolves agents
- [ ] CreateScheduleDialog shows agent identity
- [ ] Existing Pulse functionality unchanged

---

### Task 4.3: Update documentation for agent identity feature

**Size**: Small
**Priority**: Low
**Dependencies**: Task 3.1, Task 3.2, Task 3.3, Task 4.1, Task 4.2
**Can run parallel with**: None

Update `contributing/architecture.md`, `contributing/data-fetching.md`, and `AGENTS.md` to reflect new FSD layers, route groups, Transport methods, and query key patterns.

**Acceptance Criteria**:

- [ ] Architecture docs include agent entity and agent-settings feature
- [ ] Data fetching docs include agent query key patterns
- [ ] AGENTS.md updated with all new modules and routes
- [ ] All documentation accurate and consistent
