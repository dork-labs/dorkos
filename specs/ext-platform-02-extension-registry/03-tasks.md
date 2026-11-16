# Extension Point Registry — Task Breakdown

**Spec:** `specs/ext-platform-02-extension-registry/02-specification.md`
**Generated:** 2026-03-26
**Mode:** Full

---

## Phase 1: Registry Core

### Task 1.1 — Create extension registry store, types, and hook

**Size:** Medium | **Priority:** High | **Dependencies:** None

Create the extension point registry as a Zustand store with typed slot contributions, a convenience query hook, and unit tests.

**Files to create:**

- `apps/client/src/layers/shared/model/extension-registry.ts` — Zustand store with `devtools` middleware, all 8 slot ID constants, typed contribution interfaces (`SidebarFooterContribution`, `SidebarTabContribution`, `DashboardSectionContribution`, `HeaderActionContribution`, `CommandPaletteContribution`, `DialogContribution`, `SettingsTabContribution`, `SessionCanvasContribution`), `SlotContributionMap` interface (not `type` — for future module augmentation), `register<K>()` returning unsubscribe function, `getContributions<K>()`, `useSlotContributions<K>()` convenience hook with priority sorting
- `apps/client/src/layers/shared/model/__tests__/extension-registry.test.ts` — 7 unit tests: register-and-retrieve, unregister-removes, priority-ordering, cross-slot-isolation, empty-slot-returns-empty-array, default-priority-50, stable-sort-tie-breaking

**Files to modify:**

- `apps/client/src/layers/shared/model/index.ts` — Add barrel exports for `useExtensionRegistry`, `useSlotContributions`, `createInitialSlots`, `SLOT_IDS`, and all type exports

**Acceptance criteria:**

- Store uses `devtools` middleware (matches `app-store.ts` pattern)
- `SlotContributionMap` is an `interface` for future `declare module` augmentation
- `register()` returns unsubscribe function; calling it removes the contribution
- `useSlotContributions()` returns priority-sorted contributions (lower = first, default 50, stable sort)
- All 7 unit tests pass
- Exports available from `@/layers/shared/model` barrel

---

## Phase 2: Initialization Wiring

### Task 2.1 — Create contribution data files for command palette and dialogs

**Size:** Large | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.2

Extract hardcoded command palette items into typed contribution data. Create dialog contribution data with wrapper components.

**Files to create:**

- `apps/client/src/layers/features/command-palette/model/palette-contributions.ts` — `PALETTE_FEATURES` (4 items: pulse, relay, mesh, settings) and `PALETTE_QUICK_ACTIONS` (6 items: dashboard, new-session, create-agent, discover, browse, theme) typed as `CommandPaletteContribution[]`. Data matches current `FEATURES[]` and `QUICK_ACTIONS[]` exactly.
- Dialog wrapper components in `apps/client/src/layers/widgets/app-layout/ui/dialog-wrappers/` — 6 wrappers (SettingsDialogWrapper, DirectoryPickerWrapper, PulseDialogWrapper, RelayDialogWrapper, MeshDialogWrapper, AgentDialogWrapper), each accepting `{ open, onOpenChange }`. Wrappers contain the ResponsiveDialog chrome currently in `DialogHost.tsx`.
- `apps/client/src/layers/widgets/app-layout/model/dialog-contributions.ts` — `DIALOG_CONTRIBUTIONS` (6 items) typed as `DialogContribution[]`

**Files to modify:**

- `apps/client/src/layers/features/command-palette/index.ts` — Add barrel exports for `PALETTE_FEATURES` and `PALETTE_QUICK_ACTIONS`

**Acceptance criteria:**

- Contribution data matches current hardcoded arrays exactly (same ids, labels, icons, actions)
- Each dialog wrapper renders identical JSX to current DialogHost (same class names, titles, descriptions)
- Barrel re-exports contribution data

---

### Task 2.2 — Create contribution data files for sidebar and dashboard

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.1

Extract hardcoded sidebar footer buttons, sidebar tabs, and dashboard sections into typed contribution data files.

**Files to create:**

