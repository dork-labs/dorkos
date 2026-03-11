# Sidebar Tabbed Views -- Task Breakdown

**Spec:** `specs/sidebar-tabbed-views/02-specification.md`
**Generated:** 2026-03-10
**Mode:** Full decomposition

---

## Summary

| Phase | Name | Tasks | Sizes |
|---|---|---|---|
| 1 | Rename + State Foundation | 4 | 2 medium, 1 small, 1 medium |
| 2 | View Extraction + New Views | 5 | 1 small, 2 medium, 1 small, 1 small |
| 3 | Polish + Shortcuts + Testing | 7 | 1 small, 3 medium, 1 small, 1 small, 1 small |
| **Total** | | **16** | |

## Critical Path

```
1.1 (rename) ──┐
               ├──> 1.4 (wire tabs) ──> 2.1 (SessionsView) ──> 2.5 (remove chips) ──> 3.1 (shortcuts) ──> 3.5 (extend tests)
1.2 (store) ───┤                    ├──> 2.2 (SchedulesView) ──────────────────────┘
               │                    ├──> 2.3 (ConnectionsView) ───────────────────┘
1.3 (tab row) ─┘                    └──> 2.4 (hook) ──> 3.4 (hook tests)
```

## Parallel Opportunities

- **Phase 1:** Tasks 1.1 and 1.2 can run in parallel (no dependencies on each other)
- **Phase 2:** Tasks 2.1, 2.2, 2.3, and 2.4 can all run in parallel (all depend only on 1.4)
- **Phase 3:** Tasks 3.1, 3.2, 3.3, 3.4, 3.6, 3.7 can mostly run in parallel

---

## Phase 1: Rename + State Foundation

### 1.1 -- Rename SessionSidebar to AgentSidebar across codebase
**Size:** medium | **Priority:** high | **Dependencies:** none | **Parallel with:** 1.2

Rename the `SessionSidebar` component to `AgentSidebar` across all code files. Pure rename with zero behavioral changes.

