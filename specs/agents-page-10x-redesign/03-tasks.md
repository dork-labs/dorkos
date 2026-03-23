# Agents Page 10x Redesign - Task Breakdown

**Spec:** `specs/agents-page-10x-redesign/02-specification.md`
**Generated:** 2026-03-23
**Mode:** Full decomposition

---

## Phase 1: Core Layout

### Task 1.1 — Create UnregisterAgentDialog component

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2, 1.3

Create `UnregisterAgentDialog` at `features/agents-list/ui/UnregisterAgentDialog.tsx` using the `AlertDialog` pattern from `shared/ui/alert-dialog`. Replaces the inline confirm/cancel unregister pattern. The component calls `useUnregisterAgent()` internally to co-locate mutation lifecycle. Confirm button uses destructive styling. Add barrel export and 5 tests.

**Files created:**

- `apps/client/src/layers/features/agents-list/ui/UnregisterAgentDialog.tsx`
- `apps/client/src/layers/features/agents-list/__tests__/UnregisterAgentDialog.test.tsx`

**Files modified:**

- `apps/client/src/layers/features/agents-list/index.ts` (barrel export)

---

### Task 1.2 — Create FleetHealthBar component

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1, 1.3

Create `FleetHealthBar` at `features/agents-list/ui/FleetHealthBar.tsx` that reads `MeshStatus` and renders colored dots with clickable counts for each health status. Clicking toggles filter; re-clicking resets to `'all'`. Labels hidden on mobile (`hidden sm:inline`). All counts use `tabular-nums`. Segments with zero count not rendered. Add barrel export and 6 tests.

**Files created:**

- `apps/client/src/layers/features/agents-list/ui/FleetHealthBar.tsx`
- `apps/client/src/layers/features/agents-list/__tests__/FleetHealthBar.test.tsx`

**Files modified:**

- `apps/client/src/layers/features/agents-list/index.ts` (barrel export)

---

### Task 1.3 — Add health dot pulse CSS animation

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1, 1.2

Add `@keyframes health-pulse` and `.animate-health-pulse` utility class to `apps/client/src/index.css`. Uses `box-shadow` glow effect with emerald-500 color, 2s ease-in-out infinite.

**Files modified:**

- `apps/client/src/index.css`

---

### Task 1.4 — Restructure AgentRow to two-line card layout with motion animations

**Size:** Large | **Priority:** High | **Dependencies:** 1.1, 1.3

Major refactor of `AgentRow`: replace `Collapsible` with `AnimatePresence` + `motion.div` for expand/collapse. Two-line collapsed layout (Line 1: health dot + name + runtime + relative time; Line 2: path + session count + action). Remove capabilities from collapsed state. Replace raw ISO timestamp with `relativeTime()`. Replace inline unregister confirmation with `UnregisterAgentDialog`. Add `animate-health-pulse` class for active agents. Update existing tests.

**Files modified:**

- `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx`
- `apps/client/src/layers/features/agents-list/__tests__/AgentRow.test.tsx`

---

### Task 1.5 — Integrate FleetHealthBar into AgentsList and fix stagger animation

**Size:** Medium | **Priority:** High | **Dependencies:** 1.2, 1.4

Add `FleetHealthBar` above `AgentFilterBar` in `AgentsList`. Wire health bar clicks to filter state. Compute `statusCounts` from `useMeshStatus()`. Fix stagger animation with `staggerKey` pattern (plays once on mount, not on filter changes). Limit stagger to first 8 items. Pass `statusCounts` to `AgentFilterBar`. Update existing tests.

**Files modified:**

- `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx`
- `apps/client/src/layers/features/agents-list/__tests__/AgentsList.test.tsx`

---

## Phase 2: Filter Bar + View Switcher

### Task 2.1 — Update AgentFilterBar with color-coded chips, counts, unreachable status, and mobile dropdown

**Size:** Medium | **Priority:** High | **Dependencies:** 1.5 | **Parallel with:** 2.2

Add `'unreachable'` to `StatusFilter` type. Color-code status chips (`statusChipColors` mapping: emerald, amber, muted, red). Show counts in parentheses when `statusCounts` prop provided. Hide unreachable chip when count is 0. Flexible search input width. Desktop: chips (`hidden sm:flex`). Mobile: `Select` dropdown (`flex sm:hidden`). Update existing tests.

**Files modified:**

- `apps/client/src/layers/features/agents-list/ui/AgentFilterBar.tsx`
- `apps/client/src/layers/features/agents-list/__tests__/AgentFilterBar.test.tsx`

---

### Task 2.2 — Add view search param to /agents route and update AgentsHeader with view switcher

**Size:** Medium | **Priority:** High | **Dependencies:** 1.5 | **Parallel with:** 2.1

Add `agentsSearchSchema` with `?view=list|topology` (default: `list`) to `/agents` route in `router.tsx`. Export `AgentsSearch` type. Update `AgentsHeader` to read `viewMode` from URL via `useSearch`, render text-based tab switcher ("Agents" | "Topology") on desktop, hidden on mobile. Active tab: `bg-background text-foreground shadow-sm`.

**Files modified:**

- `apps/client/src/router.tsx`
- `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`

---

### Task 2.3 — Update AgentsPage to use URL-based view switching and remove Tabs component

**Size:** Medium | **Priority:** High | **Dependencies:** 2.2

