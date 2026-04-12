# Task Breakdown: Unified Agent Hub -- Agent Profile Panel

Generated: 2026-04-12
Source: specs/unified-agent-hub/02-specification.md
Last Decompose: 2026-04-12

## Overview

The Unified Agent Hub consolidates all agent-specific configuration and activity surfaces (AgentDialog modal, agent-scoped SessionSidebar content) into a single right-panel component. It registers as a `right-panel` contribution via the extension registry and contains six tabs: Overview, Personality, Sessions, Channels, Tasks, and Tools. Four entry points lead to the same destination: the AgentIdentity chip (primary), context menu ("Agent profile"), a keyboard shortcut (`Cmd+Shift+A`), and the command palette.

---

## Phase 1: Foundation

### Task 1.1: Create agent-hub feature module with store and context

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- Create `apps/client/src/layers/features/agent-hub/` FSD feature module
- Implement `agent-hub-store.ts` -- feature-local Zustand store with `activeTab`, `agentPath`, `openHub` actions
- Implement `agent-hub-context.tsx` -- React context mirroring `AgentDialogContextValue` interface
- Create barrel `index.ts` with all public exports

**Implementation Steps**:

1. Create directory structure: `model/`, `ui/`, `__tests__/`, `index.ts`
2. Implement `useAgentHubStore` with devtools middleware, `AgentHubTab` type union
3. Implement `AgentHubProvider` and `useAgentHubContext` with throw-on-missing-provider guard
4. Export all public symbols from barrel

**Acceptance Criteria**:

- [ ] Store has `activeTab`, `setActiveTab`, `agentPath`, `setAgentPath`, `openHub` actions
- [ ] Context mirrors `AgentDialogContextValue` shape
- [ ] `useAgentHubContext` throws outside provider
- [ ] `openHub(path)` defaults to `'overview'` tab
- [ ] TypeScript compiles, no FSD violations

---

### Task 1.2: Add AGENT_PROFILE keyboard shortcut definition

**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- Add `AGENT_PROFILE` entry to `SHORTCUTS` in `apps/client/src/layers/shared/lib/shortcuts.ts`
- Key: `mod+shift+a`, group: `navigation`, label: `Agent profile`
- No conflicts with existing shortcuts

**Implementation Steps**:

1. Add shortcut definition after `SHORTCUTS_PANEL` in the Navigation group
2. Update any snapshot/count assertions in `shortcuts.test.ts`

**Acceptance Criteria**:

- [ ] `SHORTCUTS.AGENT_PROFILE` exists with correct id, key, label, group
- [ ] `formatShortcutKey` produces correct platform-specific display
- [ ] No conflicts with existing shortcuts
- [ ] Existing tests pass

---

## Phase 2: Core Features

### Task 2.1: Build hub shell components and register as right-panel contribution

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Build `AgentHub.tsx` (shell with provider, data fetching, empty states)
- Build `AgentHubHeader.tsx` (agent avatar + name + close button)
- Build `AgentHubNav.tsx` (left-nav with 6 tabs, icons, active highlighting)
- Build `AgentHubContent.tsx` (lazy tab panel switcher)
- Build `NoAgentSelected.tsx` and `AgentNotFound.tsx` empty states
- Create 6 placeholder tab files in `ui/tabs/`
- Register as `right-panel` contribution in `init-extensions.ts`

**Implementation Steps**:

1. Create all component files in `agent-hub/ui/`
2. Implement `AgentHub` with `useCurrentAgent` data fetching and 3-state rendering
3. Implement nav with Lucide icons: User, Sparkles, MessageSquare, Radio, Clock, Wrench
4. Implement content switcher with `React.lazy` imports for all 6 tabs
5. Register in `init-extensions.ts` with `register('right-panel', { id: 'agent-hub', ... })`
6. Add `AgentHub` to barrel exports

**Acceptance Criteria**:

- [ ] Hub renders with agent data, shows empty states appropriately
- [ ] Nav renders 6 tabs with active highlighting and `aria-current`
- [ ] Tab clicks update active tab via hub store
- [ ] Hub appears in right panel tab bar
- [ ] TypeScript compiles, no FSD violations

---

### Task 2.2: Implement hub tab wrappers for all six tabs

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: None

**Technical Requirements**:

- Replace placeholder tabs with thin wrappers reading from `AgentHubProvider`
- OverviewTab: compose `IdentityTab` + recent sessions from `OverviewTabPanel`
- PersonalityTab: delegate to `PersonalityTab` from agent-settings
- SessionsTab: wrap `SessionsView` with data fetching hooks
- ChannelsTab: delegate to `ChannelsTab` from agent-settings
- TasksTab: wrap `TasksView` with derived props
- ToolsTab: delegate to `ToolsTab` from agent-settings
- Add necessary exports to `agent-settings/index.ts` and `session-list/index.ts`

**Implementation Steps**:

1. Read existing tab component prop signatures
2. Ensure tab components are exported from feature barrels
3. Implement each wrapper reading from `useAgentHubContext()`
4. Verify FSD compliance (UI composition only, no model/hook cross-imports)

