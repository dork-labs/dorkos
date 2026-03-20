# Switch Agent via Identity Chip -- Task Breakdown

**Spec:** `specs/switch-agent-via-identity-chip/02-specification.md`
**Generated:** 2026-03-10
**Mode:** Full decomposition

---

## Phase 1: Store + Wiring

### 1.1 Add globalPaletteInitialSearch state and actions to app-store

**Size:** Small | **Priority:** High | **Dependencies:** None

Add `globalPaletteInitialSearch: string | null`, `openGlobalPaletteWithSearch(text)`, and `clearGlobalPaletteInitialSearch()` to the AppState interface and store implementation in `app-store.ts`. The `openGlobalPaletteWithSearch` action atomically sets both `globalPaletteOpen: true` and the initial search text. This is transient state (not persisted).

**Files:** `apps/client/src/layers/shared/model/app-store.ts`

---

### 1.2 Rewire AgentIdentityChip click to open palette with @ prefix

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.3

Replace the click handler from `setAgentDialogOpen(true)` to `openGlobalPaletteWithSearch('@')`. Update tooltip from "Agent settings" to "Switch agent". Update aria-labels from "agent settings" / "Configure agent" to "switch agent" / "Switch agent".

**Files:** `apps/client/src/layers/features/top-nav/ui/AgentIdentityChip.tsx`

---

### 1.3 Consume globalPaletteInitialSearch in CommandPaletteDialog

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2

Update `handleOpenChange` to read `globalPaletteInitialSearch` via `useAppStore.getState()` when the dialog opens, set it as the search input value, then clear it (one-shot). Update `closePalette` to also call `clearGlobalPaletteInitialSearch()`. Use `.getState()` for the one-time read to avoid reactive dependency.

**Files:** `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx`

---

## Phase 2: Sidebar Cleanup

### 2.1 Remove AgentHeader from SessionSidebar and delete AgentHeader component

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.2

Remove the `AgentHeader` import and render block from `SessionSidebar.tsx`. Clean up unused store selectors (`setPickerOpen`, `setAgentDialogOpen`) from the destructured `useAppStore()`. Delete `AgentHeader.tsx` and `AgentHeader.test.tsx` entirely. The barrel `index.ts` needs no changes (AgentHeader was never exported).

**Files:**

- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`
- `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx` (delete)
- `apps/client/src/layers/features/session-list/__tests__/AgentHeader.test.tsx` (delete)

---

### 2.2 Add Edit Agent (Pencil) icon to SidebarFooterBar

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.1

Import `Pencil` from lucide-react, add `setAgentDialogOpen` to the store destructuring, and add a Pencil icon button before the Settings button. Button has `aria-label="Agent settings"` and calls `setAgentDialogOpen(true)` on click. Uses the same styling as existing footer buttons.

**Files:** `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`

---

## Phase 3: AgentDialog CWD

### 3.1 Add CWD display to AgentDialog

**Size:** Small | **Priority:** Medium | **Dependencies:** None

Add a `FolderOpen` icon + `PathBreadcrumb` line below the dialog description in both the agent-exists state (below "Agent configuration") and the no-agent state (below "No agent registered"). Uses `path={projectPath}`, `maxSegments={3}`, `size="sm"`. Styled with `text-muted-foreground text-xs`.

**Files:** `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`

---

## Phase 4: Test Updates

### 4.1 Update AgentIdentityChip tests for palette-based agent switching

**Size:** Medium | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 4.2, 4.3, 4.4, 4.5

Update mock from `mockSetAgentDialogOpen` to `mockOpenGlobalPaletteWithSearch`. Update click test assertions to verify `openGlobalPaletteWithSearch('@')`. Update all aria-label assertions from "agent settings" / "Configure agent" to "switch agent" / "Switch agent".

**Files:** `apps/client/src/layers/features/top-nav/__tests__/AgentIdentityChip.test.tsx`

---

### 4.2 Add CommandPaletteDialog tests for initial search consumption

**Size:** Medium | **Priority:** High | **Dependencies:** 1.3 | **Parallel with:** 4.1, 4.3, 4.4, 4.5

Add `clearGlobalPaletteInitialSearch` mock and `getState` support to the store mock. Add tests for: palette opens with pre-populated search when `globalPaletteInitialSearch` is set; clears value after consuming; opens with empty search when null; clears on palette close.

**Files:** `apps/client/src/layers/features/command-palette/__tests__/CommandPaletteDialog.test.tsx`

---

### 4.3 Add SidebarFooterBar tests for Edit Agent button

**Size:** Small | **Priority:** High | **Dependencies:** 2.2 | **Parallel with:** 4.1, 4.2, 4.4, 4.5

Add `mockSetAgentDialogOpen` to the store mock. Add tests: renders Pencil button with `aria-label="Agent settings"`; clicking calls `setAgentDialogOpen(true)`.

**Files:** `apps/client/src/layers/features/session-list/__tests__/SidebarFooterBar.test.tsx`

---

### 4.4 Update SessionSidebar tests to remove AgentHeader assertions

**Size:** Small | **Priority:** High | **Dependencies:** 2.1 | **Parallel with:** 4.1, 4.2, 4.3, 4.5

Remove the "renders AgentHeader when selectedCwd is set" test case. The mock store can retain unused properties harmlessly.

**Files:** `apps/client/src/layers/features/session-list/__tests__/SessionSidebar.test.tsx`

---

### 4.5 Add AgentDialog tests for CWD display

**Size:** Small | **Priority:** Medium | **Dependencies:** 3.1 | **Parallel with:** 4.1, 4.2, 4.3, 4.4

Add tests: CWD path segment visible when agent exists (scoped to dialog via `findDialog()`); CWD path segment visible when no agent registered. Uses existing test patterns with `createWrapper()` and `createMockTransport()`.

**Files:** `apps/client/src/layers/features/agent-settings/__tests__/AgentDialog.test.tsx`

---

## Dependency Graph

```
1.1 (store) ─┬─> 1.2 (chip) ─────> 4.1 (chip tests)
             ├─> 1.3 (palette) ──> 4.2 (palette tests)
             ├─> 2.1 (sidebar) ──> 4.4 (sidebar tests)
             └─> 2.2 (footer) ───> 4.3 (footer tests)

3.1 (dialog CWD) ────────────────> 4.5 (dialog tests)
```

Tasks 1.2 and 1.3 can run in parallel after 1.1. Tasks 2.1 and 2.2 can run in parallel after 1.1. Task 3.1 has no dependencies. All Phase 4 tasks can run in parallel.
