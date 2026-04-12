# Task Breakdown: Shell-Level Right Panel Infrastructure

Generated: 2026-04-12
Source: specs/shell-level-right-panel/02-specification.md
Last Decompose: 2026-04-12

## Overview

Add a shell-level right panel to AppShell that wraps the `<Outlet />` in a horizontal `PanelGroup`. The right panel is a multi-occupancy container driven by the extension registry: any feature can register a tab via the new `rightpanel` contribution slot. The existing canvas feature becomes the first right-panel tab, migrated from its current page-level `PanelGroup` in SessionPage. This spec covers the infrastructure layer only -- PanelGroup, contribution slot, container component, toggle button, keyboard shortcut, state management, canvas migration, and SessionPage simplification.

## Phase 1: Foundation

### Task 1.1: Add RightPanelSlice to Zustand app store with localStorage persistence

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- Create `app-store-right-panel.ts` with `RightPanelSlice` interface and `createRightPanelSlice` state creator
- Slice fields: `rightPanelOpen` (boolean), `toggleRightPanel`, `setRightPanelOpen`, `activeRightPanelTab` (string|null), `setActiveRightPanelTab`, `loadRightPanelState`
- Add `RIGHT_PANEL_STATE: 'dorkos-right-panel-state'` to `STORAGE_KEYS` in constants.ts
- Add `readRightPanelState` and `writeRightPanelState` helpers to `app-store-helpers.ts`
- Extend `AppState` type to include `RightPanelSlice`
- Compose slice into main store in `app-store.ts`
- Add localStorage cleanup to `resetPreferences`
- Export `RightPanelSlice` type from `app-store/index.ts`

**Implementation Steps**:

1. Add `RIGHT_PANEL_STATE` key to `STORAGE_KEYS` in `apps/client/src/layers/shared/lib/constants.ts`
2. Add `RightPanelStateEntry` interface, `readRightPanelState`, and `writeRightPanelState` to `app-store-helpers.ts`
3. Create `apps/client/src/layers/shared/model/app-store/app-store-right-panel.ts`
4. Import `RightPanelSlice` and add to `AppState` intersection in `app-store-types.ts`
5. Import and compose `createRightPanelSlice` in `app-store.ts`
6. Add `localStorage.removeItem(STORAGE_KEYS.RIGHT_PANEL_STATE)` to `resetPreferences`
7. Export type from `app-store/index.ts`
8. Write 6 unit tests in `app-store/__tests__/app-store-right-panel.test.ts`

**Acceptance Criteria**:

- [ ] `app-store-right-panel.ts` exists with complete slice
- [ ] `STORAGE_KEYS.RIGHT_PANEL_STATE` is `'dorkos-right-panel-state'`
- [ ] Persistence helpers handle corrupt/missing localStorage gracefully
- [ ] `AppState` includes `RightPanelSlice`
- [ ] `resetPreferences` clears the new localStorage key
- [ ] All 6 unit tests pass
- [ ] TypeScript compiles cleanly

---

### Task 1.2: Add right-panel slot to extension registry with RightPanelContribution interface

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- Add `RIGHT_PANEL: 'right-panel'` to `SLOT_IDS`
- Define `RightPanelContribution` interface extending `BaseContribution` with: `title` (string), `icon` (LucideIcon), `component` (ComponentType), `visibleWhen?` ((ctx: { pathname: string }) => boolean)
- Add `'right-panel': RightPanelContribution` to `SlotContributionMap`
- Export `RightPanelContribution` from shared model barrel

**Implementation Steps**:

1. Add `RIGHT_PANEL` to `SLOT_IDS` in `extension-registry.ts`
2. Add `RightPanelContribution` interface
3. Extend `SlotContributionMap`
4. Export from `shared/model/index.ts`
5. Add 5 new test cases to `extension-registry.test.ts`

**Acceptance Criteria**:

