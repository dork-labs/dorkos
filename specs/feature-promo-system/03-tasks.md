# Feature Promo System — Task Breakdown

**Spec:** `specs/feature-promo-system/02-specification.md`
**Generated:** 2026-03-24
**Mode:** Full decomposition

---

## Phase 1: Foundation

### 1.1 Create type system and module skeleton

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Create the `features/feature-promos/` FSD module with the full type system (`PromoPlacement`, `PromoAction`, `PromoDialogProps`, `PromoContent`, `PromoContext`, `PromoDefinition`), an empty `PROMO_REGISTRY` array, and the barrel `index.ts`. All types live in `model/promo-types.ts`.

**Key deliverables:**

- `model/promo-types.ts` — All types
- `model/promo-registry.ts` — Empty registry array
- `index.ts` — Barrel exports

---

### 1.2 Extend app store with promo state

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Add `dismissedPromoIds: string[]`, `promoEnabled: boolean`, `dismissPromo()`, and `setPromoEnabled()` to the existing Zustand app store. Add `'overview'` to the `sidebarActiveTab` union type. Update `resetPreferences` to clear promo state and default tab to `'overview'`. All persistence follows the existing manual localStorage pattern (readBool/writeBool for booleans, JSON.parse/stringify for arrays).

**Files changed:**

- `shared/model/app-store.ts` — AppState interface, BOOL_KEYS, BOOL_DEFAULTS, state implementation, resetPreferences

---

### 1.3 Create usePromoContext hook and helper hooks

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** None

Create `usePromoContext()` that assembles the `PromoContext` condition object from entity/shared hooks. Also create three new helper hooks: `useAdapterStatus()` (relay adapter connection state), `useMeshEnabled()` (mesh connection derived state), and `useFirstUseDate()` (localStorage-backed first-use tracking with `daysSince` utility).

**Files created:**

- `model/promo-context.ts`
- `model/use-adapter-status.ts`
- `model/use-mesh-enabled.ts`
- `model/use-first-use-date.ts`

---

### 1.4 Create usePromoSlot hook with tests

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2, 1.3 | **Parallel with:** None

Create the main consumer hook `usePromoSlot(placement, maxUnits)`. Pipeline: filter by placement, exclude dismissed, evaluate `shouldShow`, sort by priority descending, cap at maxUnits. Returns `[]` when global toggle is off. Includes 7 test cases covering all pipeline stages.

**Files created:**

- `model/use-promo-slot.ts`
- `__tests__/use-promo-slot.test.ts`

---

## Phase 2: Core Components

### 2.1 Build PromoCard component with tests

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2 | **Parallel with:** 2.2

Create PromoCard with two visual formats. Standard format (dashboard-main): vertical card with icon, title, description, CTA arrow, and dismiss X button. Compact format (sidebar placements): horizontal row with icon, title, description, arrow, no dismiss button. Uses `motion.div` with stagger variants. Includes 6 test cases.

**Files created:**

- `ui/PromoCard.tsx`
- `__tests__/PromoCard.test.tsx`

---

### 2.2 Build PromoDialog shell component

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.1

Create PromoDialog as a thin wrapper around ResponsiveDialog. Renders the promo's `action.component` inside ResponsiveDialogBody. Dialog on desktop with fullscreen toggle, Drawer on mobile. Passes `{ onClose }` to dialog content components. Returns null for non-dialog action types.

**Files created:**

- `ui/PromoDialog.tsx`

---

### 2.3 Build PromoSlot component with tests

**Size:** Medium | **Priority:** High | **Dependencies:** 1.4, 2.1, 2.2 | **Parallel with:** None

Create PromoSlot that renders promo cards for a placement slot. Zero DOM when empty (AnimatePresence pattern matching NeedsAttentionSection). Dashboard-main: "DISCOVER" section header + responsive 2-col grid. Sidebar placements: vertical stack, no header. All animations respect `useReducedMotion()`. Includes 5 test cases.

**Files created:**

- `ui/PromoSlot.tsx`
- `__tests__/PromoSlot.test.tsx`

---

### 2.4 Integrate PromoSlot into DashboardPage and DashboardSidebar

**Size:** Small | **Priority:** High | **Dependencies:** 2.3 | **Parallel with:** 2.5

Add `<PromoSlot placement="dashboard-main" maxUnits={4} />` after NeedsAttentionSection in DashboardPage. Add `<PromoSlot placement="dashboard-sidebar" maxUnits={3} />` below Recent Agents in DashboardSidebar. One import + one line per file.

**Files changed:**

- `widgets/dashboard/ui/DashboardPage.tsx`
- `features/dashboard-sidebar/ui/DashboardSidebar.tsx`

---

### 2.5 Add Overview tab to SessionSidebar

**Size:** Large | **Priority:** High | **Dependencies:** 1.2, 2.3 | **Parallel with:** 2.4

Add Overview as the first tab (position 0) in SessionSidebar. Existing tabs shift: Sessions (Cmd+2), Schedules (Cmd+3), Connections (Cmd+4). Overview panel shows agent context section + `<PromoSlot placement="agent-sidebar" maxUnits={3} />`. Update SidebarTabRow TAB_CONFIG with LayoutGrid icon. Update keyboard shortcuts tabMap. Update SessionSidebar tests for new tab count and defaults.

**Files changed:**

