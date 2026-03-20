# Dynamic Sidebar Content — Task Breakdown

**Spec:** `specs/dynamic-sidebar-content/02-specification.md`
**Generated:** 2026-03-20
**Mode:** Full decomposition

---

## Phase 1: Structural Refactor

### Task 1.1 — Rename AgentSidebar to SessionSidebar and remove footer/rail rendering

**Size:** Medium | **Priority:** High | **Dependencies:** None

Rename `AgentSidebar.tsx` to `SessionSidebar.tsx` via `git mv`. Update the component export name. Remove `SidebarFooter`, `SidebarRail`, `ProgressCard`, `SidebarFooterBar`, and all `useOnboarding` usage from the component — these move to AppShell. Update the barrel export in `features/session-list/index.ts` to export `SessionSidebar`.

**Key files:**

- `apps/client/src/layers/features/session-list/ui/AgentSidebar.tsx` → `SessionSidebar.tsx`
- `apps/client/src/layers/features/session-list/index.ts`

---

### Task 1.2 — Move footer rendering from SessionSidebar to AppShell

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Move the `SidebarFooter` (containing `ProgressCard` and `SidebarFooterBar`), plus `SidebarRail`, into `AppShell.tsx`. Update imports to use `SessionSidebar` instead of `AgentSidebar`. Add `dismissOnboarding` destructuring from `useOnboarding()`. Add `setOnboardingStep` from app store. Net visual result is identical — footer just renders from AppShell now.

**Key files:**

- `apps/client/src/AppShell.tsx`

---

## Phase 2: Switch Hooks & AnimatePresence

### Task 2.1 — Create SessionHeader and DashboardHeader components

**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.2

Extract current inline header content (AgentIdentityChip + CommandPaletteTrigger) into `SessionHeader`. Create `DashboardHeader` with "Dashboard" title + CommandPaletteTrigger. Both live in `features/top-nav/`. Update the barrel to export both.

**Key files (new):**

- `apps/client/src/layers/features/top-nav/ui/SessionHeader.tsx`
- `apps/client/src/layers/features/top-nav/ui/DashboardHeader.tsx`
- `apps/client/src/layers/features/top-nav/index.ts`

---

### Task 2.2 — Create DashboardSidebar feature module with placeholder content

**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.1

Create new `features/dashboard-sidebar/` FSD module. `DashboardSidebar` renders a SidebarHeader with "Dashboard" (active) and "Sessions" (navigates to `/session`) nav items, plus a placeholder content area. Barrel exports the component.

**Key files (new):**

- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx`
- `apps/client/src/layers/features/dashboard-sidebar/index.ts`

---

### Task 2.3 — Add switch hooks and AnimatePresence wrappers to AppShell

**Size:** Large | **Priority:** High | **Dependencies:** 2.1, 2.2

Add private `useSidebarSlot()` and `useHeaderSlot()` hooks inside AppShell.tsx. `useSidebarSlot` reads `useRouterState` pathname and returns `DashboardSidebar` for `/`, `SessionSidebar` for everything else. `useHeaderSlot` does the same for headers, also returning `borderStyle` for the agent color border (only on session route). Wrap sidebar body and header content in `AnimatePresence mode="wait" initial={false}` with `motion.div` keyed by the slot key. 100ms opacity cross-fade. Footer, rail, sidebar trigger, and separator remain outside AnimatePresence (static chrome).

**Key files:**

- `apps/client/src/AppShell.tsx`

---

### Task 2.4 — Update embedded mode App.tsx to use SessionSidebar

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 2.1, 2.2

Simple import rename in `App.tsx` — change `AgentSidebar` to `SessionSidebar`. No behavioral changes to embedded/Obsidian mode.

**Key files:**

- `apps/client/src/App.tsx`

---

## Phase 3: Testing & Cleanup

### Task 3.1 — Rename and update AgentSidebar tests to SessionSidebar

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2 | **Parallel with:** 3.2, 3.3

Rename `AgentSidebar.test.tsx` to `SessionSidebar.test.tsx`. Update all component references. Remove the footer rendering test (replaced with assertion that footer is NOT rendered). Remove onboarding mock (no longer needed). All existing behavioral tests (tabs, keyboard shortcuts, feature flags, auto-select) remain.

**Key files:**

- `apps/client/src/layers/features/session-list/__tests__/AgentSidebar.test.tsx` → `SessionSidebar.test.tsx`

---

### Task 3.2 — Create DashboardSidebar tests

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.2 | **Parallel with:** 3.1, 3.3

Unit tests verifying: Dashboard is active nav item, Sessions button navigates to `/session`, placeholder text renders, footer is not rendered by DashboardSidebar.

**Key files (new):**

- `apps/client/src/layers/features/dashboard-sidebar/__tests__/DashboardSidebar.test.tsx`

---

### Task 3.3 — Create SessionHeader and DashboardHeader tests

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.1 | **Parallel with:** 3.1, 3.2

Unit tests for both header components. SessionHeader: renders agent name, CommandPaletteTrigger, handles null agent. DashboardHeader: renders "Dashboard" text, CommandPaletteTrigger.

**Key files (new):**

- `apps/client/src/layers/features/top-nav/__tests__/SessionHeader.test.tsx`
- `apps/client/src/layers/features/top-nav/__tests__/DashboardHeader.test.tsx`

---

### Task 3.4 — Create app-shell-slots integration test

**Size:** Large | **Priority:** Medium | **Dependencies:** 2.3

Integration test using TanStack Router's `createMemoryHistory` to render AppShell at different paths. Verifies: DashboardSidebar at `/`, SessionSidebar at `/session`, DashboardHeader at `/`, SessionHeader at `/session`, SidebarFooterBar present on both routes.

**Key files (new):**

- `apps/client/src/__tests__/app-shell-slots.test.tsx`

---

### Task 3.5 — Final cleanup — remove stale AgentSidebar references and update documentation

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.3, 2.4, 3.1, 3.2, 3.3, 3.4

Grep for any remaining `AgentSidebar` references and remove them. Update `contributing/project-structure.md` (add `dashboard-sidebar/` module), `contributing/architecture.md` (describe slot pattern), and `CLAUDE.md` (route descriptions). Final `pnpm typecheck` and `pnpm test -- --run` validation.

**Key files:**

- `contributing/project-structure.md`
- `contributing/architecture.md`
- `CLAUDE.md`

---

## Dependency Graph

```
1.1 ──┬──→ 1.2 ──┬──→ 2.1 ──┬──→ 2.3 ──→ 3.4 ──→ 3.5
      │          │          │                      ↑
      │          ├──→ 2.2 ──┘                      │
      │          │                                  │
      ├──→ 2.4  ├──→ 3.1 ──────────────────────────┤
      │          │                                  │
      │          └─────────── 3.2 ──────────────────┤
      │                                             │
      └───────── 2.1 → 3.3 ────────────────────────┘
```

## Summary

| Phase                              | Tasks                   | Total  |
| ---------------------------------- | ----------------------- | ------ |
| P1: Structural Refactor            | 1.1, 1.2                | 2      |
| P2: Switch Hooks & AnimatePresence | 2.1, 2.2, 2.3, 2.4      | 4      |
| P3: Testing & Cleanup              | 3.1, 3.2, 3.3, 3.4, 3.5 | 5      |
| **Total**                          |                         | **11** |