- [ ] `SLOT_IDS.RIGHT_PANEL` equals `'right-panel'`
- [ ] `RightPanelContribution` interface is correctly typed
- [ ] `visibleWhen` receives `{ pathname: string }` context
- [ ] All 5 new tests pass
- [ ] Existing extension registry tests continue to pass

---

### Task 1.3: Create RightPanelContainer with desktop Panel and mobile Sheet rendering

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 1.4

**Technical Requirements**:

- Desktop: renders `PanelResizeHandle` + `Panel` (id="right-panel", order=2, defaultSize=35, minSize=20, collapsible)
- Mobile (768px breakpoint): renders `Sheet` with `SheetContent side="right"`
- Returns null when panel is closed or no visible contributions
- Filters contributions via `visibleWhen({ pathname })` using `useRouterState`
- Auto-selects first visible tab when active tab disappears
- Tab bar hidden when single contribution visible
- Wraps active component in `PanelErrorBoundary` + `Suspense`
- `onCollapse` callback syncs to `setRightPanelOpen(false)`

**Implementation Steps**:

1. Create `apps/client/src/layers/features/right-panel/ui/PanelErrorBoundary.tsx`
2. Create `apps/client/src/layers/features/right-panel/ui/RightPanelContainer.tsx`
3. Write 7 test cases in `__tests__/RightPanelContainer.test.tsx`

**Acceptance Criteria**:

- [ ] Returns null when closed or no visible contributions
- [ ] Desktop: PanelResizeHandle + Panel with correct config
- [ ] Mobile: Sheet with SheetContent side="right"
- [ ] Tab bar hidden/shown based on contribution count
- [ ] Auto-tab selection when active tab becomes invisible
- [ ] Error boundary catches render errors
- [ ] All tests pass

---

### Task 1.4: Create RightPanelTabBar component with icon buttons and tooltips

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 1.3

**Technical Requirements**:

- Renders one icon button per contribution
- Active tab: `aria-pressed="true"`, `bg-accent text-accent-foreground`
- Inactive tabs: `text-muted-foreground hover:text-foreground`
- Each button has `aria-label` set to contribution's `title`
- Tooltips show contribution title on hover
- Calls `onTabChange(contributionId)` on click

**Implementation Steps**:

1. Create `apps/client/src/layers/features/right-panel/ui/RightPanelTabBar.tsx`
2. Write 4 test cases in `__tests__/RightPanelTabBar.test.tsx`

**Acceptance Criteria**:

- [ ] One button per contribution with correct accessibility
- [ ] Active/inactive styling applied correctly
- [ ] Click handler calls `onTabChange` with contribution ID
- [ ] All 4 tests pass

---

### Task 1.5: Create right-panel persistence hook and barrel exports

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 1.3, Task 1.4

**Technical Requirements**:

- `useRightPanelPersistence` hook calls `loadRightPanelState` once on mount
- Barrel `index.ts` exports `RightPanelContainer`, `RightPanelTabBar`, `useRightPanelPersistence`

**Implementation Steps**:

1. Create `apps/client/src/layers/features/right-panel/model/use-right-panel-persistence.ts`
2. Create `apps/client/src/layers/features/right-panel/index.ts`

**Acceptance Criteria**:

- [ ] Hook hydrates panel state on mount
- [ ] Barrel exports all required symbols
- [ ] FSD import rules followed

---

### Task 1.6: Integrate PanelGroup and RightPanelContainer into AppShell

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3, Task 1.5

**Technical Requirements**:

- Wrap `<Outlet />` in `PanelGroup` with `direction="horizontal"` and `autoSaveId="app-shell-right-panel"`
- Main Panel: `id="main-content"`, `order={1}`, `minSize={30}`, `defaultSize={100}`
- `RightPanelContainer` renders as sibling after main Panel
- Call `useRightPanelPersistence()` in AppShell
- Update existing tests if they reference the `<main>` structure

**Implementation Steps**:

