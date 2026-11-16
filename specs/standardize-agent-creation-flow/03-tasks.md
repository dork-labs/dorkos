# Standardize Agent Creation Flow — Task Breakdown

> Generated: 2026-04-11 | Spec: `02-specification.md` | Mode: Full

## Summary

| Phase     | Name                        | Tasks  | Sizes             |
| --------- | --------------------------- | ------ | ----------------- |
| 1         | State & Wiring (Foundation) | 4      | 4 small           |
| 2         | Dialog Redesign (Core)      | 2      | 1 large, 1 medium |
| 3         | Cleanup (Simplification)    | 3      | 3 small           |
| 4         | Tests                       | 3      | 1 large, 2 medium |
| **Total** |                             | **12** |                   |

## Dependency Graph

```
Phase 1 (all parallel):
  1.1  Extend useAgentCreationStore
  1.2  Fix AddAgentMenu wiring
  1.3  Fix SidebarTabRow wiring
  1.4  Update barrel exports

Phase 2 (depends on P1):
  2.1  Rewrite CreateAgentDialog  ──depends──> 1.1
  2.2  Simplify TemplatePicker    ──depends──> 1.4
  (2.1 and 2.2 are parallel with each other)

Phase 3 (depends on P2):
  3.1  Simplify AgentsHeader      ──depends──> 2.1
  3.2  Delete use-template-catalog ─depends──> 2.2, 1.4
  3.3  Clean up unused imports    ──depends──> 2.1, 2.2, 3.1
  (3.1 and 3.2 are parallel; 3.3 runs after both)

Phase 4 (depends on P2-P3):
  4.1  Update CreateAgentDialog tests  ──depends──> 2.1
  4.2  Update TemplatePicker tests     ──depends──> 2.2
  4.3  Update entry point tests        ──depends──> 3.1, 1.2, 1.3
  (all parallel with each other)
```

---

## Phase 1: State & Wiring (Foundation)

### 1.1 Extend useAgentCreationStore with initialTab and CreationTab type

**Size:** small | **Priority:** high | **Dependencies:** none | **Parallel:** 1.2, 1.3

**File:** `apps/client/src/layers/shared/model/agent-creation-store.ts`

Add `CreationTab` type union (`'new' | 'template' | 'import'`), add `initialTab: CreationTab` field to the store interface, update `open()` to accept optional tab parameter, and reset `initialTab` to `'new'` on `close()`. Also re-export `CreationTab` type from `shared/model/index.ts`.

---

### 1.2 Fix AddAgentMenu wiring to use useAgentCreationStore

**Size:** small | **Priority:** high | **Dependencies:** none | **Parallel:** 1.1, 1.3

**File:** `apps/client/src/layers/features/dashboard-sidebar/ui/AddAgentMenu.tsx`

Replace `useAppStore` import with `useAgentCreationStore`. "Create agent" calls `useAgentCreationStore.getState().open()`, "Import project" calls `useAgentCreationStore.getState().open('import')`. Remove `setAgentDialogOpen` and `setPickerOpen` references.

---

### 1.3 Fix SidebarTabRow edit button — replace setAgentDialogOpen with creation store

**Size:** small | **Priority:** high | **Dependencies:** none | **Parallel:** 1.1, 1.2

**File:** `apps/client/src/layers/features/session-list/ui/SidebarTabRow.tsx`

Replace `useAppStore` import and `setAgentDialogOpen` with `useAgentCreationStore.getState().open()`. Change button icon from `Pencil` to `Plus`, aria-label from "Edit Agent" to "New Agent", and tooltip text to "New Agent".

---

### 1.4 Update agent-creation barrel exports — remove useTemplateCatalog

**Size:** small | **Priority:** medium | **Dependencies:** none | **Parallel:** 1.1, 1.2, 1.3

**File:** `apps/client/src/layers/features/agent-creation/index.ts`

Remove `export { useTemplateCatalog } from './model/use-template-catalog';` line from the barrel file. Verify no external consumers import it.

---

## Phase 2: Dialog Redesign (Core)

### 2.1 Rewrite CreateAgentDialog with three-tab layout

**Size:** large | **Priority:** high | **Dependencies:** 1.1 | **Parallel:** 2.2

**File:** `apps/client/src/layers/features/agent-creation/ui/CreateAgentDialog.tsx`

