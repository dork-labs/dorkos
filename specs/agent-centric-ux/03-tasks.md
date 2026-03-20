# Task Breakdown: Agent-Centric UX

Generated: 2026-03-03
Source: specs/agent-centric-ux/02-specification.md
Last Decompose: 2026-03-03

## Overview

Redesign DorkOS UX to put agents at the center of everything. Three connected changes: (1) a global Command Palette (Cmd+K) using the existing Shadcn Command component for agent switching and feature access, (2) a full agent-centric sidebar redesign where agents are the primary organizational unit, and (3) making Mesh always-on by removing the `DORKOS_MESH_ENABLED` feature flag.

## Dependency Graph

```
Phase 1: Mesh Always-On
  1.1 Remove server feature flag  ─┐
  1.2 Remove client feature flag  ─┤ (parallel)
                                    │
Phase 2: Command Palette Foundation │
  2.1 App-store state + Cmd+K     ←┘ ─┐
  2.2 Frecency hook               ←┘ ─┤ (parallel)
                                       │
Phase 3: Command Palette UI            │
  3.1 AgentCommandItem            ←2.1 ─┐
  3.2 usePaletteItems             ←2.1,2.2 ─┤ (parallel)
  3.3 CommandPaletteDialog + mount ←3.1,3.2  │
                                              │
Phase 4: Agent-Centric Sidebar                │
  4.1 AgentHeader redesign         ←3.3      │
                                              │
Phase 5: Polish & Docs                        │
  5.1 Update docs                  ←4.1 ─┐
  5.2 Integration tests            ←4.1 ─┤ (parallel)
```

## Phase 1: Mesh Always-On

### Task 1.1: Remove DORKOS_MESH_ENABLED env var and server feature flag

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- Remove `DORKOS_MESH_ENABLED` from `apps/server/src/env.ts` Zod schema
- Remove conditional MeshCore initialization in `apps/server/src/index.ts` — make it unconditional
- Hard-code `isMeshEnabled()` to return `true` in `apps/server/src/services/mesh/mesh-state.ts` (Option A — keep file for init error reporting)
- Always return `mesh.enabled: true` in `apps/server/src/routes/config.ts`
- Remove `enabled` field from mesh config in `packages/shared/src/config-schema.ts`
- Remove `DORKOS_MESH_ENABLED` from `.env.example` and `turbo.json` globalPassThroughEnv
- Update server tests: remove DORKOS_MESH_ENABLED test cases from env.test.ts, mcp-mesh-tools.test.ts

**Acceptance Criteria**:

- [ ] Server starts without `DORKOS_MESH_ENABLED` env var and MeshCore initializes successfully
- [ ] `GET /api/config` returns `{ mesh: { enabled: true } }` always
- [ ] Mesh routes always mounted when MeshCore init succeeds
- [ ] MeshCore init failures are non-fatal; `initError` is reported
- [ ] No references to `DORKOS_MESH_ENABLED` remain in server code
- [ ] Existing mesh tests pass
- [ ] `pnpm typecheck` passes

---

### Task 1.2: Remove Mesh feature flag from client code

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- `useMeshEnabled()` returns `true` unconditionally in `entities/mesh/model/use-mesh-config.ts`
- Remove `'mesh'` from `Subsystem` type in `shared/model/use-feature-enabled.ts`
- Remove `meshEnabled` checks from: SessionSidebar (footer icon dimming), MeshPanel (FeatureDisabledState gate), MeshStatsHeader (early return null), ConnectionsTab ("Enable Mesh" prompt)
- Update tests: MeshPanel.test.tsx (remove disabled state tests), MeshStatsHeader.test.tsx (remove disabled test), mesh-hooks.test.tsx (remove useMeshEnabled test)

**Acceptance Criteria**:

- [ ] `useMeshEnabled()` returns `true` unconditionally
- [ ] MeshPanel renders without feature-disabled gate
- [ ] MeshStatsHeader renders without enabled check
- [ ] SessionSidebar Mesh footer icon always active
- [ ] All mesh UI tests pass
- [ ] `pnpm typecheck` passes

---

## Phase 2: Command Palette Foundation

### Task 2.1: Add globalPaletteOpen state to Zustand app-store and Cmd+K binding

**Size**: Small
**Priority**: High
**Dependencies**: 1.1, 1.2
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Add `globalPaletteOpen`, `setGlobalPaletteOpen`, `toggleGlobalPalette` to Zustand `AppState` interface and implementation
- Create `features/command-palette/model/use-global-palette.ts` hook: registers `Cmd+K`/`Ctrl+K` keydown listener, closes open ResponsiveDialogs before opening palette
- Follows existing `Cmd+B` sidebar toggle pattern in App.tsx

**Acceptance Criteria**:

- [ ] `globalPaletteOpen` boolean in Zustand store
- [ ] Cmd+K / Ctrl+K toggles the palette state
- [ ] Opening palette closes Settings, Pulse, Relay, Mesh dialogs
- [ ] Hook test verifies keyboard binding
- [ ] `pnpm typecheck` passes

---

### Task 2.2: Create useAgentFrecency hook for localStorage frecency tracking

**Size**: Medium
**Priority**: High
**Dependencies**: 1.1, 1.2
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Create `features/command-palette/model/use-agent-frecency.ts`
- localStorage key: `dorkos-agent-frecency`
- Score formula: `useCount / (1 + hoursSinceUse * 0.1)`
- `recordUsage(agentId)` — creates/increments entry
- `getSortedAgentIds(allIds)` — returns frecency-sorted, alphabetical fallback for untracked
- Prune entries older than 30 days; max 50 entries
- Uses `useSyncExternalStore` for reactivity
- Graceful degradation when localStorage unavailable

**Acceptance Criteria**:

- [ ] Hook returns `{ entries, recordUsage, getSortedAgentIds }`
- [ ] Frecency scoring works correctly
- [ ] Pruning and max entries enforced
- [ ] localStorage persistence verified
- [ ] All tests pass

---

## Phase 3: Command Palette UI

### Task 3.1: Create AgentCommandItem component for agent rows in the palette

**Size**: Small
**Priority**: High
**Dependencies**: 2.1
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- Create `features/command-palette/ui/AgentCommandItem.tsx`
- Renders: colored dot (via `useAgentVisual`), emoji, bold agent name, abbreviated path (via `shortenHomePath`), checkmark on active agent
- Optional description line in muted text
- `keywords` prop includes projectPath, description, id for fuzzy search
- Active agent uses `forceMount` to always show

**Acceptance Criteria**:

- [ ] Renders colored dot, emoji, name, path, checkmark
- [ ] Description shown when available
- [ ] Keywords enable fuzzy search by path and description
- [ ] Active agent force-mounted
- [ ] Tests pass

---

### Task 3.2: Create usePaletteItems hook to assemble all command palette content groups

**Size**: Medium
**Priority**: High
**Dependencies**: 2.1, 2.2
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- Create `features/command-palette/model/use-palette-items.ts`
- Assembles 5 groups: Recent Agents (max 5, frecency-sorted, active pinned first), All Agents (from mesh), Features (Pulse/Relay/Mesh/Settings), Commands (from `useCommands()`), Quick Actions (New Session/Discover/Browse/Theme)
- Returns `{ recentAgents, allAgents, features, commands, quickActions, isLoading }`

**Acceptance Criteria**:

- [ ] All 5 content groups returned correctly
- [ ] Recent agents: max 5, frecency-sorted, active pinned
- [ ] Loading state reflects mesh query
- [ ] Tests pass

---

### Task 3.3: Create CommandPaletteDialog component and mount in App.tsx

