# Implementation Summary: Extension Point Registry

**Created:** 2026-03-26
**Last Updated:** 2026-03-26
**Spec:** specs/ext-platform-02-extension-registry/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 10 / 10

## Tasks Completed

### Session 1 - 2026-03-26

- Task #1: [P1] Create extension registry store, types, and hook
- Task #2: [P2] Create contribution data files for command palette and dialogs
- Task #3: [P2] Create contribution data files for sidebar and dashboard
- Task #4: [P2] Create init-extensions.ts and wire into main.tsx
- Task #5: [P3] Migrate use-palette-items.ts to query registry
- Task #6: [P3] Migrate DialogHost.tsx to query registry
- Task #7: [P3] Migrate SidebarFooterBar.tsx to query registry
- Task #8: [P3] Migrate use-sidebar-tabs.ts to query registry
- Task #9: [P3] Migrate DashboardPage.tsx to query registry
- Task #10: [P4] Update existing tests, remove dead code, update docs

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/shared/model/extension-registry.ts` (created) — Registry store, types, hook
- `apps/client/src/layers/shared/model/index.ts` (modified) — Barrel exports
- `apps/client/src/app/init-extensions.ts` (created) — App-layer initialization
- `apps/client/src/main.tsx` (modified) — Wired initializeExtensions() before render
- `apps/client/src/layers/features/command-palette/model/palette-contributions.ts` (created) — Palette contribution data
- `apps/client/src/layers/features/command-palette/model/use-palette-items.ts` (modified) — Registry query
- `apps/client/src/layers/features/command-palette/index.ts` (modified) — Barrel exports
- `apps/client/src/layers/widgets/app-layout/model/dialog-contributions.ts` (created) — Dialog contribution data
- `apps/client/src/layers/widgets/app-layout/model/wrappers/*.tsx` (created, 6 files) — Dialog wrapper components
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` (modified) — Registry-driven rendering
- `apps/client/src/layers/widgets/app-layout/index.ts` (modified) — Barrel exports
- `apps/client/src/layers/features/session-list/model/sidebar-contributions.ts` (created) — Sidebar contribution data
- `apps/client/src/layers/features/session-list/model/use-sidebar-tabs.ts` (modified) — Registry query
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx` (modified) — Registry-driven rendering
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` (modified) — Updated hook call
- `apps/client/src/layers/features/session-list/index.ts` (modified) — Barrel exports
- `apps/client/src/layers/widgets/dashboard/model/dashboard-contributions.tsx` (created) — Dashboard contribution data
- `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx` (modified) — Registry-driven rendering
- `apps/client/src/layers/widgets/dashboard/index.ts` (modified) — Barrel exports
- `contributing/state-management.md` (modified) — Extension registry pattern docs
- `contributing/project-structure.md` (modified) — init-extensions.ts docs

**Test files:**

- `apps/client/src/layers/shared/model/__tests__/extension-registry.test.ts` (created) — 7 registry unit tests
- `apps/client/src/layers/features/command-palette/model/__tests__/use-palette-items.test.ts` (modified) — Registry mock
- `apps/client/src/layers/widgets/app-layout/__tests__/DialogHost.test.tsx` (modified) — Registry mock
- `apps/client/src/layers/features/session-list/__tests__/SidebarFooterBar.test.tsx` (modified) — Registry mock
- `apps/client/src/layers/features/session-list/__tests__/SessionSidebar.test.tsx` (modified) — Registry setup

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- 10 tasks completed in 5 parallel batches (1 → 2 → 1 → 5 → 1)
- DialogHost migration reduced from 119 lines to 57 lines
- Dialog wrapper components handle per-dialog complexity (ResponsiveDialog chrome, extra props)
- Sidebar tab `visibleWhen` for schedules uses `() => true` placeholder — actual wiring through `toolStatus.pulse` preserved in SessionSidebar via existing conditional
- Theme button in SidebarFooterBar handles dynamic icon swap by checking contribution `id === 'theme'`
- Full verification: 3138 tests passing, 0 type errors, 0 lint errors