- `apps/client/src/layers/features/session-list/model/sidebar-contributions.ts` — `SIDEBAR_FOOTER_BUTTONS` (4 items: edit-agent, settings, theme, devtools) typed as `SidebarFooterContribution[]` and `SIDEBAR_TAB_CONTRIBUTIONS` (4 items: overview, sessions, schedules with `visibleWhen`, connections) typed as `SidebarTabContribution[]`
- `apps/client/src/layers/widgets/dashboard/model/dashboard-contributions.ts` — `DASHBOARD_SECTION_CONTRIBUTIONS` (5 items: needs-attention, promo, active-sessions, system-status, recent-activity) typed as `DashboardSectionContribution[]`, with a `PromoSlotWrapper` component that passes `placement="dashboard-main"` and `maxUnits={4}`

**Files to modify:**

- `apps/client/src/layers/features/session-list/index.ts` — Add barrel exports for `SIDEBAR_FOOTER_BUTTONS` and `SIDEBAR_TAB_CONTRIBUTIONS`
- `apps/client/src/layers/widgets/dashboard/index.ts` — Add barrel export for `DASHBOARD_SECTION_CONTRIBUTIONS`

**Acceptance criteria:**

- Footer button data matches current inline handlers
- Sidebar tab data matches current tab configuration (schedules has `visibleWhen` predicate)
- Dashboard sections match current order and composition
- Barrel re-exports all contribution data

---

### Task 2.3 — Create init-extensions.ts and wire into main.tsx

**Size:** Small | **Priority:** High | **Dependencies:** 2.1, 2.2

Create the app-layer initialization function and wire it into the entry point.

**Files to create:**

- `apps/client/src/app/init-extensions.ts` — `initializeExtensions()` function that calls `useExtensionRegistry.getState().register()` for all contribution data from feature barrels

**Files to modify:**

- `apps/client/src/main.tsx` — Import and call `initializeExtensions()` synchronously before `ReactDOM.createRoot().render()`

**Acceptance criteria:**

- `initializeExtensions()` called before React renders
- Registry contains all built-in contributions when components mount
- App layer correctly imports from all FSD layers (only layer allowed to do so)

---

## Phase 3: Component Migrations

### Task 3.1 — Migrate use-palette-items.ts to query registry

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.3 | **Parallel with:** 3.3, 3.4, 3.5

Replace `FEATURES[]` and `QUICK_ACTIONS[]` constants with `useSlotContributions('command-palette.items')` query, filtering by `category`.

**Files to modify:**

- `apps/client/src/layers/features/command-palette/model/use-palette-items.ts` — Remove `FEATURES` and `QUICK_ACTIONS` constants, add `useSlotContributions` import, filter registry results by `category: 'feature'` and `category: 'quick-action'`, update `searchableItems` dependencies, update return statement

**Acceptance criteria:**

- Hook queries registry instead of using hardcoded arrays
- `features` still returns 4 items, `quickActions` still returns 6 items
- `searchableItems` includes registry-sourced items
- `FeatureItem` and `QuickActionItem` types still exported for backward compatibility
- Return shape (`PaletteItems`) unchanged

---

### Task 3.2 — Migrate DialogHost.tsx to query registry

**Size:** Large | **Priority:** Medium | **Dependencies:** 2.3

Replace hardcoded dialog renders with registry-driven loop from `useSlotContributions('dialog')`.

**Files to create:**

- 6 dialog wrapper components in `apps/client/src/layers/widgets/app-layout/ui/dialog-wrappers/` (if not already created in 2.1)

**Files to modify:**

- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` — Replace 6 hardcoded dialog renders with `.map()` over dialog contributions, derive setter from `openStateKey`, keep OnboardingFlow hardcoded, remove unused imports
- `apps/client/src/app/init-extensions.ts` — Add dialog contribution registration

**Acceptance criteria:**

- `DialogHost` queries `useSlotContributions('dialog')` and renders dynamically
- Setter derived from `openStateKey` (e.g., `settingsOpen` -> `setSettingsOpen`)
- OnboardingFlow remains hardcoded (overlay, not standard dialog)
- All 6 dialogs render with identical behavior
- No user-visible change

---

### Task 3.3 — Migrate SidebarFooterBar.tsx to query registry

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.3 | **Parallel with:** 3.1, 3.4, 3.5

Replace hardcoded icon buttons with `useSlotContributions('sidebar.footer')` query.

**Files to modify:**

- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx` — Add registry query, filter by `showInDevOnly`, render buttons via `.map()`, handle theme button dynamic icon by checking `button.id === 'theme'`, handle devtools amber styling by checking `button.id === 'devtools'`, keep logo/version/upgrade card hardcoded