1. Add imports for `PanelGroup`, `Panel`, `RightPanelContainer`, `useRightPanelPersistence`
2. Replace `<Outlet />` with PanelGroup structure
3. Add `useRightPanelPersistence()` hook call
4. Update affected tests with mocks for `react-resizable-panels` and right-panel feature

**Acceptance Criteria**:

- [ ] PanelGroup wraps Outlet with correct config
- [ ] RightPanelContainer is rendered inside PanelGroup
- [ ] `useRightPanelPersistence()` called in AppShell
- [ ] All existing routes render correctly
- [ ] All AppShell tests pass

---

## Phase 2: Canvas Migration

### Task 2.1: Extract CanvasContent from AgentCanvas and export from canvas barrel

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.6

**Technical Requirements**:

- Extract `CanvasContent` component from `AgentCanvas.tsx` -- renders `CanvasBody` without Panel/Sheet wrapper
- `CanvasContent` reads state from `useAppStore` (canvasContent, setCanvasOpen, setCanvasContent)
- Close handler calls `setCanvasOpen(false)` (does NOT close the right panel)
- Export `CanvasContent` from `features/canvas/index.ts`
- Keep existing `AgentCanvas` for backward compatibility during migration

**Implementation Steps**:

1. Add `CanvasContent` export to `AgentCanvas.tsx`
2. Add `CanvasContent` export to `features/canvas/index.ts`
3. Write 2 test cases in `__tests__/CanvasContent.test.tsx`

**Acceptance Criteria**:

- [ ] `CanvasContent` renders without Panel/Sheet wrappers
- [ ] Close handler clears canvas state without closing right panel
- [ ] Exported from canvas barrel
- [ ] Existing `AgentCanvas` unchanged
- [ ] Tests pass

---

### Task 2.2: Register canvas as right-panel contribution in init-extensions

**Size**: Small
**Priority**: High
**Dependencies**: Task 2.1

**Technical Requirements**:

- Register canvas in `init-extensions.ts` as `right-panel` contribution
- `id: 'canvas'`, `title: 'Canvas'`, `icon: PanelRight`, `priority: 20`
- `component: lazy(() => import(...).then(m => ({ default: m.CanvasContent })))`
- `visibleWhen: ({ pathname }) => pathname === '/session'`

**Implementation Steps**:

1. Add `PanelRight` import from lucide-react
2. Add `register('right-panel', { ... })` call with lazy-loaded `CanvasContent`

**Acceptance Criteria**:

- [ ] Canvas registered as right-panel contribution
- [ ] Uses React.lazy for code-splitting
- [ ] `visibleWhen` returns true only for `/session`
- [ ] Priority is 20
- [ ] TypeScript compiles cleanly

---

### Task 2.3: Simplify SessionPage to remove PanelGroup and AgentCanvas

**Size**: Small
**Priority**: High
**Dependencies**: Task 2.2, Task 1.6

**Technical Requirements**:

- Remove `Panel`, `PanelGroup`, `PanelResizeHandle` imports from SessionPage
- Remove `AgentCanvas` import
- Remove per-session `autoSaveId` logic
- Keep `useCanvasPersistence(activeSessionId)` (still needed for per-session content hydration)
- Render `ChatPanel` directly without PanelGroup wrapper

**Implementation Steps**:

1. Rewrite `SessionPage.tsx` to minimal form
2. Rewrite `SessionPage.test.tsx` with 3 test cases

**Acceptance Criteria**:

- [ ] No PanelGroup in SessionPage
- [ ] No AgentCanvas import
- [ ] `useCanvasPersistence` still called
- [ ] ChatPanel renders directly
- [ ] All 3 tests pass

---

## Phase 3: Toggle and Shortcut

### Task 3.1: Create RightPanelToggle component and add to AppShell header

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.6
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- `PanelRight` icon when closed, `PanelRightClose` icon when open
- Hidden when no contributions have `visibleWhen` returning true on current route
- Spring animation: `whileHover={{ scale: 1.1 }}`, `whileTap={{ scale: 0.93 }}`, `transition={{ type: 'spring', stiffness: 600, damping: 35 }}`
- Tooltip with "Toggle right panel" and keyboard shortcut label
- Positioned at far right of AppShell header, symmetric with SidebarTrigger

