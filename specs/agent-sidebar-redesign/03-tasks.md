# Tasks: Agent Sidebar Redesign

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-04-11
**Mode:** Full decomposition

---

## Phase 1: Foundation

### 1.1 Add PINNED_AGENTS storage key and pin state to Zustand app store

**Size:** Small | **Priority:** High | **Dependencies:** None

Add `STORAGE_KEYS.PINNED_AGENTS` constant and implement `pinnedAgentPaths` state with `pinAgent`/`unpinAgent` actions in the CoreSlice.

**Files:**

- `apps/client/src/layers/shared/lib/constants.ts` — add `PINNED_AGENTS: 'dorkos-pinned-agents'`
- `apps/client/src/layers/shared/model/app-store/app-store-types.ts` — extend CoreSlice interface
- `apps/client/src/layers/shared/model/app-store/app-store.ts` — initializer + actions + resetPreferences update

**Tests:**

- `apps/client/src/layers/shared/model/app-store/__tests__/app-store-pin.test.ts`
- pinAgent adds/persists, is idempotent
- unpinAgent removes/persists, no-op for unknown
- resetPreferences clears pins
- Corrupt localStorage fallback to []

---

## Phase 2: Stable Ordering and Full Roster

### 2.1 Replace LRU agent list with full mesh alphabetical roster in DashboardSidebar

**Size:** Large | **Priority:** High | **Dependencies:** 1.1

Rewrite DashboardSidebar to source agents from `useMeshAgentPaths()` instead of `recentCwds`. Remove `MAX_AGENTS` cap. Implement two-section layout (Pinned + All alphabetical). Auto-pin default agent on first install.

**Files:**

- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx` — major rewrite

**Key changes:**

1. Remove `MAX_AGENTS` constant
2. Import `useMeshAgentPaths` from `@/layers/entities/mesh`
3. Build `allPaths` (alphabetical sort) and `pinnedPaths` (pin order, filtered to existing mesh paths)
4. Render conditional "Pinned" sub-label + section when pins exist
5. Auto-pin default agent via one-time effect
6. Add handlers: `handleTogglePin`, `handleManage`, `handleEditSettings`
7. Pass new props to AgentListItem: `isPinned`, `onTogglePin`, `onManage`, `onEditSettings`

**Tests:**

- `apps/client/src/layers/features/dashboard-sidebar/__tests__/DashboardSidebar.test.tsx`
- Remove MAX_AGENTS cap test
- Add: renders all mesh agents (no cap), alphabetical sort, PINNED section conditional, empty state

---

## Phase 3: Context Menu, Activity Badge, and Action Button

### 3.1 Create AgentActivityBadge component

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 3.2

New component rendering a 6px colored dot for non-idle agent status. Returns null when idle.

**Files:**

- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentActivityBadge.tsx` — new
- `apps/client/src/layers/features/dashboard-sidebar/index.ts` — add export

**Color mapping:**
| Status | Dot | Tailwind |
|--------|-----|----------|
| streaming | Green | `bg-green-500` |
| active | Green | `bg-green-500` |
| pendingApproval | Amber | `bg-amber-500` |
| error | Red | `bg-destructive` |
| unseen | Blue | `bg-blue-500` |
| idle | (none) | — |

**Tests:**

- `apps/client/src/layers/features/dashboard-sidebar/__tests__/AgentActivityBadge.test.tsx`
- Null for idle, correct color per status, aria-label, size-1.5

### 3.2 Create AgentContextMenu component

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 3.1

New component wrapping agent rows in a Radix ContextMenu (right-click desktop, long-press mobile).

**Files:**

- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentContextMenu.tsx` — new
- `apps/client/src/layers/features/dashboard-sidebar/index.ts` — add export

**Menu items:**

1. Pin agent / Unpin agent (toggle)
2. ---separator---
3. Manage agent (ListTree icon)
4. Edit settings (Settings icon)
5. ---separator---
6. New session (Plus icon)

**Tests:**

- `apps/client/src/layers/features/dashboard-sidebar/__tests__/AgentContextMenu.test.tsx`
- Children render without menu, Pin/Unpin toggle, structural correctness

### 3.3 Update AgentListItem with context menu, activity badge, and action button

**Size:** Large | **Priority:** High | **Dependencies:** 2.1, 3.1, 3.2

Integrate AgentContextMenu wrapper, AgentActivityBadge, `...` DropdownMenu button, and remove `showDrillDown` gate.

**Files:**

- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentListItem.tsx` — significant update

**Key changes:**

1. Add `isPinned`, `onTogglePin`, `onManage`, `onEditSettings` props
2. Wrap row in `AgentContextMenu`
3. Insert `AgentActivityBadge` between identity and chevron
4. Add `SidebarMenuAction` with `DropdownMenu` (same items as context menu)
5. Remove `showDrillDown` gate — Sessions button always visible in expanded view
6. Remove Hand icon (replaced by amber activity badge dot)

**Row layout:** `[AgentIdentity] [AgentActivityBadge] [...Button] [ChevronRight]`

**Tests:**

- `apps/client/src/layers/features/dashboard-sidebar/__tests__/AgentListItem.test.tsx`
- Activity badge renders/hides, actions button present, Sessions always visible

---

## Phase 4: Add Agent Button and Progressive Empty State

### 4.1 Create AddAgentMenu popover component

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.1 | **Parallel with:** 4.2

Popover triggered by `SidebarGroupAction` `+` button in the AGENTS header. Three actions using existing store actions.

**Files:**

- `apps/client/src/layers/features/dashboard-sidebar/ui/AddAgentMenu.tsx` — new
- `apps/client/src/layers/features/dashboard-sidebar/index.ts` — add export

**Actions:**

- Create agent -> `setAgentDialogOpen(true)`
- Import project -> `setPickerOpen(true)`
- Browse Dork Hub -> `navigate({ to: '/marketplace' })`

**Tests:**

- `apps/client/src/layers/features/dashboard-sidebar/__tests__/AddAgentMenu.test.tsx`
- Renders + button, popover opens, each action triggers correct handler

### 4.2 Create AgentOnboardingCard and add progressive empty state to DashboardSidebar

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.1, 4.1

Onboarding card for sparse agent lists plus progressive empty state logic in DashboardSidebar.

**Files:**

- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentOnboardingCard.tsx` — new
- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx` — add empty state logic + AddAgentMenu integration
- `apps/client/src/layers/features/dashboard-sidebar/index.ts` — add export

**Progressive behavior:**
| Agent count | Rendered |
|-------------|----------|
| 0-2 | Agent rows + AgentOnboardingCard |
| 3-4 | Agent rows + "+ Add agent" text link |
| 5+ | Agent rows only (+ button in header) |

**Tests:**

- `apps/client/src/layers/features/dashboard-sidebar/__tests__/AgentOnboardingCard.test.tsx`
- `apps/client/src/layers/features/dashboard-sidebar/__tests__/DashboardSidebar.test.tsx` — empty state tests

---

## Dependency Graph

```
1.1 (Pin state)
 |
 +---> 2.1 (Full roster + two-section layout)
 |      |
 |      +---> 3.3 (AgentListItem update)
 |      |      ^
 |      |      |
 |      +---> 3.1 (AgentActivityBadge)  ---|
 |      |                                   |---> 3.3
 |      +---> 3.2 (AgentContextMenu)    ---|
 |      |
 |      +---> 4.1 (AddAgentMenu)  ---> 4.2 (OnboardingCard + empty state)
```

## Summary

| Phase                      | Tasks | Parallel opportunities            |
| -------------------------- | ----- | --------------------------------- |
| 1. Foundation              | 1     | None (single task)                |
| 2. Stable Ordering         | 1     | None (single task, depends on P1) |
| 3. Context Menu + Badge    | 3     | 3.1 and 3.2 can run in parallel   |
| 4. Add Agent + Empty State | 2     | 4.1 can start parallel with 3.x   |
| **Total**                  | **7** | **2 parallel pairs**              |
