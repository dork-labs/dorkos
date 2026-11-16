# Task Breakdown: pulse-schedule-templates

**Spec:** `specs/pulse-schedule-templates/02-specification.md`
**Generated:** 2026-03-11
**Mode:** Full

---

## Summary

| Phase     | Name                               | Tasks | Critical |
| --------- | ---------------------------------- | ----- | -------- |
| 1         | Infrastructure Promotion           | 4     | Yes      |
| 2         | CreateScheduleDialog Two-Step Flow | 2     | Yes      |
| 3         | Empty State Surfaces               | 3     | Yes      |
| **Total** |                                    | **9** |          |

**Critical path:** 1.1 → 1.2 → 1.3 → 1.4 → 2.1 → 2.2 → 3.1 / 3.2 → 3.3

---

## Phase 1 — Infrastructure Promotion

### 1.1 Move usePulsePresets to entities/pulse and create usePulsePresetDialog store

**Size:** Small | **Priority:** High | **Dependencies:** none | **Parallel with:** none

#### Technical Requirements

- Move `usePulsePresets` from `features/onboarding/model/` to `entities/pulse/model/`
- Create new `usePulsePresetDialog` Zustand store at `entities/pulse/model/`
- Update `entities/pulse/index.ts` barrel to export both new symbols
- Leave a re-export shim in `features/onboarding/model/use-pulse-presets.ts` for backward compatibility (cleaned up in task 1.3)

#### Implementation Steps

1. Create `apps/client/src/layers/entities/pulse/model/use-pulse-presets.ts` — identical to the existing onboarding hook, imports `useTransport` from `@/layers/shared/model` and `PulsePreset` type from `@dorkos/shared/types`
2. Create `apps/client/src/layers/entities/pulse/model/use-pulse-preset-dialog.ts` — Zustand store with `pendingPreset: PulsePreset | null`, `externalTrigger: boolean`, `openWithPreset(preset)`, and `clear()`
3. Update `entities/pulse/index.ts` to add `export { usePulsePresets }`, `export type { PulsePreset }`, and `export { usePulsePresetDialog }`
4. Replace `features/onboarding/model/use-pulse-presets.ts` with a re-export shim pointing to the entity layer

#### Acceptance Criteria

- Both new files exist and export the expected symbols
- `entities/pulse/index.ts` exports all new symbols
- `pnpm typecheck` passes
- Unit tests for `usePulsePresetDialog` pass: `openWithPreset` sets state, `clear` resets state

---

### 1.2 Move PresetCard to features/pulse and add selectable variant

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** none

#### Technical Requirements

- Move `PresetCard` from `features/onboarding/ui/PresetCard.tsx` to `features/pulse/ui/PresetCard.tsx`
- Add `variant: 'toggle' | 'selectable'` prop replacing the old `enabled`/`onToggle` API
- `toggle` variant: renders `Switch`, same as before
- `selectable` variant: click-to-select with a `ring-1 ring-primary` selection ring when `selected=true`, no Switch
- Move/copy `format-cron.ts` and `use-spotlight.ts` utilities to `features/pulse/lib/`
- Replace `features/onboarding/ui/PresetCard.tsx` with a re-export shim
- Export `PresetCard` from `features/pulse/index.ts`

#### Implementation Steps

1. Create `apps/client/src/layers/features/pulse/lib/` directory (if absent); copy `format-cron.ts` and `use-spotlight.ts` into it
2. Create `features/pulse/ui/PresetCard.tsx` with `PresetCardProps` interface using `variant`, `checked`, `onCheckedChange`, `onSelect`, `selected`
3. Implement toggle branch: Switch with `onClick stopPropagation`, existing spotlight effect
4. Implement selectable branch: plain `button`, `ring-1 ring-primary` when `selected=true`, calls `onSelect(preset)` on click
5. Replace `features/onboarding/ui/PresetCard.tsx` with a shim: `export { PresetCard } from '@/layers/features/pulse/ui/PresetCard'`
6. Add `export { PresetCard } from './ui/PresetCard'` to `features/pulse/index.ts`

#### Acceptance Criteria