**Implementation Steps**:

1. Create `apps/client/src/layers/features/right-panel/ui/RightPanelToggle.tsx`
2. Add `RightPanelToggle` export to barrel index
3. Import and add `<RightPanelToggle />` to AppShell header after the AnimatePresence block
4. Write 5 test cases in `__tests__/RightPanelToggle.test.tsx`

**Acceptance Criteria**:

- [ ] Correct icon for open/closed states
- [ ] Hidden when no visible contributions
- [ ] Click calls `toggleRightPanel`
- [ ] Tooltip shows shortcut label
- [ ] Positioned at header far right
- [ ] All 5 tests pass

---

### Task 3.2: Create keyboard shortcut hook and replace canvas shortcut in AppShell

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.6
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- `useRightPanelShortcut` registers `Cmd+.` / `Ctrl+.` keydown listener
- Calls `toggleRightPanel` from store
- `e.preventDefault()` to suppress browser default
- Replace `useCanvasShortcut()` with `useRightPanelShortcut()` in AppShell

**Implementation Steps**:

1. Create `apps/client/src/layers/features/right-panel/model/use-right-panel-shortcut.ts`
2. Add export to barrel index
3. Replace `useCanvasShortcut` import/call with `useRightPanelShortcut` in AppShell
4. Write 4 test cases in `__tests__/use-right-panel-shortcut.test.ts`

**Acceptance Criteria**:

- [ ] Shortcut fires `toggleRightPanel` on `Cmd+.` / `Ctrl+.`
- [ ] Does not fire without modifier key
- [ ] `e.preventDefault()` called
- [ ] AppShell uses new hook, not old one
- [ ] All 4 tests pass

---

### Task 3.3: Remove CanvasToggle from SessionHeader and clean up canvas shortcut

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.1, Task 3.2, Task 2.3

**Technical Requirements**:

- Remove `CanvasToggle` import and usage from `SessionHeader.tsx`
- Delete `apps/client/src/layers/features/canvas/model/use-canvas-shortcut.ts`
- Remove `useCanvasShortcut` export from `features/canvas/index.ts`
- Verify no remaining imports of `useCanvasShortcut` or `CanvasToggle` (outside canvas feature)

**Implementation Steps**:

1. Edit `SessionHeader.tsx` to remove `CanvasToggle` import and JSX
2. Delete `use-canvas-shortcut.ts`
3. Update `features/canvas/index.ts` to remove `useCanvasShortcut` export
4. Grep codebase to verify no remaining external imports

**Acceptance Criteria**:

- [ ] SessionHeader renders without CanvasToggle
- [ ] `use-canvas-shortcut.ts` deleted
- [ ] No remaining imports of `useCanvasShortcut`
- [ ] TypeScript compiles cleanly
- [ ] All existing tests pass

---

## Dependency Graph

```
Phase 1 (Foundation):
  1.1 ─────────────┐
  1.2 ──┬──────────┤
        │          ├─ 1.3 ─┐
        └── 1.4 ──┘        ├─ 1.5 ── 1.6
                            │
Phase 2 (Canvas Migration):
                   1.6 ── 2.1 ── 2.2 ── 2.3

Phase 3 (Toggle and Shortcut):
                   1.6 ──┬── 3.1 ──┐
                         └── 3.2 ──┼── 3.3
                              2.3 ─┘
```

## Parallel Opportunities

- **Tasks 1.1 and 1.2**: Zustand slice and extension registry changes are independent
- **Tasks 1.3 and 1.4**: Container and tab bar components can be built simultaneously
- **Tasks 3.1 and 3.2**: Toggle component and shortcut hook are independent

## Critical Path

1.1 -> 1.3 -> 1.5 -> 1.6 -> 2.1 -> 2.2 -> 2.3 -> 3.3
