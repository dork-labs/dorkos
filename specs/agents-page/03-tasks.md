# Agents Page — Task Breakdown

**Spec:** `specs/agents-page/02-specification.md`
**Generated:** 2026-03-20
**Mode:** Full decomposition

---

## Phase 1: Core Components

Pure feature components with no routing dependency. All tasks in this phase can be developed in parallel (except 1.4 and 1.5 which depend on the others).

### Task 1.1 — Create AgentRow expandable list row component

**Size:** Large | **Priority:** High | **Parallel with:** 1.2, 1.3

Dense expandable agent row using `Collapsible` from shared/ui. Collapsed state (~56px) shows health dot, name, runtime badge, truncated path, session count, capability badges (max 3 + overflow), last active timestamp, session launch button, and expand chevron. Expanded state reveals full description, all capabilities, behavior config, budget limits, registration info, namespace, edit button (opens AgentDialog), and unregister button (with confirmation).

**Files:**

- `features/agents-list/ui/AgentRow.tsx` (new)
- `features/agents-list/__tests__/AgentRow.test.tsx` (new — 7 test cases)

---

### Task 1.2 — Create AgentFilterBar search and filter component

**Size:** Medium | **Priority:** High | **Parallel with:** 1.1, 1.3

Filter bar with search input (instant filtering on name/description/capabilities), mutually exclusive status chips (All/Active/Inactive/Stale), namespace dropdown (only when >1 namespace), live result count, and group-by-namespace toggle. All filtering is client-side via `useMemo`.

**Files:**

- `features/agents-list/ui/AgentFilterBar.tsx` (new)
- `features/agents-list/__tests__/AgentFilterBar.test.tsx` (new — 7 test cases)

---

### Task 1.3 — Create SessionLaunchPopover for agent session management

**Size:** Medium | **Priority:** High | **Parallel with:** 1.1, 1.2

Two-mode component: when no active sessions, renders a plain "Start Session" button that navigates to `/session?dir={projectPath}`; when active sessions exist, renders a "Open Session" popover listing sessions with resume and "New Session" options. Uses `useSessions()` filtered by agent project path.

**Files:**

- `features/agents-list/ui/SessionLaunchPopover.tsx` (new)
- `features/agents-list/__tests__/SessionLaunchPopover.test.tsx` (new — 6 test cases)

---

### Task 1.4 — Create AgentsList container with namespace grouping

**Size:** Medium | **Priority:** High | **Depends on:** 1.1, 1.2, 1.3

List container that integrates AgentFilterBar and renders AgentRow components. Supports namespace grouping (auto-enabled when >1 namespace), loading skeleton state (3 placeholder rows), and stagger animation on initial render via `motion.div` with `staggerChildren`.

**Files:**

- `features/agents-list/ui/AgentsList.tsx` (new)
- `features/agents-list/__tests__/AgentsList.test.tsx` (new — 4 test cases)

---

### Task 1.5 — Create agents-list barrel export

**Size:** Small | **Priority:** High | **Depends on:** 1.1, 1.2, 1.3, 1.4

Barrel `index.ts` exporting all 4 components with module-level TSDoc comment.

**Files:**

- `features/agents-list/index.ts` (new)

---

## Phase 2: AgentsPage Widget

Compose the page from Phase 1 components. Both tasks can run in parallel.

### Task 2.1 — Create AgentsPage widget with tabs and mode switching

**Size:** Large | **Priority:** High | **Depends on:** 1.5 | **Parallel with:** 2.2

Top-level page component with two modes: Mode A (zero agents) shows full-bleed DiscoveryView; Mode B (has agents) shows Tabs with "Agents" (default) and "Topology". Error state with retry button. AnimatePresence cross-fade between modes. Topology tab lazy-loads via React.lazy + Suspense.

**Files:**

- `widgets/agents/ui/AgentsPage.tsx` (new)
- `widgets/agents/__tests__/AgentsPage.test.tsx` (new — 6 test cases)

---

### Task 2.2 — Create AgentsHeader and update top-nav barrel

**Size:** Medium | **Priority:** High | **Depends on:** 1.5 | **Parallel with:** 2.1

Page header with "Agents" title, "Scan for Agents" button (opens ResponsiveDialog with DiscoveryView), and CommandPaletteTrigger. Updates top-nav barrel export. Creates widgets/agents barrel. Ensures DiscoveryView is exported from mesh barrel.

**Files:**

- `features/top-nav/ui/AgentsHeader.tsx` (new)
- `features/top-nav/__tests__/AgentsHeader.test.tsx` (new — 4 test cases)
- `features/top-nav/index.ts` (modified — add AgentsHeader export)
- `widgets/agents/index.ts` (new)
- `features/mesh/index.ts` (modified — add DiscoveryView export if missing)

---

## Phase 3: MeshPanel Cleanup

### Task 3.1 — Remove Agents tab from MeshPanel

**Size:** Medium | **Priority:** Medium | **Depends on:** 2.1

Remove the inline `AgentsTab` component, inline `AgentCard` component, "Agents" tab trigger, and Agents tab content from MeshPanel. Clean up unused imports. Update MeshPanel tests to verify 4-tab layout and remove agents-specific test blocks.

**Files:**

- `features/mesh/ui/MeshPanel.tsx` (modified)
- `features/mesh/__tests__/MeshPanel.test.tsx` (modified)

---

## Phase 4: Route + Sidebar + AppShell (LAST)

Ordered last to avoid conflicts with dashboard-content sidebar work currently in progress.

### Task 4.1 — Add /agents route to router.tsx

**Size:** Small | **Priority:** High | **Depends on:** 2.1, 2.2 | **Parallel with:** 4.2, 4.3

Add `agentsRoute` with lazy-loaded `AgentsPage` under `appShellRoute`. Update route tree.

**Files:**

- `router.tsx` (modified)

---

### Task 4.2 — Update AppShell slot hooks for /agents route

**Size:** Small | **Priority:** High | **Depends on:** 2.2 | **Parallel with:** 4.1, 4.3

Add `/agents` case to `useSidebarSlot()` (returns DashboardSidebar with key 'agents') and `useHeaderSlot()` (returns AgentsHeader with key 'agents', no border style).

**Files:**

- `AppShell.tsx` (modified)

---

### Task 4.3 — Add Agents nav item to DashboardSidebar and update tests

**Size:** Medium | **Priority:** High | **Depends on:** 4.1 | **Parallel with:** 4.2

Add "Agents" as third nav item with Users icon and pathname-based active state. Add `useRouterState` for pathname detection. Update DashboardSidebar tests with new nav item assertions.

**Files:**

- `features/dashboard-sidebar/ui/DashboardSidebar.tsx` (modified)
- `features/dashboard-sidebar/__tests__/DashboardSidebar.test.tsx` (modified)

---

### Task 4.4 — Update AGENTS.md routing documentation

**Size:** Small | **Priority:** Low | **Depends on:** 4.1, 4.2, 4.3

Add `/agents` route to the routing documentation in AGENTS.md.

**Files:**

- `AGENTS.md` (modified)

---

## Summary

| Phase                 | Tasks  | New Files | Modified Files |
| --------------------- | ------ | --------- | -------------- |
| 1 — Core Components   | 5      | 9         | 0              |
| 2 — AgentsPage Widget | 2      | 5         | 2              |
| 3 — MeshPanel Cleanup | 1      | 0         | 2              |
| 4 — Route + Sidebar   | 4      | 0         | 4              |
| **Total**             | **12** | **14**    | **8**          |

**Test coverage:** 34 test cases across 7 test files.