- `selectable` variant renders no Switch element
- `selectable` variant applies selection ring when `selected=true`
- `toggle` variant behavior is unchanged from original
- New `PresetCard.test.tsx` passes all 7 cases (toggle: 3 cases, selectable: 4 cases)

---

### 1.3 Update onboarding imports and verify no regressions

**Size:** Small | **Priority:** High | **Dependencies:** 1.1, 1.2 | **Parallel with:** none

#### Technical Requirements

- Update `PulsePresetsStep.tsx` to import `usePulsePresets` from `@/layers/entities/pulse` and `PresetCard` from `@/layers/features/pulse`
- Update `PresetCard` usage in `PulsePresetsStep` from old API (`enabled`, `onToggle`) to new API (`variant="toggle"`, `checked`, `onCheckedChange`)
- Delete the shim files from `features/onboarding/model/` and `features/onboarding/ui/`
- Verify all onboarding tests pass after cleanup

#### Implementation Steps

1. In `PulsePresetsStep.tsx`: replace `import { usePulsePresets } from '../model/use-pulse-presets'` with `import { usePulsePresets } from '@/layers/entities/pulse'`
2. In `PulsePresetsStep.tsx`: replace `import { PresetCard } from './PresetCard'` with `import { PresetCard } from '@/layers/features/pulse'`
3. In `PulsePresetsStep.tsx` render: change `enabled={resolvedEnabled.has(preset.id)} onToggle={() => handleToggle(preset.id)}` to `variant="toggle" checked={resolvedEnabled.has(preset.id)} onCheckedChange={() => handleToggle(preset.id)}`
4. Delete `features/onboarding/model/use-pulse-presets.ts`
5. Delete the re-export shim from `features/onboarding/ui/PresetCard.tsx` (remove the file)
6. Run `pnpm vitest run apps/client/src/layers/features/onboarding`

#### Acceptance Criteria

- No shim files remain in `features/onboarding`
- `PulsePresetsStep.tsx` uses the new prop API with `variant="toggle"`
- All 11 onboarding tests pass unchanged
- `pnpm typecheck` passes

---

### 1.4 Create PresetGallery component and update features/pulse barrel

**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 1.3

#### Technical Requirements

- Create `PresetGallery` at `features/pulse/ui/PresetGallery.tsx`
- Uses `usePulsePresets()` from `entities/pulse` internally
- Renders a `grid grid-cols-2 gap-3` layout of `PresetCard` components in `selectable` variant
- Handles 3 states: loading (4 skeleton cards), error (error message), success (cards)
- Props: `onSelect?: (preset) => void`, `selectedId?: string`, `className?: string`
- Export from `features/pulse/index.ts`

#### Implementation Steps

1. Create `features/pulse/ui/PresetGallery.tsx` with the 3-state render logic
2. Loading state: 4 `div` elements with `animate-pulse` class
3. Error state: `<p className="text-sm text-destructive">Failed to load presets. You can start from scratch.</p>`
4. Success state: `grid grid-cols-2` of `PresetCard` with `variant="selectable"`, passing `selected={preset.id === selectedId}` and `onSelect`
5. Add `export { PresetGallery } from './ui/PresetGallery'` to `features/pulse/index.ts`

#### Acceptance Criteria

- Loading shows 4 skeleton cards (`animate-pulse`)
- Error shows a descriptive error message
- Success renders one card per preset with correct `selected` prop
- `onSelect` propagates the clicked preset to the caller
- `PresetGallery.test.tsx` passes all 5 cases

---

## Phase 2 — CreateScheduleDialog Two-Step Flow

### 2.1 Add two-step flow to CreateScheduleDialog

**Size:** Large | **Priority:** High | **Dependencies:** 1.4 | **Parallel with:** none

#### Technical Requirements

- Add `type DialogStep = 'preset-picker' | 'form'` and `useState<DialogStep>` to `CreateScheduleDialog`
- Add `appliedPreset: PulsePreset | null` state
- Extend `buildInitialState` to accept an optional `preset` parameter
- Step 1 renders `PresetGallery` + "Start from scratch" link
- Step 2 renders existing form + "← Back" button in create mode
- On preset select: set form values from preset, advance to step 2
- On external trigger (`usePulsePresetDialog`): advance to step 2 with preset, call `clear()`
- Add optional `initialPreset?: PulsePreset | null` prop to `Props` interface
- On dialog close: reset step to `preset-picker` (or `form` if edit mode)

