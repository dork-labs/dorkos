# Task Breakdown: Keyboard Shortcut Discoverability

Generated: 2026-03-11
Source: specs/shortcut-discoverability/02-specification.md
Last Decompose: 2026-03-11

## Overview

This feature adds keyboard shortcut discoverability to DorkOS through four mechanisms: a centralized `SHORTCUTS` registry, inline button hints (Kbd fade on hover), command palette shortcut hints (infrastructure-ready), and a `?`-triggered shortcuts reference panel. It also consolidates 6 duplicated `isMac` platform detection constants into a single shared export.

## Phase 1: Foundation

### Task 1.1: Add shared isMac constant and replace all duplicated definitions

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:

- Add `isMac` constant to `apps/client/src/layers/shared/lib/platform.ts`
- Add barrel re-export in `shared/lib/index.ts`
- Replace 6 duplicated `const isMac = ...` definitions across: `AgentSidebar.tsx`, `CommandPaletteTrigger.tsx`, `App.tsx`, `SidebarTabRow.tsx`, `PaletteFooter.tsx`, `AgentSubMenu.tsx`
- Standardize the detection pattern (some files use `.includes('Mac')`, others use regex)

**Acceptance Criteria**:

- [ ] `isMac` exported from `shared/lib/platform.ts` and barrel
- [ ] All 6 files use shared import instead of local definitions
- [ ] No remaining `const isMac` in the codebase
- [ ] `pnpm typecheck` and `pnpm lint` pass

---

### Task 1.2: Create centralized SHORTCUTS registry with formatShortcutKey and getShortcutsGrouped

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- New file: `apps/client/src/layers/shared/lib/shortcuts.ts`
- Types: `ShortcutDef`, `ShortcutGroup`
- Constants: `SHORTCUTS`, `SHORTCUT_GROUP_LABELS`, `SHORTCUT_GROUP_ORDER`
- Functions: `formatShortcutKey(def)`, `getShortcutsGrouped()`
- Barrel re-exports in `shared/lib/index.ts`
- Unit tests in `shared/lib/__tests__/shortcuts.test.ts`

**Acceptance Criteria**:

- [ ] All types, constants, and functions exist and are exported
- [ ] `formatShortcutKey` produces Mac symbols and Windows strings correctly
- [ ] `getShortcutsGrouped` returns groups in display order
- [ ] Unit tests pass
- [ ] `pnpm typecheck` and `pnpm lint` pass

---

### Task 1.3: Add shortcutsPanelOpen state to Zustand app-store

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, Task 1.2

**Technical Requirements**:

- Add `shortcutsPanelOpen`, `setShortcutsPanelOpen`, `toggleShortcutsPanel` to `AppState` interface
- Add store implementation (transient, not persisted to localStorage)
- Follows exact pattern of `globalPaletteOpen` / `toggleGlobalPalette`

**Acceptance Criteria**:

- [ ] Interface and implementation added to app-store
- [ ] Initialized to `false`
- [ ] Toggle flips the boolean
- [ ] `pnpm typecheck` passes

---

## Phase 2: Inline Hints

### Task 2.1: Replace New Session button tooltip with inline Kbd hint

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

**Technical Requirements**:

- Remove Tooltip/TooltipTrigger/TooltipContent wrapper from New Session button
- Add `group` class to button, change `justify-center` to `justify-between`
- Wrap icon+label in `<span>`, add `<Kbd>` with opacity transition
- Use `formatShortcutKey(SHORTCUTS.NEW_SESSION)` instead of manual platform ternary
- Remove unused Tooltip imports if no longer needed in file

**Acceptance Criteria**:

- [ ] Tooltip wrapper removed
- [ ] Kbd hint fades in on hover (150ms opacity transition)
- [ ] No layout shift on hover
- [ ] Platform-correct shortcut displayed
- [ ] Kbd hidden on mobile
- [ ] `pnpm typecheck` and `pnpm lint` pass

---

## Phase 3: Shortcuts Panel

### Task 3.1: Create useShortcutsPanel hook for ? key handler

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- New file: `apps/client/src/layers/features/shortcuts/model/use-shortcuts-panel.ts`
- Global `keydown` listener for `?` key
- Guards against INPUT, TEXTAREA, contentEditable targets
- Calls `toggleShortcutsPanel()` from Zustand store
- Unit tests for toggle behavior and input guards

**Acceptance Criteria**:

- [ ] Hook toggles panel on `?` key press
- [ ] Does not fire in text inputs
- [ ] Cleans up event listener on unmount
- [ ] Unit tests pass

---

### Task 3.2: Create ShortcutsPanel component and feature barrel

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2, Task 1.3
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- New file: `apps/client/src/layers/features/shortcuts/ui/ShortcutsPanel.tsx`
- Uses `ResponsiveDialog` (Dialog on desktop, Drawer on mobile)
- Displays shortcuts grouped by category (Navigation, Sessions, Chat, Global)
- Each row: label left, `Kbd` right
- Compact: `sm:max-w-md` (448px)
- Feature barrel: `features/shortcuts/index.ts`
- Component tests

**Acceptance Criteria**:

- [ ] Panel renders 4 groups in correct order
- [ ] Each row shows label and formatted key
- [ ] Does not render when closed
- [ ] Unit tests pass

---

### Task 3.3: Mount ShortcutsPanel and useShortcutsPanel in App.tsx

**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1, Task 3.2
**Can run parallel with**: None

**Technical Requirements**:

- Import `ShortcutsPanel` and `useShortcutsPanel` from `features/shortcuts`
- Call `useShortcutsPanel()` in App component body
- Render `<ShortcutsPanel />` in both embedded and standalone JSX paths
- Place alongside `<CommandPaletteDialog />`

**Acceptance Criteria**:

- [ ] Hook called in App component
- [ ] Component rendered in both modes
- [ ] `?` key opens/closes the panel
- [ ] Escape and click-outside dismiss work
- [ ] `pnpm typecheck` and `pnpm lint` pass

---

## Phase 4: Polish & Docs

### Task 4.1: Update keyboard-shortcuts.md with ? shortcut and registry documentation

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.3
**Can run parallel with**: None

**Technical Requirements**:

- Add `?` row to Navigation shortcuts table
- Add "Shortcut Registry" section documenting the centralized registry
- Document how to add new shortcuts to the registry

**Acceptance Criteria**:

- [ ] Navigation table includes `?` shortcut
- [ ] Registry section documents the single source of truth pattern
- [ ] Correct file paths referenced

---

### Task 4.2: Run typecheck and lint, fix any issues

**Size**: Small
**Priority**: High
**Dependencies**: Task 3.3, Task 4.1
**Can run parallel with**: None

**Technical Requirements**:

- Run `pnpm typecheck`, `pnpm lint`, `pnpm format`
- Fix any issues: unused imports, missing TSDoc, import ordering, FSD layer violations
- Run `pnpm test -- --run` to verify all tests pass

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm lint` passes
- [ ] `pnpm format` run
- [ ] All tests pass
