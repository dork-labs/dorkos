---
slug: ext-platform-02-extension-registry
number: 182
created: 2026-03-26
status: ideation
---

# Phase 2: Extension Point Registry

**Slug:** ext-platform-02-extension-registry
**Author:** Claude Code
**Date:** 2026-03-26
**Branch:** preflight/ext-platform-02-extension-registry

---

## 1) Intent & Assumptions

- **Task brief:** Create the extensibility infrastructure that both built-in features and future extensions register into. Extract implicit extension patterns from hardcoded arrays (command palette features, dialog lists, sidebar buttons, dashboard sections) and replace them with a queryable Zustand registry store. Built-in features register into the registry at app startup; the registry API is the same one extensions will use in Phase 3. This is a pure refactor — zero user-visible behavior changes.
- **Assumptions:**
  - Phase 1 (Agent UI Control & Canvas) is independent and can be built in parallel
  - The 8 slot IDs in the brief cover all current extensible surfaces
  - Zustand is the right state management (consistent with `app-store.ts` pattern)
  - FSD layer rules allow `shared/model/` to host the registry store
  - All hardcoded lists are small (4-10 items) — no performance concerns with registry lookup
  - Existing tests must continue passing with no behavioral changes
- **Out of scope:**
  - Third-party extension loading (Phase 3)
  - Agent-built extensions (Phase 4)
  - New extension points not already in the codebase
  - Server-side extension registry
  - Changes to `app-store.ts` dialog state fields (dialogs still use `settingsOpen`, `pulseOpen`, etc.)

## Source Brief

File: `specs/ext-platform-02-extension-registry/00-brief.md`

Key details preserved from the brief:

- 8 slot IDs defined with specific contribution types
- 5 settled decisions (Zustand store, string constants, auto-cleanup via unsubscribe, built-in features register first, priority ordering lower=higher)
- 6 open questions explicitly labeled "For /ideate"
- Acceptance criteria: 14 items covering registry store, hooks, migrations, and tests
- Part of a 4-phase Extensibility Platform project (this is Phase 2)

---

## 2) Pre-reading Log