**Acceptance Criteria**:

- [ ] All 6 tabs delegate to existing implementations
- [ ] Each reads data from AgentHubProvider context
- [ ] Feature parity with AgentDialog and SessionSidebar tabs
- [ ] No FSD model/hook cross-imports

---

### Task 2.3: Make AgentIdentity chip interactive with onClick and tooltip

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Add optional `onClick` prop to `AgentIdentityProps`
- When provided: wrap content in `<button>` + `<Tooltip>` showing "Agent profile"
- When absent: remain purely presentational (backwards compatible)
- Button has `hover:opacity-80` transition

**Implementation Steps**:

1. Add `onClick` prop to interface
2. Extract `content` JSX into a variable
3. Conditionally wrap in `<Tooltip>` + `<button>` when `onClick` provided
4. Import `Tooltip`, `TooltipTrigger`, `TooltipContent` from shared/ui
5. Update tests for both interactive and non-interactive states

**Acceptance Criteria**:

- [ ] Non-interactive: renders `<span>`, no button role
- [ ] Interactive: renders `<button>` with tooltip "Agent profile"
- [ ] Click fires callback
- [ ] Layout unbroken by button wrapper
- [ ] Existing tests pass, new tests cover both states

---

## Phase 3: Integration & Polish

### Task 3.1: Wire entry points -- identity chip, context menu, and dashboard sidebar

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1, Task 2.3
**Can run parallel with**: Task 3.2, Task 3.3

**Technical Requirements**:

- Replace `onManage` + `onEditSettings` with `onOpenProfile` in `AgentContextMenu`
- Simplify menu: Pin/Unpin, Agent profile (User icon), New session
- Update `AgentListItem` dropdown to match
- Replace `handleManage` + `handleEditSettings` with `handleOpenProfile` in `DashboardSidebar`
- Wire `onClick` on AgentIdentity chips in 5+ callsites

**Implementation Steps**:

1. Update `AgentContextMenu.tsx` props and menu items
2. Update `AgentListItem.tsx` dropdown and AgentIdentity onClick
3. Update `DashboardSidebar.tsx` callbacks
4. Wire onClick in ChatStatusSection, ConversationRow, AgentCard, ExistingAgentCard
5. Update DashboardSidebar tests

**Acceptance Criteria**:

- [ ] Context menu shows "Agent profile" instead of "Manage agent" + "Edit settings"
- [ ] All identity chip clicks open hub in right panel
- [ ] DashboardSidebar uses single `handleOpenProfile` callback
- [ ] All affected tests pass

---

### Task 3.2: Add command palette and keyboard shortcut entry points

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.2, Task 2.1
**Can run parallel with**: Task 3.1, Task 3.3

**Technical Requirements**:

- Add "Agent Profile" to `PALETTE_FEATURES` (priority 5, action: `openAgentProfile`)
- Implement `openAgentProfile` action handler
- Implement `AGENT_PROFILE` shortcut handler with toggle behavior
- Add "Agent profile" to agent sub-menu in command palette (if exists)

**Implementation Steps**:

1. Add contribution to `palette-contributions.ts`
2. Add action handler in palette action switch
3. Implement shortcut handler: toggle on/off based on current panel state
4. Add agent sub-menu item if applicable

**Acceptance Criteria**:

- [ ] "Agent Profile" appears in palette Features group
- [ ] Selecting it opens hub for current agent
- [ ] `Cmd+Shift+A` toggles hub (open if closed, close if already open for same agent)
- [ ] Shortcut only fires when agent is selected

---

### Task 3.3: Disambiguate global settings with App Settings label and tooltip

**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Task 3.1, Task 3.2

**Technical Requirements**:

- Change settings button label to "App Settings" in sidebar contributions
- Add tooltip to settings button in `SidebarFooterBar.tsx`
- Change Settings dialog title to "App Settings"

**Implementation Steps**:

1. Update label in sidebar footer contributions
2. Wrap settings button in `<Tooltip>` in `SidebarFooterBar.tsx`
3. Update dialog title in `SettingsDialog.tsx`
4. Update affected tests

**Acceptance Criteria**:

- [ ] Gear icon aria-label and tooltip read "App Settings"
- [ ] Settings dialog title reads "App Settings"
- [ ] All affected tests pass

---

### Task 3.4: Implement deep-link migration from old agent dialog URL params

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.1
**Can run parallel with**: Task 3.1, Task 3.2, Task 3.3

**Technical Requirements**:

- Create `useAgentHubDeepLink` hook reading `?panel=agent-hub&hubTab=...&agentPath=...`
- Create redirect guard mapping old `?agent=identity` to new `?panel=agent-hub&hubTab=overview`
- Tab migration map: identity->overview, personality->personality, channels->channels, tools->tools
- Also redirect `?dialog=agent` to `?panel=agent-hub`
- Use `replace: true` to avoid polluting browser history

**Implementation Steps**:

1. Create `use-agent-hub-deep-link.ts` with URL param reading
2. Create redirect effect for old params
3. Integrate deep-link reading into AgentHub component
4. Export hook from barrel