Remove `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` from `AgentsPage`. Read `viewMode` from URL via `useSearch`. Conditionally render `AgentsList` or `LazyTopologyGraph` with `AnimatePresence mode="wait"` crossfade. Mode A uses temporary placeholder (replaced by `AgentGhostRows` in task 3.1). Update existing tests.

**Files modified:**

- `apps/client/src/layers/widgets/agents/ui/AgentsPage.tsx`
- `apps/client/src/layers/widgets/agents/__tests__/AgentsPage.test.tsx`

---

## Phase 3: Empty States + Animations

### Task 3.1 — Create AgentGhostRows component and integrate into AgentsPage Mode A

**Size:** Medium | **Priority:** High | **Dependencies:** 2.3 | **Parallel with:** 3.2

Create `AgentGhostRows` with 3 ghost rows (`border-dashed`, `opacity: 0.2`), skeleton bars matching two-line card layout, centered overlay with "Discover Your Agent Fleet" heading and "Scan for Agents" button opening `ResponsiveDialog` with `DiscoveryView`. Stagger entrance animation. Integrate into `AgentsPage` Mode A. Add barrel export and 4 tests.

**Files created:**

- `apps/client/src/layers/features/agents-list/ui/AgentGhostRows.tsx`
- `apps/client/src/layers/features/agents-list/__tests__/AgentGhostRows.test.tsx`

**Files modified:**

- `apps/client/src/layers/features/agents-list/index.ts` (barrel export)
- `apps/client/src/layers/widgets/agents/ui/AgentsPage.tsx` (replace Mode A placeholder)

---

### Task 3.2 — Create AgentEmptyFilterState component and integrate into AgentsList

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.5 | **Parallel with:** 3.1

Create `AgentEmptyFilterState` with `SearchX` icon, "No agents match your filters" text, and "Clear filters" button. Entrance animation: fade + slide up from y:20, 0.3s easeOut. Integrate into `AgentsList` (show when `filteredAgents.length === 0` and agents exist). Add barrel export. Update AgentsList tests.

**Files created:**

- `apps/client/src/layers/features/agents-list/ui/AgentEmptyFilterState.tsx`

**Files modified:**

- `apps/client/src/layers/features/agents-list/index.ts` (barrel export)
- `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx` (integrate empty state)
- `apps/client/src/layers/features/agents-list/__tests__/AgentsList.test.tsx` (add tests)

---

## Phase 4: Responsive + Polish

### Task 4.1 — Apply responsive polish and ensure minimum touch targets

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.1, 2.2, 3.1, 3.2 | **Parallel with:** 4.2

Verify and polish all responsive behaviors: mobile path wrapping in AgentRow, compact health bar (dots + counts only), filter dropdown on mobile, hidden Topology tab. Ensure all interactive elements have minimum 44px touch targets on mobile (`min-h-[44px]` where needed). Verify `prefers-reduced-motion` respected via global `MotionConfig`.

**Files modified:**

- `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx`
- `apps/client/src/layers/features/agents-list/ui/FleetHealthBar.tsx`
- `apps/client/src/layers/features/agents-list/ui/AgentFilterBar.tsx`
- `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`

---

### Task 4.2 — Final barrel exports, TSDoc audit, and comprehensive test verification

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.1, 2.2, 3.1, 3.2 | **Parallel with:** 4.1

Final verification pass: all barrel exports correct (4 new components in `agents-list/index.ts`, `AgentsSearch` type in `router.tsx`), TSDoc on all exported components, all tests pass, TypeScript compiles, ESLint clean, no FSD layer violations.

**Verification commands:**

```bash
pnpm vitest run apps/client/src/layers/features/agents-list/__tests__/
pnpm vitest run apps/client/src/layers/widgets/agents/__tests__/
pnpm typecheck
pnpm lint
```

---

## Dependency Graph

```
Phase 1:
  1.1 (UnregisterAgentDialog) ─┐
  1.2 (FleetHealthBar) ────────┤──→ 1.4 (AgentRow refactor) ──→ 1.5 (AgentsList integration)
  1.3 (CSS animation) ─────────┘

Phase 2:
  1.5 ──→ 2.1 (AgentFilterBar update) ──────────────────────┐
  1.5 ──→ 2.2 (Router + AgentsHeader) ──→ 2.3 (AgentsPage) ─┤

Phase 3:                                                     │
  2.3 ──→ 3.1 (AgentGhostRows) ─────────────────────────────┤
  1.5 ──→ 3.2 (AgentEmptyFilterState) ──────────────────────┤

Phase 4:                                                     │
  2.1 + 2.2 + 3.1 + 3.2 ──→ 4.1 (Responsive polish) ──────┘
  2.1 + 2.2 + 3.1 + 3.2 ──→ 4.2 (Final verification)
```

## Summary

| Phase                          | Tasks  | New Files                  | Modified Files |
| ------------------------------ | ------ | -------------------------- | -------------- |
| 1 - Core Layout                | 5      | 4 (2 components + 2 tests) | 4              |
| 2 - Filter Bar + View Switcher | 3      | 0                          | 5              |
| 3 - Empty States + Animations  | 2      | 2 (2 components + 1 test)  | 4              |
| 4 - Responsive + Polish        | 2      | 0                          | 4              |
| **Total**                      | **12** | **6**                      | **17**         |
