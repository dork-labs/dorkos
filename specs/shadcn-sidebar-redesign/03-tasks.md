# Task Breakdown: Shadcn Sidebar Redesign

Generated: 2026-03-03
Source: specs/shadcn-sidebar-redesign/02-specification.md
Last Decompose: 2026-03-03

## Overview

Replace the custom 392-line `SessionSidebar` and custom motion.dev sidebar layout in `App.tsx` with Shadcn's `Sidebar` component. The migration targets the standalone web path only (embedded/Obsidian mode is unchanged). Key outcomes: agent header gets full width, glanceable status chips added to footer, all dialogs lifted to root-level `DialogHost`, and ~200 lines of custom overlay/push animation code deleted.

---

## Phase 1: Foundation

### Task 1.1: Install Shadcn Sidebar and resolve use-mobile.tsx conflict

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.2, 1.3

Install Shadcn Sidebar via `pnpm dlx shadcn@latest add sidebar` from `apps/client/`. Delete the generated `use-mobile.tsx` and patch `sidebar.tsx` to import `useIsMobile` from `@/layers/shared/model` instead. Verify all sub-components export correctly from the shared/ui barrel.

### Task 1.2: Add --sidebar-\* CSS variables to index.css

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1, 1.3

Add 8 `--sidebar-*` CSS custom properties to both `:root` (light) and `.dark` blocks in `apps/client/src/index.css`. Sidebar background is intentionally offset from main background (96% vs 98% light, 6% vs 4% dark) for subtle visual hierarchy. These are consumed directly by sidebar.tsx, not via `@theme inline`.

### Task 1.3: Add agentDialogOpen and onboardingStep to Zustand store

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1, 1.2

Add `agentDialogOpen` (boolean) and `onboardingStep` (number | null) to the Zustand app store. These are currently local state in SessionSidebar but need to be in the store so DialogHost (rendered at root level) can access them. Transient state, not persisted to localStorage.

---

## Phase 2: Layout Migration

### Task 2.1: Create DialogHost component

**Size**: Medium | **Priority**: High | **Dependencies**: 1.3 | **Parallel with**: None

Create `DialogHost` in `widgets/app-layout/` that renders all 7 dialogs (Settings, DirectoryPicker, Pulse, Relay, Mesh, AgentDialog, OnboardingFlow) at the App.tsx root level, outside SidebarProvider. All dialog state comes from Zustand. Fixes the mobile dialog lifecycle bug.

### Task 2.2: Refactor standalone path in App.tsx with SidebarProvider layout

**Size**: Large | **Priority**: High | **Dependencies**: 1.1, 1.2, 1.3, 2.1 | **Parallel with**: None

Replace custom mobile overlay + desktop push layout with `SidebarProvider` + `Sidebar` + `SidebarInset`. Add `SidebarTrigger` in SidebarInset header. Remove custom Cmd+B handler, floating toggle button, AnimatePresence mobile overlay, and motion.div desktop push code. Embedded path remains completely unchanged.

---

## Phase 3: Sidebar Internals

### Task 3.1: Refactor SessionSidebar to use Shadcn Sidebar sub-components

**Size**: Large | **Priority**: High | **Dependencies**: 2.2 | **Parallel with**: None

Major refactor from 392 to ~150 lines. Use `Sidebar` (`collapsible="offcanvas"`), `SidebarHeader`, `SidebarContent`, `SidebarFooter`, `SidebarRail`. Replace session items with `SidebarGroup` > `SidebarMenu` > `SidebarMenuItem` > `SidebarMenuButton`. Remove all 7 dialog JSX blocks, close button wrapper, and SessionItem expand/collapse.

### Task 3.2: Create AgentContextChips component

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.2 | **Parallel with**: 3.3

New `AgentContextChips.tsx` in `features/session-list/ui/`. Compact row of 3 tooltip-equipped status chips (Pulse, Relay, Mesh) with muted disabled states, animated status dots, and click-to-open panel actions. Reuses existing entity hooks.

### Task 3.3: Create SidebarFooterBar component

**Size**: Small | **Priority**: Medium | **Dependencies**: 2.2 | **Parallel with**: 3.2

New `SidebarFooterBar.tsx` in `features/session-list/ui/`. Bottom bar with "DorkOS by Dorkian" branding link, settings gear button, and theme cycle toggle (light -> dark -> system). Separated from chips by border-top.

### Task 3.4: Update barrel exports for session-list feature

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.1, 3.2, 3.3 | **Parallel with**: None

Add `AgentContextChips` and `SidebarFooterBar` exports to `features/session-list/index.ts`.

---

## Phase 4: Tests + Cleanup

### Task 4.1: Update SessionSidebar tests

**Size**: Medium | **Priority**: High | **Dependencies**: 3.1 | **Parallel with**: 4.2, 4.3, 4.4

Add `SidebarProvider` to test wrapper. Update session grouping and empty state tests. Remove close button, dialog rendering, and expand/collapse tests. Add matchMedia mock for Shadcn mobile detection.

### Task 4.2: Add DialogHost tests

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.1 | **Parallel with**: 4.1, 4.3, 4.4

New test file for DialogHost. Verify dialogs render when open state is true, no dialogs when all states false, multiple simultaneous dialogs, and OnboardingFlow on step trigger.

### Task 4.3: Add AgentContextChips tests

**Size**: Medium | **Priority**: Medium | **Dependencies**: 3.2 | **Parallel with**: 4.1, 4.2, 4.4

New test file. Verify all 3 chips render, muted styling for disabled features, active run dot, and click handlers for panel opening.

### Task 4.4: Add SidebarFooterBar tests

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.3 | **Parallel with**: 4.1, 4.2, 4.3

New test file. Verify branding link, settings button click, and theme cycling through all 3 states.

### Task 4.5: Run full test suite, typecheck, and lint

**Size**: Medium | **Priority**: High | **Dependencies**: 4.1, 4.2, 4.3, 4.4 | **Parallel with**: None

Full regression check: `pnpm test -- --run`, `pnpm typecheck`, `pnpm lint`, `pnpm build`. Fix any failures from the sidebar redesign.

### Task 4.6: Update documentation

**Size**: Small | **Priority**: Low | **Dependencies**: 4.5 | **Parallel with**: None

Update `contributing/design-system.md` (Shadcn Sidebar, CSS vars), `contributing/keyboard-shortcuts.md` (Cmd+B is now Shadcn built-in), and `AGENTS.md` (FSD layers table with new components).

---

## Summary

| Phase                 | Tasks  | Parallel Opportunities                           |
| --------------------- | ------ | ------------------------------------------------ |
| P1: Foundation        | 3      | All 3 can run in parallel                        |
| P2: Layout Migration  | 2      | Sequential (2.1 then 2.2)                        |
| P3: Sidebar Internals | 4      | 3.2 and 3.3 in parallel; 3.1 first, 3.4 last     |
| P4: Tests + Cleanup   | 6      | 4.1-4.4 all in parallel; 4.5 then 4.6 sequential |
| **Total**             | **15** |                                                  |

**Critical path**: 1.1 -> 2.1 -> 2.2 -> 3.1 -> 4.1 -> 4.5 -> 4.6