#### Implementation Steps

1. Add `DialogStep` type and `step` / `appliedPreset` state
2. Extend `buildInitialState(editSchedule?, preset?)` to handle preset population
3. Add `usePulsePresetDialog` consumption with `useEffect` for external trigger
4. Update the existing `open`/`editSchedule` reset `useEffect` to also reset `step` and handle `initialPreset` prop
5. Split `ResponsiveDialogContent` body into two branches: step 1 shows `PresetGallery` + scratch button; step 2 shows existing form
6. Add "← Back" button in `ResponsiveDialogHeader` for create mode on step 2
7. Add `handleSelectPreset` function: sets form from preset, sets `appliedPreset`, advances step

#### Acceptance Criteria

- Default open: `preset-picker` step visible, "Start from scratch" link present
- Edit mode: form visible immediately, no back button, no "Start from scratch"
- Preset click: form pre-filled with `name`, `prompt`, `cron`, `timezone`
- "Start from scratch": empty form (name, prompt blank; cron at DEFAULT_CRON)
- "Back": returns to `preset-picker`
- External trigger: pre-filled form at step 2, `clear()` called
- Dialog close + reopen: resets to `preset-picker`
- All 6 existing `CreateScheduleDialog` test cases still pass
- 6 new test cases pass

---

### 2.2 Wire PulsePanel to handle external preset trigger

**Size:** Small | **Priority:** High | **Dependencies:** 2.1 | **Parallel with:** none

#### Technical Requirements

- `PulsePanel` imports `usePulsePresetDialog` from `@/layers/entities/pulse`
- A `useEffect` watches `externalTrigger` and calls `setDialogOpen(true)` when it becomes `true`
- `setEditSchedule(undefined)` is called alongside to ensure create mode
- Existing dialog open paths (button, empty state CTA) are unchanged

#### Implementation Steps

1. Add `import { usePulsePresetDialog } from '@/layers/entities/pulse'` to `PulsePanel.tsx`
2. Add `import { useState, useEffect } from 'react'` if `useEffect` is not yet imported
3. Add `const { externalTrigger } = usePulsePresetDialog()` inside the component
4. Add `useEffect(() => { if (externalTrigger) { setEditSchedule(undefined); setDialogOpen(true); } }, [externalTrigger])`

#### Acceptance Criteria

- `PulsePanel` sets `dialogOpen=true` when `externalTrigger` becomes `true`
- `editSchedule` is cleared when triggering externally
- Existing tests in `PulsePanel.test.tsx` still pass
- New test: external trigger opens dialog

---

## Phase 3 — Empty State Surfaces

### 3.1 Retrofit PulseEmptyState with PresetGallery and callbacks

**Size:** Medium | **Priority:** High | **Dependencies:** 2.2 | **Parallel with:** 3.2

#### Technical Requirements

- Replace decorative ghost cards in `PulseEmptyState` with `PresetGallery`
- Change props: remove `onCreateSchedule`, add `onCreateWithPreset: (preset: PulsePreset) => void` and `onCreateBlank: () => void`
- Add "New custom schedule" `Button` with `variant="ghost"` below the gallery
- Update `PulsePanel` to pass the new callbacks and manage `appliedPresetForDialog` state
- Add `initialPreset?: PulsePreset | null` prop to `CreateScheduleDialog` (used by `PulsePanel` empty-state path)

#### Implementation Steps

1. Rewrite `PulseEmptyState.tsx`: new props interface, render `PresetGallery` + "New custom schedule" ghost button
2. In `PulsePanel.tsx`: add `appliedPresetForDialog` state, `handleCreateWithPreset` handler (sets preset, opens dialog), `handleCreateBlank` handler (opens dialog, no preset)
3. Update `PulsePanel` empty state branch to pass `onCreateWithPreset` and `onCreateBlank`
4. Pass `initialPreset={appliedPresetForDialog}` to `CreateScheduleDialog`; reset it in `handleDialogOpenChange`

