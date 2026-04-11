# Create Agent Two-Step Wizard Flow — Task Breakdown

> Generated: 2026-04-11 | Spec: `specs/create-agent-two-step-flow/02-specification.md`

## Overview

12 tasks across 4 phases. Redesigns `CreateAgentDialog` from a three-tab layout into a multi-step wizard with instant-advance method cards, template picker using `PackageCard` compact variant, shared configure form with directory browser and `.dork` conflict detection.

## Parallel Execution Opportunities

| Batch | Tasks              | Rationale                                                           |
| ----- | ------------------ | ------------------------------------------------------------------- |
| 1     | 1.1, 1.2           | Independent foundation changes (store rename + PackageCard variant) |
| 2     | 2.1                | Core wizard rewrite (depends on 1.1)                                |
| 3     | 2.2                | TemplatePicker update (depends on 1.2 + 2.1)                        |
| 4     | 3.1, 3.2           | Independent enhancements to configure step (both depend on 2.1)     |
| 5     | 3.3                | Conflict detection (depends on 2.1, can follow 3.1/3.2)             |
| 6     | 4.1, 4.2, 4.3, 4.4 | All test tasks can run in parallel                                  |

---

## Phase 1: Foundation (State & Variant)

### Task 1.1 — Rename CreationTab to CreationMode in agent-creation-store

- **Size**: Small | **Priority**: High
- **Dependencies**: None | **Parallel with**: 1.2

Rename `CreationTab` type to `CreationMode` and `initialTab` field to `initialMode` in the Zustand store. Keep `CreationTab` as a deprecated type alias for backward compatibility. Update the barrel export in `shared/model/index.ts` to export both types.

**Files**: `agent-creation-store.ts`, `shared/model/index.ts`, `CreateAgentDialog.tsx` (import update), `CreateAgentDialog.test.tsx` (setState update)

---

### Task 1.2 — Add compact variant to PackageCard

- **Size**: Small | **Priority**: High
- **Dependencies**: None | **Parallel with**: 1.1

Add `variant?: 'default' | 'compact'` prop to `PackageCard`. When compact: use `p-4` instead of `p-6`, hide author row, hide action row (install button / installed indicator), hide featured star. Type badge and description still render. Export `PackageCard` from the marketplace barrel.

**Files**: `PackageCard.tsx`, `marketplace/index.ts`

---

## Phase 2: Core Wizard (Dialog Rewrite)

### Task 2.1 — Rewrite CreateAgentDialog as multi-step wizard

- **Size**: Large | **Priority**: High
- **Dependencies**: 1.1

Major rewrite. Replace Radix `Tabs` with a step state machine (`WizardStep = 'choose' | 'pick-template' | 'configure' | 'import'`). Step 1 shows three method cards (Start Blank, From Template, Import Project). Clicking a card instantly advances — no Next button. AnimatePresence `mode="wait"` with opacity fade between steps (same pattern as `AdapterSetupWizard`). Conditional footer: no footer on choose step, Back-only on pick-template/import, Back + Create Agent on configure. Template indicator chip with "Change" link. Entry point backward compatibility: `open()` -> choose, `open('template')` -> pick-template, `open('import')` -> import.

**Files**: `CreateAgentDialog.tsx`

---

### Task 2.2 — Update TemplatePicker to use PackageCard compact variant

- **Size**: Medium | **Priority**: High
- **Dependencies**: 1.2, 2.1

Replace custom inline card markup with `PackageCard variant="compact"` from marketplace feature. Remove the `Label` component ("Template (optional)"). Change grid from `grid-cols-4` to `grid-cols-2 gap-3` with `max-h-64 overflow-y-auto`. Update `onSelect` signature to `(source, name)` for template name auto-fill. Single click advances — no toggle/deselect. Custom URL changes from live-typing to "Go" button pattern.

**Files**: `TemplatePicker.tsx`

---

## Phase 3: Enhancements

### Task 3.1 — Add directory browser button with DirectoryPicker integration

- **Size**: Small | **Priority**: Medium
- **Dependencies**: 2.1 | **Parallel with**: 3.2

