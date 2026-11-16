# Implementation Summary: Keyboard Shortcut Discoverability

**Created:** 2026-03-11
**Last Updated:** 2026-03-11
**Spec:** specs/shortcut-discoverability/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 9 / 9

## Tasks Completed

### Session 1 - 2026-03-11

- Task #1: [P1] Add shared isMac constant and replace all duplicated definitions
- Task #2: [P1] Create centralized SHORTCUTS registry with formatShortcutKey and getShortcutsGrouped
- Task #3: [P1] Add shortcutsPanelOpen state to Zustand app-store
- Task #4: [P2] Replace New Session button tooltip with inline Kbd hint
- Task #5: [P3] Create useShortcutsPanel hook for ? key handler
- Task #6: [P3] Create ShortcutsPanel component and feature barrel
- Task #7: [P3] Mount ShortcutsPanel and useShortcutsPanel in App.tsx
- Task #8: [P4] Update keyboard-shortcuts.md with ? shortcut and registry documentation
- Task #9: [P4] Run typecheck and lint, fix any issues

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/shared/lib/platform.ts` — Added `isMac` export
- `apps/client/src/layers/shared/lib/shortcuts.ts` — New: centralized SHORTCUTS registry, formatShortcutKey, getShortcutsGrouped
- `apps/client/src/layers/shared/lib/index.ts` — Re-exported isMac and all shortcuts symbols
- `apps/client/src/layers/shared/model/app-store.ts` — Added shortcutsPanelOpen state
- `apps/client/src/layers/features/shortcuts/model/use-shortcuts-panel.ts` — New: ? key handler hook
- `apps/client/src/layers/features/shortcuts/ui/ShortcutsPanel.tsx` — New: categorized shortcuts modal
- `apps/client/src/layers/features/shortcuts/index.ts` — New: feature barrel
- `apps/client/src/layers/features/session-list/ui/AgentSidebar.tsx` — Replaced tooltip with inline Kbd hint
- `apps/client/src/layers/features/top-nav/ui/CommandPaletteTrigger.tsx` — Replaced local isMac
- `apps/client/src/layers/features/session-list/ui/SidebarTabRow.tsx` — Replaced local isMac
- `apps/client/src/layers/features/command-palette/ui/PaletteFooter.tsx` — Replaced local isMac
- `apps/client/src/layers/features/command-palette/ui/AgentSubMenu.tsx` — Replaced local isMac
- `apps/client/src/App.tsx` — Mounted ShortcutsPanel and useShortcutsPanel hook
- `contributing/keyboard-shortcuts.md` — Added ? shortcut and registry documentation

**Test files:**

- `apps/client/src/layers/shared/lib/__tests__/shortcuts.test.ts` — 6 tests for registry and helpers
- `apps/client/src/layers/features/shortcuts/__tests__/use-shortcuts-panel.test.ts` — 4 tests for hook
- `apps/client/src/layers/features/shortcuts/__tests__/ShortcutsPanel.test.tsx` — 4 tests for component

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- All 1685 tests pass (140 test files), 0 lint errors, build succeeds
- `formatShortcutKey` on Windows applies `.toUpperCase()` so output is `CTRL+K` not `Ctrl+K`
- The `Kbd` in `ShortcutsPanel` uses `className="inline-flex"` to override the default `hidden md:inline-flex` so shortcuts are visible inside the mobile drawer
- Discovered a 6th `isMac` duplication in `AgentSubMenu.tsx` not listed in the original spec; included in the cleanup