**Acceptance Criteria**:

- [ ] New deep-link format works: `?panel=agent-hub&hubTab=personality&agentPath=/foo`
- [ ] Old URLs redirect correctly with `replace: true`
- [ ] Invalid hubTab falls back to `'overview'`
- [ ] agentPath preserved during redirect

---

### Task 3.5: Remove AgentDialog and clean up obsolete code

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.2, Task 3.1, Task 3.4
**Can run parallel with**: None

**Technical Requirements**:

- Delete 10 files: AgentDialog, 4 consumer wrappers, NoAgentFallback, agent-dialog-context, use-agent-dialog, AgentDialog test, AgentDialogWrapper
- Remove `agent` entry from `DIALOG_CONTRIBUTIONS`
- Remove `agentDialogOpen`, `agentDialogInitialTab`, `setAgentDialogOpen`, `openAgentDialogToTab` from PanelsSlice
- Remove `'agent'` from `DialogContribution.urlParam` type
- Update `agent-settings/index.ts` to export tab components instead of AgentDialog
- Remove `useAgentDialogDeepLink` and `useOpenAgentDialog` from deep-link hooks
- Streamline `SessionSidebar` -- remove OverviewTabPanel, ConnectionsView, TasksView, SidebarTabRow
- Fix all broken references across the codebase

**Implementation Steps**:

1. Delete the 10 files
2. Update dialog-contributions, PanelsSlice, extension-registry types
3. Update agent-settings barrel exports
4. Update shared model barrel exports
5. Clean up deep-link hooks
6. Streamline SessionSidebar
7. Search and fix all remaining references
8. Verify `pnpm build` succeeds

**Acceptance Criteria**:

- [ ] All 10 files deleted
- [ ] PanelsSlice has no agent dialog fields
- [ ] SessionSidebar shows only session list + header
- [ ] No import errors across entire codebase
- [ ] `pnpm build` succeeds
- [ ] Old URLs redirect via migration (task 3.4)

---

## Phase 4: Testing

### Task 4.1: Write hub shell and navigation unit tests

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Task 4.2

**Technical Requirements**:

- Test `AgentHub` in 3 states: no agent, agent not found, agent loaded
- Test hub store agentPath priority over selectedCwd
- Test `AgentHubNav`: 6 tabs render, active highlighting, click callbacks
- Test `useAgentHubStore`: all actions

**Acceptance Criteria**:

- [ ] AgentHub.test.tsx: 4+ test cases covering all states
- [ ] AgentHubNav.test.tsx: tab rendering, highlighting, clicks
- [ ] agent-hub-store.test.ts: store action tests
- [ ] All tests pass with `pnpm vitest run`

---

### Task 4.2: Write entry point and integration tests

**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1, Task 3.3, Task 3.4
**Can run parallel with**: Task 4.1

**Technical Requirements**:

- Test identity chip click fires onClick callback
- Test context menu shows "Agent profile", not "Manage agent"/"Edit settings"
- Test settings disambiguation: "App Settings" aria-label and dialog title
- Test deep-link migration: old URL params redirect to new format

**Acceptance Criteria**:

- [ ] Entry point tests verify chip click behavior
- [ ] Context menu tests verify menu simplification
- [ ] Settings tests verify "App Settings" labels
- [ ] Deep-link tests verify redirect logic
- [ ] All tests pass

---

### Task 4.3: Write tab migration parity tests

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.2, Task 3.5
**Can run parallel with**: Task 4.1, Task 4.2

**Technical Requirements**:

- Verify each tab renders same key elements within `AgentHubProvider` context
- PersonalityTab: trait sliders, convention editors, response mode
- ChannelsTab: 4 states (relay off, no adapters, no bindings, bindings exist)
- ToolsTab: tool groups, MCP servers, safety limits
- SessionsTab: grouped session list
- TasksTab: running/upcoming/recent sections
- OverviewTab: identity fields

**Acceptance Criteria**:

- [ ] Parity tests for all 6 tabs
- [ ] All use `AgentHubProvider` wrapper
- [ ] All tests pass with `pnpm vitest run`

---

## Dependency Graph

```
Phase 1 (Foundation):
  1.1 ─┐
       ├── 2.1 ── 2.2 ── 3.5
  1.2 ─┤         ╱
       ├── 3.2 ─╱
       │
  1.1 ── 2.3 ── 3.1 ── 3.5
                │
  (none) ── 3.3 (parallel)
  2.1 ── 3.4 ── 3.5

Phase 4 (Testing):
  2.1 ── 4.1
  3.1 + 3.3 + 3.4 ── 4.2
  2.2 + 3.5 ── 4.3
```

## Critical Path

1.1 -> 2.1 -> 2.2 -> 3.5 (then 4.3)

## Parallel Opportunities

- Tasks 1.1 and 1.2 can run in parallel (no dependencies)
- Tasks 2.3 can run in parallel with 2.1 (both depend only on 1.1)
- Tasks 3.1, 3.2, 3.3, and 3.4 can all run in parallel
- Tasks 4.1 and 4.2 can run in parallel