- `apps/client/src/layers/shared/model/app-store.ts`: Central Zustand store (497 lines). Uses `devtools` middleware. Pattern: `create<AppState>()(devtools((set) => ({ ... }), { name: 'app-store' }))`. Persists UI state to localStorage. Dialog state managed via boolean fields (`settingsOpen`, `pulseOpen`, etc.) with setter actions.
- `apps/client/src/layers/features/command-palette/model/use-palette-items.ts`: Two hardcoded static arrays — `FEATURES` (4 items: pulse, relay, mesh, settings) and `QUICK_ACTIONS` (6 items: dashboard, new-session, create-agent, discover, browse, theme). Types well-defined (`FeatureItem`, `QuickActionItem`). Consumed directly by `usePaletteItems()` hook. Searchable items constructed in `useMemo()` loop.
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx`: 6 hardcoded dialogs (SettingsDialog, DirectoryPicker, PulsePanel, RelayPanel, MeshPanel, AgentDialog) plus OnboardingFlow overlay. All controlled by `useAppStore()` boolean fields. No dynamic registration.
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`: 4 hardcoded icon buttons (edit agent, settings, theme toggle, devtools toggle). Direct event handlers binding to `useAppStore()` actions. No abstraction layer.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Tab system using `useSidebarTabs()` hook. `visibleTabs` computed dynamically based on `pulseToolEnabled` flag. Tabs: overview, sessions, schedules (conditional), connections.
- `apps/client/src/layers/features/session-list/model/use-sidebar-tabs.ts`: Clean pattern for conditional visibility — tests feature flag, builds `SidebarTab[]` dynamically. Keyboard shortcut mapping. Falls back if active tab becomes hidden.
- `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx`: 5 sections in fixed priority order (NeedsAttentionSection, PromoSlot, ActiveSessionsSection, SystemStatusRow, RecentActivityFeed). Composed in fixed layout via ScrollArea.
- `apps/client/src/layers/features/top-nav/ui/DashboardHeader.tsx`: Header action buttons hardcoded per route.
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`: Settings dialog with tab system — another extensible surface.
- `apps/client/src/main.tsx`: App entry point. `Root` component renders `RouterProvider`. `createRoot().render()` at bottom.
- `apps/client/src/AppShell.tsx`: App shell renders `DialogHost`, sidebar, header, and route outlet.
- `apps/client/src/layers/shared/model/index.ts`: Barrel exports all hooks and stores from `shared/model/`.
- `contributing/state-management.md`: Documents Zustand patterns. Key rule: Zustand for global client state, TanStack Query for server state.
- `contributing/project-structure.md`: FSD layer hierarchy (app → widgets → features → entities → shared). Strict unidirectional imports enforced by ESLint. Every module has `index.ts` barrel.
- `specs/plugin-extension-system/01-ideation.md` (spec #173): Previous extension system ideation. Converged on Zustand store, 7 v1 slot IDs, `registerComponent()` API.
- `research/20260323_plugin_extension_ui_architecture_patterns.md`: VSCode contribution points, Obsidian `register*()` cleanup pattern, Backstage `createExtensionPoint<T>({ id })` typed factory, Grafana props-as-contract rendering.

---

## 3) Codebase Map

- **Primary components/modules:**
  - `layers/shared/model/app-store.ts` — Central Zustand store, dialog state
  - `layers/features/command-palette/model/use-palette-items.ts` — `FEATURES[]` (4) + `QUICK_ACTIONS[]` (6), consumed by `CommandPaletteDialog`
  - `layers/widgets/app-layout/ui/DialogHost.tsx` — 6 hardcoded dialogs, controlled by app-store booleans
  - `layers/features/session-list/ui/SidebarFooterBar.tsx` — 4 hardcoded icon buttons
  - `layers/features/session-list/ui/SessionSidebar.tsx` — Tab system via `useSidebarTabs()` hook
  - `layers/features/session-list/model/use-sidebar-tabs.ts` — Conditional tab visibility (feature flags)
  - `layers/widgets/dashboard/ui/DashboardPage.tsx` — 5 dashboard sections in priority order
  - `layers/features/top-nav/ui/DashboardHeader.tsx` — Header action buttons
  - `layers/features/settings/ui/SettingsDialog.tsx` — Settings tab system

- **Shared dependencies:**
  - `useAppStore()` — Dialog open/close state and setters
  - `shared/model/index.ts` — Barrel exports for all shared model hooks/stores
  - `shared/ui/` — Shadcn primitives (Button, Dialog, etc.)
  - `lucide-react` — Icon components used by footer buttons and palette items

- **Data flow:**
  - Hardcoded arrays → `useMemo()` / direct render → Component output
  - After migration: `initializeExtensions()` → registry store → `useSlotContributions(slotId)` → component render
  - Dialog state flow unchanged: `useAppStore().setSettingsOpen(true)` → `DialogHost` renders conditionally

- **Feature flags/config:**
  - `pulseToolEnabled` controls sidebar tab visibility (already dynamic)
  - Dev mode flag controls devtools button visibility in footer

- **Potential blast radius:**
  - Direct: 6 files need migration (palette items, DialogHost, SidebarFooterBar, SessionSidebar/tabs, DashboardPage, headers)
  - New files: 2 (extension-registry store, init-extensions)
  - Modified barrels: 2 (`shared/model/index.ts`, feature barrels for registration exports)
  - Tests: 4+ test suites must continue passing (`use-palette-items.test.ts`, `DialogHost.test.tsx`, `SidebarFooterBar.test.tsx`, `SessionSidebar.test.tsx`)

---

## 4) Root Cause Analysis

N/A — this is a refactor, not a bug fix.

---

## 5) Research

### Existing Research (Cached)

- `research/20260323_plugin_extension_ui_architecture_patterns.md` — Established patterns: VSCode `group@N` menu ordering, Obsidian auto-cleanup `register*()` (direct model for unsubscribe returns), Backstage `createExtensionPoint<T>({ id })` generic typed factory, Grafana props-as-contract rendering.
- `specs/plugin-extension-system/01-ideation.md` (spec #173) — Converged on Zustand store, 7 v1 slot IDs, `registerComponent(slot, id, component, meta)` API.

### New Research

Full report saved to `research/20260326_extension_point_registry_patterns.md`. 15 sources analyzed including Backstage extension points, react-slots libraries, TypeScript registry patterns, Zustand testing guides, and FSD layer documentation.

### Potential Solutions

**1. Single Generic `register<K>()` Method + `SlotContributionMap`**

- Description: One `register<K extends SlotId>(slotId: K, contribution: SlotContributionMap[K])` method. TypeScript infers the correct contribution type from the slot ID argument. Convenience wrappers (`registerCommand()`, `registerDialog()`) are thin aliases.
- Pros:
  - Per-slot type safety without method proliferation
  - TypeScript infers correct types — impossible to register wrong shape
  - Single API to learn; aliases are optional sugar
  - `SlotContributionMap` as `interface` enables future `declare module` augmentation for third-party slots
- Cons:
  - Slightly less discoverable than named methods (mitigated by aliases)
  - Requires understanding mapped types to extend
- Complexity: Medium
- Maintenance: Low

**2. Separate Methods Per Slot Type**

- Description: `registerCommand()`, `registerDialog()`, `registerFooterButton()`, `registerDashboardSection()`, etc. Each method is independently typed.
- Pros:
  - Maximum discoverability — autocomplete shows all options
  - Each method has its own JSDoc
- Cons:
  - Method count scales with slot count (8+ methods in v1)
  - Adding a new slot requires adding a new method
  - No unified API — extensions must know which method to call
- Complexity: Low (per method), High (aggregate)
- Maintenance: High

**3. Generic `register()` with Discriminated Union**

- Description: Single method, but contribution types are a large discriminated union keyed by `type` field.
- Pros:
  - Single method
  - Runtime type checking possible
- Cons:
  - Performance: large unions degrade TypeScript type-checker (confirmed by Slash Engineering research on 1M-line codebases)
  - Verbose: every contribution needs a `type` discriminant
  - Not extensible via declaration merging
- Complexity: Medium
- Maintenance: Medium

### Recommendation

**Recommended Approach:** Single Generic `register<K>()` with `SlotContributionMap` interface (Option 1).

**Rationale:** Best balance of type safety, simplicity, and extensibility. TypeScript's generic inference makes the single method feel like slot-specific methods at the call site. The `interface` declaration enables Phase 3 extensions to add new slot types via module augmentation without modifying core code. Convenience aliases provide discoverability without API sprawl.

---

## 6) Decisions

| #   | Decision                    | Choice                                                                                                                                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                              |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Registry API shape          | Single generic `register<K extends SlotId>(slotId, contribution)` with `SlotContributionMap`                                                                                                                                                                                                                                                     | Type-safe per slot, extensible via module augmentation, no method proliferation. Convenience aliases optional.                                                                                         |
| 2   | TypeScript typing for slots | `SlotContributionMap` interface (not `type` alias) mapping slot IDs to contribution interfaces                                                                                                                                                                                                                                                   | Enables `declare module` augmentation for Phase 3 extensibility. Avoids discriminated union performance issues.                                                                                        |
| 3   | Empty state handling        | Slot components own their empty state; registry returns `[]` for empty slots                                                                                                                                                                                                                                                                     | Each slot has domain-specific empty state logic. Registry stays simple — it's just a container.                                                                                                        |
| 4   | FSD layer placement         | Registry store in `shared/model/`. Initialization function in app layer (`init-extensions.ts` called from `main.tsx`).                                                                                                                                                                                                                           | `shared/model/` is the established pattern for Zustand stores. App layer is the only FSD layer that can import from all other layers, making it the correct place for wiring features to the registry. |
| 5   | `session.canvas` slot       | Define slot ID and placeholder contribution type now, but register nothing into it                                                                                                                                                                                                                                                               | Keeps slot table complete. Avoids breaking type changes when Phase 1 lands. Phase 1 will be first consumer.                                                                                            |
| 6   | Testing strategy            | Test Zustand store directly via `getState()` without React rendering. Reset with `setState(getInitialState(), true)` in `beforeEach`. Five core test cases: register-and-retrieve, unregister-removes, priority-ordering, cross-slot-isolation, empty-slot-returns-empty-array. Integration tests for slot components use `render()` separately. | Direct store testing is faster and more focused. Matches Zustand's recommended testing pattern. Existing component tests continue passing via registry.                                                |
| 7   | Priority/ordering system    | Numeric `priority` field, lower = higher priority, default = 50. Sort at render time in slot components (not at registration time). Stable sort with insertion order as tie-breaker. Convention: 1-10 core, 50 default, 90-100 tail.                                                                                                             | Simple, predictable, matches the brief's settled decision. No groups or before/after anchoring needed for v1.                                                                                          |
| 8   | Initialization pattern      | Explicit `initializeExtensions()` in `apps/client/src/app/init-extensions.ts`, called synchronously from `main.tsx` before `createRoot().render()`. Features export contribution data via barrels; init wires them to registry.                                                                                                                  | Only FSD-compliant pattern — app layer can import from all layers. Synchronous call ensures registry is populated before components mount. Features never import each other.                           |
| 9   | Migration scope             | Full migration: all built-in features register through the registry                                                                                                                                                                                                                                                                              | Proves the registry pattern end-to-end before Phase 3. Single source of truth for extensible content. The whole purpose of Phase 2 is to validate the pattern with real use.                           |