**Size**: Large
**Priority**: High
**Dependencies**: 3.1, 3.2
**Can run parallel with**: None

**Technical Requirements**:

- Create `features/command-palette/ui/CommandPaletteDialog.tsx` — wraps Shadcn Command inside ResponsiveDialog
- Renders all 5 content groups with conditional visibility based on `@` prefix and search state
- Agent selection: records frecency, sets dir, closes palette
- Feature selection: opens corresponding ResponsiveDialog
- Quick actions: New Session, Discover Agents, Browse Filesystem, Toggle Theme
- Cmd+Click opens agent in new tab via `window.open()`
- Create barrel `features/command-palette/index.ts`
- Mount `CommandPaletteDialog` in `App.tsx` at root level alongside Toaster

**Acceptance Criteria**:

- [ ] Dialog renders via ResponsiveDialog (Dialog on desktop, Drawer on mobile)
- [ ] All content groups render in correct order
- [ ] `@` prefix mode shows only agents
- [ ] Agent selection switches directory and closes palette
- [ ] Feature selection opens dialogs
- [ ] Cmd+Click opens new tab
- [ ] Mounted in App.tsx
- [ ] Tests pass

---

## Phase 4: Agent-Centric Sidebar

### Task 4.1: Redesign AgentHeader with prominent card layout and palette trigger

**Size**: Medium
**Priority**: High
**Dependencies**: 3.3
**Can run parallel with**: None

**Technical Requirements**:

- Redesign `AgentHeader.tsx` — prominent card-like layout with more vertical space
- Registered agent: colored dot (larger), emoji, bold name, description, abbreviated path, "Switch" button with Cmd+K hint, gear icon
- Unregistered directory: folder icon + path + "+Agent" CTA + Switch button
- Mobile: tapping agent identity area opens command palette; desktop: opens agent dialog
- Switch button calls `setGlobalPaletteOpen(true)`, Cmd+K hint hidden on mobile via `useIsMobile()`
- Change "New Chat" to "New Session" in SessionSidebar
- Update AgentHeader and SessionSidebar tests

**Acceptance Criteria**:

- [ ] Registered agent shows prominent card with all elements
- [ ] Switch button triggers palette
- [ ] Mobile tap behavior differs from desktop
- [ ] "New Chat" changed to "New Session"
- [ ] All tests updated and pass

---

## Phase 5: Polish and Documentation

### Task 5.1: Update keyboard shortcuts docs and CLAUDE.md references

**Size**: Small
**Priority**: Medium
**Dependencies**: 4.1
**Can run parallel with**: Task 5.2

**Technical Requirements**:

- Add `Cmd+K` / `Ctrl+K` -> "Open command palette" to `contributing/keyboard-shortcuts.md`
- Add `features/command-palette/` to the FSD layers table in CLAUDE.md
- Remove all `DORKOS_MESH_ENABLED` references from CLAUDE.md
- Update Mesh descriptions to note it's always-on
- Update mesh-state.ts description

**Acceptance Criteria**:

- [ ] Keyboard shortcut documented
- [ ] FSD layers table updated
- [ ] No stale DORKOS_MESH_ENABLED references in docs

---

### Task 5.2: Write integration tests for command palette agent switching flow

**Size**: Medium
**Priority**: Medium
**Dependencies**: 4.1
**Can run parallel with**: Task 5.1

**Technical Requirements**:

- Create `features/command-palette/__tests__/command-palette-integration.test.tsx`
- Test full flow: open palette -> select agent -> dir changes -> palette closes
- Test `@` prefix mode filtering
- Test feature dialog opening from palette
- Test frecency ordering in recent agents
- Test mesh data loads without feature flag
- Use mock transport and query client providers

**Acceptance Criteria**:

- [ ] Full agent switching flow tested end-to-end
- [ ] `@` prefix filtering verified
- [ ] Feature dialog opening verified
- [ ] Frecency ordering verified
- [ ] All tests pass