Major rewrite of the dialog to use Shadcn `Tabs` component with three panels:

- **Tab 1 (New Agent):** Name + Directory inputs (extracted from current dialog)
- **Tab 2 (From Template):** TemplatePicker + Name + Directory
- **Tab 3 (Import):** `<DiscoveryView />` embedded

Remove: TraitSliders, personality collapsible, template collapsible. Add: tab state tracking, conditional footer (hidden on Import tab), `initialTab` from store, dialog sizing bump to `sm:max-w-lg`.

---

### 2.2 Simplify TemplatePicker — marketplace only with Advanced URL collapsible

**Size:** medium | **Priority:** high | **Dependencies:** 1.4 | **Parallel:** 2.1

**File:** `apps/client/src/layers/features/agent-creation/ui/TemplatePicker.tsx`

Remove built-in template tab, `useTemplateCatalog` import, `CATEGORY_TABS`, category filter state. Make marketplace grid the sole content. Wrap custom GitHub URL input in a `Collapsible` labeled "Advanced" (collapsed by default).

---

## Phase 3: Cleanup (Simplification)

### 3.1 Simplify AgentsHeader — remove discovery button and dialog

**Size:** small | **Priority:** medium | **Dependencies:** 2.1 | **Parallel:** 3.2, 3.3

**File:** `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`

Remove "Search for Projects" button, `discoveryOpen` state, `ResponsiveDialog`/`DiscoveryView` imports. Keep single "New Agent" button. Simplify return from fragment to single `<PageHeader>`.

---

### 3.2 Delete use-template-catalog.ts and its test file

**Size:** small | **Priority:** medium | **Dependencies:** 2.2, 1.4 | **Parallel:** 3.1, 3.3

**Files to delete:**

- `apps/client/src/layers/features/agent-creation/model/use-template-catalog.ts`
- `apps/client/src/layers/features/agent-creation/__tests__/use-template-catalog.test.tsx`

Verify no remaining imports in the codebase before deletion.

---

### 3.3 Clean up unused imports across all modified files

**Size:** small | **Priority:** low | **Dependencies:** 2.1, 2.2, 3.1 | **Parallel:** 3.2

Sweep all files modified in Phases 1-3 for unused imports and dead code. Run `pnpm tsc --noEmit` and `pnpm lint` to verify clean state.

---

## Phase 4: Tests

### 4.1 Update CreateAgentDialog tests for three-tab behavior

**Size:** large | **Priority:** high | **Dependencies:** 2.1 | **Parallel:** 4.2, 4.3

**File:** `apps/client/src/layers/features/agent-creation/__tests__/CreateAgentDialog.test.tsx`

Remove personality slider test. Add tests for: three tabs present, default tab, open with specific tab (`open('import')`, `open('template')`), footer visibility (hidden on Import tab), tab switching, tab reset on close/reopen, updated dialog description. Update button name from 'Create' to 'Create Agent' in all assertions.

---

### 4.2 Update TemplatePicker tests for marketplace-only with Advanced URL

**Size:** medium | **Priority:** high | **Dependencies:** 2.2 | **Parallel:** 4.1, 4.3

**File:** `apps/client/src/layers/features/agent-creation/__tests__/TemplatePicker.test.tsx`

Remove all built-in template tests (7 tests). Update marketplace tests to remove tab switching (grid is primary content now). Update custom URL tests to open Advanced collapsible first. Add tests for Advanced collapsible default state and toggle behavior.

---

### 4.3 Update AgentsHeader, AddAgentMenu, and SidebarTabRow tests

**Size:** medium | **Priority:** high | **Dependencies:** 3.1, 1.2, 1.3 | **Parallel:** 4.1, 4.2

**Files:**

- `apps/client/src/layers/features/top-nav/__tests__/AgentsHeader.test.tsx` — Remove "Search for Projects" tests, add assertion that button is absent
- `apps/client/src/layers/features/dashboard-sidebar/__tests__/AddAgentMenu.test.tsx` — Replace `useAppStore` mock with `useAgentCreationStore` mock, update assertions for `open()` and `open('import')`
- `apps/client/src/layers/features/session-list/__tests__/SidebarTabRow.test.tsx` — Add `useAgentCreationStore` mock, add tests for "New Agent" button aria-label and click handler