Add `FolderOpen` icon button next to directory override input. Opens `DirectoryPicker` modal with `initialPath` set to current override or default directory. Selection populates `directoryOverride` and opens the collapsible if closed.

**Files**: `CreateAgentDialog.tsx`

---

### Task 3.2 — Add template name auto-fill on configure step

- **Size**: Small | **Priority**: Medium
- **Dependencies**: 2.1 | **Parallel with**: 3.1

When advancing from pick-template to configure, pre-fill name from template's package name if name is empty. Strip scope prefix (e.g., `@dorkos/code-reviewer` -> `code-reviewer`). Show hint text "Pre-filled from template -- edit freely" that disappears on user edit.

**Files**: `CreateAgentDialog.tsx`

---

### Task 3.3 — Add .dork conflict detection with debounced directory check

- **Size**: Medium | **Priority**: Medium
- **Dependencies**: 2.1

Debounced 500ms check of resolved directory path using `transport.browseDirectory()`. Four states: path doesn't exist ("Will create new directory"), path exists no `.dork` ("Directory exists"), path has `.dork` ("Existing project detected" + "Import instead?" link), permission error ("Cannot access this path" + disable Create button).

**Files**: `CreateAgentDialog.tsx`

---

## Phase 4: Tests

### Task 4.1 — Rewrite CreateAgentDialog test suite for wizard flow

- **Size**: Large | **Priority**: High
- **Dependencies**: 2.1, 3.1, 3.2, 3.3 | **Parallel with**: 4.2, 4.3

Complete rewrite of test file. Replace all tab-based tests with wizard step tests covering: method selection for all three paths, step transitions, back navigation for all paths (blank->choose, template->pick-template, import->choose), entry point compatibility (`open()`, `open('template')`, `open('import')`), footer visibility per step, name validation, create flow with celebration, template auto-fill, template indicator chip, dialog reset.

**Files**: `CreateAgentDialog.test.tsx`

---

### Task 4.2 — Update TemplatePicker tests for PackageCard and new onSelect

- **Size**: Medium | **Priority**: High
- **Dependencies**: 2.2 | **Parallel with**: 4.1, 4.3

Update tests: mock `PackageCard` from marketplace feature, verify `data-variant="compact"`, update `onSelect(source, name)` assertions, remove toggle/deselect tests, remove checkmark tests, add 2-column grid assertion, update custom URL tests for "Go" button pattern, remove "Template (optional)" label test.

**Files**: `TemplatePicker.test.tsx`

---

### Task 4.3 — Add PackageCard compact variant tests

- **Size**: Small | **Priority**: High
- **Dependencies**: 1.2 | **Parallel with**: 4.1, 4.2

Add test cases to existing `PackageCard.test.tsx`: compact uses `p-4` (not `p-6`), hides author row, hides Install button, hides Installed indicator, hides featured star, still renders name/badge/description/icon, onClick still fires. Regression test: default variant still uses `p-6`.

**Files**: `PackageCard.test.tsx`

---

### Task 4.4 — Verify entry point backward compatibility across callers

- **Size**: Small | **Priority**: High
- **Dependencies**: 1.1, 2.1 | **Parallel with**: 4.1, 4.2, 4.3

Run existing test suites for all callers: `AddAgentMenu.test.tsx`, `SidebarTabRow.test.tsx`, `AgentsHeader.test.tsx`, `CommandPaletteDialog.test.tsx`, `command-palette-integration.test.tsx`. Run `tsc --noEmit` to verify compilation. Fix any `initialTab` -> `initialMode` references in test setState calls.

**Files**: Verification only (callers in dashboard-sidebar, session-list, top-nav, command-palette)

---

## Summary

| Phase           | Tasks  | Parallel batches                         |
| --------------- | ------ | ---------------------------------------- |
| 1. Foundation   | 2      | 1 batch (1.1 + 1.2 parallel)             |
| 2. Core Wizard  | 2      | 2 sequential batches                     |
| 3. Enhancements | 3      | 2 batches (3.1 + 3.2 parallel, then 3.3) |
| 4. Tests        | 4      | 1 batch (all parallel)                   |
| **Total**       | **11** | **6 batches minimum**                    |