**Files affected:**
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` -> `AgentSidebar.tsx`
- `apps/client/src/layers/features/session-list/__tests__/SessionSidebar.test.tsx` -> `AgentSidebar.test.tsx`
- `apps/client/src/layers/features/session-list/index.ts` (barrel export)
- `apps/client/src/App.tsx` (import + JSX)
- `apps/e2e/pages/SessionSidebarPage.ts` -> `AgentSidebarPage.ts`
- `apps/e2e/fixtures/index.ts` (fixture name + import)

---

### 1.2 -- Add sidebarActiveTab to Zustand app store with localStorage persistence
**Size:** small | **Priority:** high | **Dependencies:** none | **Parallel with:** 1.1

Add `sidebarActiveTab: 'sessions' | 'schedules' | 'connections'` and `setSidebarActiveTab` to the Zustand app store in `apps/client/src/layers/shared/model/app-store.ts`. Uses localStorage persistence with IIFE initialization (same pattern as `fontSize`). Include cleanup in `resetPreferences()`.

---

### 1.3 -- Create SidebarTabRow component with icon tabs and sliding indicator
**Size:** medium | **Priority:** high | **Dependencies:** 1.2 | **Parallel with:** none

New file: `apps/client/src/layers/features/session-list/ui/SidebarTabRow.tsx`

Horizontal row of three icon buttons (MessageSquare, Clock, Plug2) with:
- ARIA `role="tablist"` semantics with `role="tab"` buttons
- `aria-selected`, `aria-controls` linking to tabpanels
- Arrow key navigation between visible tabs
- `motion.div` sliding indicator with `layoutId="sidebar-tab-indicator"` (spring: stiffness 280, damping 32)
- Schedules numeric badge (pulsing ring when active)
- Connections status dot (green/amber/red/hidden)
- Tooltips with keyboard shortcut hints

---

### 1.4 -- Wire tab switching in AgentSidebar with placeholder views
**Size:** medium | **Priority:** high | **Dependencies:** 1.1, 1.2, 1.3

Insert `SidebarTabRow` between `SidebarHeader` and `SidebarContent`. Wrap existing session list in a tabpanel div. Add placeholder tabpanels for Schedules and Connections. Use CSS `hidden` class toggling via `cn(sidebarActiveTab !== 'sessions' && 'hidden')`. Add `visibleTabs` computation based on feature flags, with fallback to `'sessions'` if active tab becomes hidden.

---

## Phase 2: View Extraction + New Views

### 2.1 -- Extract SessionsView component from AgentSidebar
**Size:** small | **Priority:** high | **Dependencies:** 1.4 | **Parallel with:** 2.4

New file: `apps/client/src/layers/features/session-list/ui/SessionsView.tsx`

Pure extraction of the existing `ScrollArea` + `motion.div` + grouped session rendering into a presentation component. Props: `sessions`, `activeSessionId`, `groupedSessions`, `justCreatedId`, `onSessionClick`. Zero behavioral changes.

---

### 2.2 -- Create SchedulesView component with schedule list and empty states
**Size:** medium | **Priority:** high | **Dependencies:** 1.4 | **Parallel with:** 2.3, 2.4

New file: `apps/client/src/layers/features/session-list/ui/SchedulesView.tsx`

Read-only summary view using `useSchedules` and `useActiveRunCount` entity hooks. Layout:
- "Active" group with pulsing green dots for running schedules
- "Upcoming" group with schedule names and relative times
- Empty state: "No schedules configured"
- Disabled state: "Pulse disabled for this agent" (when `disabled-by-agent`)
- Bridge button: "Open Pulse ->" calls `setPulseOpen(true)`

---

### 2.3 -- Create ConnectionsView component with adapter and agent lists
**Size:** medium | **Priority:** high | **Dependencies:** 1.4 | **Parallel with:** 2.2, 2.4

New file: `apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`

Read-only summary view using `useRelayAdapters` and `useRegisteredAgents` entity hooks. Layout:
- "Adapters" group with color-coded status dots (green=connected, amber=idle, red=error)
- "Agents" group with online/offline indicators
- Per-section disabled states for `disabled-by-agent`
- Per-section hidden when `disabled-by-server`
- Bridge buttons: "Open Relay ->" and "Open Mesh ->"
- Empty state: "No connections configured" when both sections hidden

---

### 2.4 -- Create useConnectionsStatus derived hook
**Size:** small | **Priority:** high | **Dependencies:** 1.4 | **Parallel with:** 2.1, 2.2, 2.3

New file: `apps/client/src/layers/features/session-list/model/use-connections-status.ts`

Derives aggregate status (`'ok' | 'partial' | 'error' | 'none'`) from `useRelayAdapters` and `useRegisteredAgents` data. Feeds the Connections tab badge dot in `SidebarTabRow`. No new polling -- piggybacks on existing query caches. Replace the placeholder constant in `AgentSidebar`.

---

### 2.5 -- Remove AgentContextChips component and all references
**Size:** small | **Priority:** medium | **Dependencies:** 2.1, 2.2, 2.3

**Delete files:**
- `apps/client/src/layers/features/session-list/ui/AgentContextChips.tsx`
- `apps/client/src/layers/features/session-list/__tests__/AgentContextChips.test.tsx`

**Update files:**
- `features/session-list/index.ts` -- remove export
- `AgentSidebar.tsx` -- remove import and `<AgentContextChips />` from SidebarFooter
- `AgentSidebar.test.tsx` -- replace chip assertion with removal assertion

The Pulse badge count flow to Zustand (`setPulseBadgeCount`) stays in AgentSidebar.

---

## Phase 3: Polish + Shortcuts + Testing

### 3.1 -- Add keyboard shortcuts for tab switching
**Size:** small | **Priority:** medium | **Dependencies:** 2.5 | **Parallel with:** 3.2

Add `useEffect` in `AgentSidebar` that listens for Cmd/Ctrl + 1/2/3 to switch tabs. Only active when sidebar is open. Uses `e.preventDefault()` to override browser tab switching.

---

### 3.2 -- Write unit tests for SidebarTabRow
**Size:** medium | **Priority:** medium | **Dependencies:** 1.3 | **Parallel with:** 3.1, 3.3, 3.4

New file: `apps/client/src/layers/features/session-list/__tests__/SidebarTabRow.test.tsx`

Covers: ARIA attributes, click handling, badge rendering (0, 3, 9+), status dot colors, tab visibility filtering, arrow key navigation, `aria-controls` linking.

---

### 3.3 -- Write unit tests for SchedulesView and ConnectionsView
**Size:** medium | **Priority:** medium | **Dependencies:** 2.2, 2.3 | **Parallel with:** 3.1, 3.2, 3.4

New files:
- `apps/client/src/layers/features/session-list/__tests__/SchedulesView.test.tsx`
- `apps/client/src/layers/features/session-list/__tests__/ConnectionsView.test.tsx`

Covers: empty states, disabled states, data rendering, bridge button actions. Mocks entity hooks and app store following existing patterns.

---

### 3.4 -- Write integration test for useConnectionsStatus hook
**Size:** small | **Priority:** medium | **Dependencies:** 2.4 | **Parallel with:** 3.1, 3.2, 3.3

New file: `apps/client/src/layers/features/session-list/__tests__/use-connections-status.test.ts`

Covers: 'none' (empty + loading), 'ok', 'partial', 'error' states. Verifies error precedence over partial. Uses `renderHook` with mocked entity hooks.

---

### 3.5 -- Extend AgentSidebar tests for tab switching and keyboard shortcuts
**Size:** medium | **Priority:** medium | **Dependencies:** 2.5, 3.1 | **Parallel with:** 3.2, 3.3, 3.4

Extend existing `AgentSidebar.test.tsx` with new test cases:
- Tab switching changes visible view (CSS `hidden` toggling)
- Keyboard shortcuts (Cmd+1/2/3) fire `setSidebarActiveTab`
- Shortcuts are no-op when sidebar is closed
- AgentContextChips is NOT rendered
- Feature flag changes hide/show tabs
- Tab defaults to 'sessions' when active tab becomes hidden

---

### 3.6 -- Update E2E page objects for AgentSidebar
**Size:** small | **Priority:** low | **Dependencies:** 1.1, 1.3 | **Parallel with:** 3.1, 3.2, 3.3

Update `apps/e2e/pages/AgentSidebarPage.ts` with tab locators and methods:
- `tabList`, `sessionsTab`, `schedulesTab`, `connectionsTab` locators
- `sessionsPanel`, `schedulesPanel`, `connectionsPanel` locators
- `switchTab(name)` method
- `getActiveTab()` method

Update any E2E tests using `sessionSidebar` fixture to `agentSidebar`.

---

### 3.7 -- Update documentation for sidebar tabs and AgentSidebar rename
**Size:** small | **Priority:** low | **Dependencies:** 2.5 | **Parallel with:** 3.1, 3.2, 3.3

Update `contributing/design-system.md` with sidebar tabs section (spacing, icon sizes, badge patterns, indicator animation specs). Update `SessionSidebar` references to `AgentSidebar` in contributing docs. No new files created.