**Acceptance criteria:**

- 4 buttons render in same order via priority sorting
- Theme button cycles light/dark/system with dynamic icon
- Devtools button filtered in production, amber when active
- Logo, version display, upgrade card unchanged

---

### Task 3.4 — Migrate use-sidebar-tabs.ts to query registry

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.3 | **Parallel with:** 3.1, 3.3, 3.5

Replace hardcoded tab array with `useSlotContributions('sidebar.tabs')` query. Change hook signature from `useSidebarTabs(pulseToolEnabled: boolean)` to `useSidebarTabs()`.

**Files to modify:**

- `apps/client/src/layers/features/session-list/model/use-sidebar-tabs.ts` — Remove `pulseToolEnabled` parameter, query registry, filter by `visibleWhen` predicates, map to `SidebarTab` IDs
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` (and any other callers) — Update call from `useSidebarTabs(pulseToolEnabled)` to `useSidebarTabs()`

**Acceptance criteria:**

- Hook takes no arguments
- Tabs filtered by `visibleWhen` predicates (schedules tab reads `pulseToolEnabled` from store)
- Keyboard shortcuts still work
- Tab fallback logic preserved
- All callers updated

---

### Task 3.5 — Migrate DashboardPage.tsx to query registry

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.3 | **Parallel with:** 3.1, 3.3, 3.4

Replace hardcoded section composition with `useSlotContributions('dashboard.sections')` query.

**Files to modify:**

- `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx` — Add registry query, filter by `visibleWhen`, render sections via `.map()`, keep detail sheets hardcoded (route-driven overlays), remove section component imports

**Acceptance criteria:**

- 5 sections render in same priority order
- Detail sheets remain hardcoded
- Section component imports removed (provided via registry)
- No user-visible change

---

## Phase 4: Test Updates & Cleanup

### Task 4.1 — Update existing tests, remove dead code, update docs

**Size:** Large | **Priority:** Medium | **Dependencies:** 3.1, 3.2, 3.3, 3.4, 3.5

Update all affected test suites to mock or set up the registry, verify no dead code remains, and update contributing docs.

**Test files to update:**

- `apps/client/src/layers/features/command-palette/model/__tests__/use-palette-items.test.ts` — Mock `useSlotContributions` to return 10 palette items (4 features + 6 quick actions)
- `apps/client/src/layers/features/session-list/__tests__/SidebarFooterBar.test.tsx` — Mock `useSlotContributions` to return footer button contributions
- `apps/client/src/layers/features/session-list/__tests__/SessionSidebar.test.tsx` — Update `useSidebarTabs()` calls (no args), mock `useSlotContributions` for tab contributions

**Dead code verification:**

- `FEATURES` and `QUICK_ACTIONS` removed from `use-palette-items.ts`
- Old dialog imports removed from `DialogHost.tsx`
- Unused icon imports removed from `SidebarFooterBar.tsx`
- `pulseToolEnabled` parameter removed from `useSidebarTabs`
- Section component imports removed from `DashboardPage.tsx`

**Docs to update:**

- `contributing/state-management.md` — Add extension registry pattern documentation
- `contributing/project-structure.md` — Mention `app/init-extensions.ts` entry point

**Acceptance criteria:**

- Full test suite passes (`pnpm test -- --run`)
- No dead code from pre-migration patterns
- Contributing docs updated
- No user-visible behavior change end-to-end

---

## Task Dependency Graph

```
1.1 (Registry Core)
 ├── 2.1 (Palette + Dialog contributions) ──┐
 └── 2.2 (Sidebar + Dashboard contributions)┤
                                             └── 2.3 (init-extensions + main.tsx)
                                                  ├── 3.1 (Palette migration)     ──┐
                                                  ├── 3.2 (DialogHost migration)  ──┤
                                                  ├── 3.3 (Footer migration)      ──┤
                                                  ├── 3.4 (Tabs migration)        ──┤
                                                  └── 3.5 (Dashboard migration)   ──┤
                                                                                    └── 4.1 (Tests + Cleanup)
```

**Total tasks:** 10
**Estimated effort:** 2 medium sprints (Phase 1-2 can ship independently, Phase 3-4 follow)