#### Acceptance Criteria

- No decorative ghost cards remain in `PulseEmptyState`
- Clicking a preset card opens dialog at form step with that preset pre-filled
- "New custom schedule" opens dialog at picker step (step 1)
- `PulseEmptyState.test.tsx` passes all 3 cases

---

### 3.2 Add compact preset cards to SchedulesView empty state

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.4 | **Parallel with:** 3.1

#### Technical Requirements

- `SchedulesView` imports `usePulsePresets` and `usePulsePresetDialog` from `@/layers/entities/pulse`
- When `schedules.length === 0`: show 2 compact preset cards (index 0 = Health Check, index 2 = Docs Sync)
- Each card shows: preset name, human-readable cron, "+ Use preset" button
- "+ Use preset" calls `openWithPreset(preset)` then `setPulseOpen(true)`
- "Open Pulse →" link remains below the cards
- No `PresetCard` component used — inline markup for compactness in the narrow sidebar

#### Implementation Steps

1. Add `usePulsePresets` and `usePulsePresetDialog` imports
2. Compute `featuredPresets = [presets[0], presets[2]].filter(Boolean)`
3. Replace the empty state JSX block (currently lines 47–59) with new compact card layout
4. Import `formatCron` from `features/pulse/lib/format-cron` (moved in task 1.2)
5. Update existing test: change expected text from `'No schedules configured'` to `'No schedules yet.'`
6. Add 4 new test cases for the new empty state behavior

#### Acceptance Criteria

- presets[0] (Health Check) and presets[2] (Docs Sync) cards render in empty state
- presets[1] (Dependency Audit) does NOT render
- "+" Use preset" fires `openWithPreset` with the correct preset object
- `setPulseOpen(true)` is also called
- When schedules exist, no "Use preset" buttons appear
- All 4 new test cases pass; existing tests updated and passing

---

### 3.3 Run full test suite and verify onboarding regression tests

**Size:** Small | **Priority:** Medium | **Dependencies:** 3.1, 3.2 | **Parallel with:** none

#### Technical Requirements

- All 9 tasks' acceptance criteria are met
- Zero FSD layer violations
- `pnpm typecheck` exits 0
- `pnpm lint` exits 0
- `pnpm vitest run apps/client` passes

#### Implementation Steps

1. `pnpm vitest run apps/client/src/layers/entities/pulse`
2. `pnpm vitest run apps/client/src/layers/features/pulse`
3. `pnpm vitest run apps/client/src/layers/features/session-list`
4. `pnpm vitest run apps/client/src/layers/features/onboarding` — regression gate
5. `pnpm typecheck`
6. `pnpm lint`
7. Confirm `usePulsePresetDialog.clear()` is called after every consumption site

#### Acceptance Criteria

- All tests pass with no skips
- No `@ts-ignore` or `@ts-expect-error` introduced
- No FSD violations flagged by ESLint `no-restricted-imports`
- Onboarding step renders identically to before (only import paths changed)

---

## Parallel Execution Map

```
1.1 ──► 1.2 ──► 1.3
                      └──────────────────────────────► 2.1 ──► 2.2 ──► 3.1 ──► 3.3
         └──► 1.4 ──────────────────────────────────────────────────► 3.2 ──┘
```

Tasks 1.3 and 1.4 can run in parallel after 1.2 completes.
Tasks 3.1 and 3.2 can run in parallel after 2.2 and their respective Phase 1 dependencies.

---

## Risk Register

| Risk                                              | Mitigation                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PresetCard` API change breaks `PulsePresetsStep` | Use re-export shim in task 1.2, fix imports in task 1.3 before deleting shim                                                              |
| `usePulsePresetDialog.clear()` not called         | Both `CreateScheduleDialog` (external trigger `useEffect`) and `PulsePanel` (after opening) call `clear()`; covered by test               |
| FSD cross-feature import in `SchedulesView`       | Only imports from `entities/pulse`; `formatCron` is a lib utility moved to `features/pulse/lib` — if needed, move to `shared/lib` instead |
| `externalTrigger` becomes stale after navigation  | `PulsePanel` calls `clear()` after consuming the trigger; dialog's `open` state resets on close                                           |