- `features/session-list/ui/SidebarTabRow.tsx`
- `features/session-list/ui/SessionSidebar.tsx`
- `features/session-list/__tests__/SessionSidebar.test.tsx`

---

### 2.6 Add Settings toggle for feature suggestions

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.2 | **Parallel with:** 2.4, 2.5

Add a "Feature suggestions" SettingRow with Switch toggle in the Preferences tab of SettingsDialog. Positioned between "Pulse run notifications" and "Show dev tools". Reads `promoEnabled` and calls `setPromoEnabled` from the app store. Update SettingsDialog test.

**Files changed:**

- `features/settings/ui/SettingsDialog.tsx`
- `features/settings/__tests__/SettingsDialog.test.tsx`

---

## Phase 3: Content & Polish

### 3.1 Create dialog content components

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 3.2

Create four dialog content components, each receiving `PromoDialogProps` (`{ onClose }`). All use benefit-first copy. RemoteAccessDialog (mobile + multi-device benefits). RelayAdaptersDialog (notifications + two-way communication, CTA opens Relay dialog). SchedulesDialog (cron + autonomous operation, CTA opens Pulse dialog). AgentChatDialog (multi-agent workflows + topology, CTA opens Mesh dialog).

**Files created:**

- `ui/dialogs/RemoteAccessDialog.tsx`
- `ui/dialogs/RelayAdaptersDialog.tsx`
- `ui/dialogs/SchedulesDialog.tsx`
- `ui/dialogs/AgentChatDialog.tsx`

---

### 3.2 Populate promo registry with initial entries

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.1, 3.1 | **Parallel with:** 3.1

Populate `PROMO_REGISTRY` with four entries: Remote Access (priority 90, always show), Relay Adapters (priority 80, relay enabled + no adapters), Schedules (priority 70, pulse enabled + sessions > 0), Agent Chat (priority 60, mesh enabled + agents >= 2). Each references its dialog component.

**Files changed:**

- `model/promo-registry.ts`

---

### 3.3 Create dev playground showcase

**Size:** Medium | **Priority:** Low | **Dependencies:** 2.3, 3.2 | **Parallel with:** None

Create PromoShowcases.tsx with four sections: registry table (all promos with metadata and dismiss state), live slot previews (three placements side by side), override controls (global toggle + reset dismissals), and dialog previews (button per dialog-type promo). Add section entry to features-sections.ts with id `feature-promos`.

**Files created:**

- `dev/showcases/PromoShowcases.tsx`

**Files changed:**

- `dev/sections/features-sections.ts`

---

## Phase 4: Testing & Validation

### 4.1 Create registry validation tests

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.2 | **Parallel with:** 4.2

Create 9 structural validation tests for the promo registry: unique IDs, kebab-case IDs, valid placements, priority range 0-100, dialog actions have components, navigate actions have non-empty `to`, no orphaned dialog files, non-empty content fields, callable shouldShow functions. These tests catch issues when new promos are added.

**Files created:**

- `__tests__/promo-registry.test.ts`

---

### 4.2 Create dismissal state tests

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.2 | **Parallel with:** 4.1

Create 9 tests for promo state in the app store: dismissPromo adds ID, idempotent dismissal, localStorage persistence, multiple dismissals accumulate, setPromoEnabled toggles flag, setPromoEnabled persists, resetPreferences clears dismissals, resetPreferences resets enabled, resetPreferences cleans localStorage.

**Files created:**

- `__tests__/use-promo-state.test.ts`

---

### 4.3 Update barrel exports and run full validation

**Size:** Small | **Priority:** High | **Dependencies:** 2.4, 2.5, 2.6, 3.2, 3.3, 4.1, 4.2 | **Parallel with:** None

Final integration gate: verify barrel exports, confirm all imports use barrel paths, run `pnpm typecheck`, `pnpm vitest run`, and `pnpm lint`. Verify zero-DOM behavior when no promos qualify. Confirm FSD layer compliance (no cross-feature model imports). Confirm animation consistency with existing dashboard patterns.

---

## Dependency Graph

```
1.1 ──┬──> 1.3 ──> 1.4 ──> 2.3 ──> 2.4 ──┐
      │                          ──> 2.5 ──┤
      ├──> 2.1 ──────────────> 2.3         │
      ├──> 2.2 ──────────────> 2.3         │
      ├──> 3.1 ──> 3.2 ──> 3.3 ──────────>│
      │                    ──> 4.1 ────────>│
1.2 ──┼──> 1.3                             │
      ├──> 2.1                             │
      ├──> 2.5                             │
      ├──> 2.6 ──────────────────────────> │
      └──> 4.2 ──────────────────────────> 4.3
```

## Summary

| Phase                   | Tasks                        | Total  |
| ----------------------- | ---------------------------- | ------ |
| 1. Foundation           | 1.1, 1.2, 1.3, 1.4           | 4      |
| 2. Core Components      | 2.1, 2.2, 2.3, 2.4, 2.5, 2.6 | 6      |
| 3. Content & Polish     | 3.1, 3.2, 3.3                | 3      |
| 4. Testing & Validation | 4.1, 4.2, 4.3                | 3      |
| **Total**               |                              | **16** |

**New files:** ~20 (types, hooks, components, dialogs, tests, showcase)
**Modified files:** ~7 (app-store, DashboardPage, DashboardSidebar, SessionSidebar, SidebarTabRow, SettingsDialog, features-sections)
