---
slug: pulse-ui-overhaul
number: 47
created: 2026-02-21
status: tasks
last_decompose: 2026-02-21
---

# Pulse UI/UX Overhaul — Task Breakdown

## Phase 1: Foundation + Feature Detection

### T1: Install client dependencies and create shared UI components (Tooltip, Sonner, Command)

Install `sonner`, `@radix-ui/react-tooltip`, and `cmdk` in the client app. Create three new shared UI components following the shadcn pattern, export them from the shared/ui barrel, and mount `TooltipProvider` and `Toaster` in `App.tsx`.

**Files:**

- `apps/client/package.json` (add deps)
- `apps/client/src/layers/shared/ui/tooltip.tsx` (new)
- `apps/client/src/layers/shared/ui/sonner.tsx` (new)
- `apps/client/src/layers/shared/ui/command.tsx` (new)
- `apps/client/src/layers/shared/ui/index.ts` (add exports)
- `apps/client/src/App.tsx` (mount providers)

### T2: Add `pulse.enabled` to server config response and extend ServerConfigSchema

Add a `pulse` field to the GET /api/config response. Extend `ServerConfigSchema` in shared schemas.

**Files:**

- `packages/shared/src/schemas.ts` (extend ServerConfigSchema)
- `apps/server/src/routes/config.ts` (add pulse to response)

### T3: Create `usePulseEnabled()` hook and gate existing data hooks

Create the feature detection hook and update `useSchedules()` and `useRuns()` to accept an `enabled` parameter.

**Files:**

- `apps/client/src/layers/entities/pulse/model/use-pulse-config.ts` (new)
- `apps/client/src/layers/entities/pulse/model/use-schedules.ts` (update)
- `apps/client/src/layers/entities/pulse/model/use-runs.ts` (update)
- `apps/client/src/layers/entities/pulse/index.ts` (add exports)

### T4: Replace custom modal in SessionSidebar with ResponsiveDialog, Tooltip, and active run indicator

Remove the custom modal rendering and replace with ResponsiveDialog. Add Tooltip for disabled state. Add pulsing green dot for active runs.

**Files:**

- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` (overhaul)

### T5: Implement PulsePanel disabled/enabled empty states and skeleton loading

Add the disabled empty state, the enabled-but-empty state, and the skeleton loading state to PulsePanel.

**Files:**

- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx` (update)

## Phase 2: Schedule List + Row Overhaul

### T6: Extract ScheduleRow component with Switch, DropdownMenu, delete confirmation, and AnimatePresence

Extract the schedule row into its own component with proper design system primitives.

**Files:**

- `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx` (new)
- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx` (update to use ScheduleRow)
- `apps/client/src/layers/features/pulse/index.ts` (optionally export)

## Phase 3: CreateScheduleDialog Overhaul

### T7: Rewrite CreateScheduleDialog with ResponsiveDialog, CronPresets, TimezoneCombobox, and progressive disclosure

Replace the custom overlay with ResponsiveDialog. Add CronPresets and TimezoneCombobox components. Implement progressive disclosure with advanced settings section.

**Files:**

- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx` (rewrite)
- `apps/client/src/layers/features/pulse/ui/CronPresets.tsx` (new)
- `apps/client/src/layers/features/pulse/ui/TimezoneCombobox.tsx` (new)

## Phase 4: Run History + Polish

### T8: Rewrite RunHistoryPanel with Lucide icons, relative timestamps, responsive layout, and output/error display

Replace Unicode status icons with Lucide, add relative timestamps, responsive mobile layout, output summary, error display, and skeleton loading.

**Files:**

- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx` (rewrite)

### T9: Create `useActiveRunCount()` hook and wire toast notifications into mutation hooks

Add the active run count hook for the sidebar indicator and wire up Sonner toasts to Run Now, Approve, and error callbacks.

**Files:**

- `apps/client/src/layers/entities/pulse/model/use-runs.ts` (add useActiveRunCount)
- `apps/client/src/layers/entities/pulse/index.ts` (export)
- `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx` (add toast calls)
- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx` (add toast calls)

### T10: Write unit tests for all new and updated components and hooks

Create comprehensive tests for PulsePanel, ScheduleRow, CreateScheduleDialog, RunHistoryPanel, usePulseEnabled, updated useSchedules/useRuns, and useActiveRunCount.

**Files:**

- `apps/client/src/layers/features/pulse/__tests__/PulsePanel.test.tsx` (update)
- `apps/client/src/layers/features/pulse/__tests__/ScheduleRow.test.tsx` (new)
- `apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx` (update)
- `apps/client/src/layers/features/pulse/__tests__/RunHistoryPanel.test.tsx` (update)
- `apps/client/src/layers/entities/pulse/__tests__/use-pulse-config.test.tsx` (new)
- `apps/client/src/layers/entities/pulse/__tests__/use-schedules.test.tsx` (update)
- `apps/client/src/layers/entities/pulse/__tests__/use-runs.test.tsx` (update)

### T11: Update documentation (AGENTS.md and design-system.md)

Document the Tooltip, Toaster, and Command additions in the design system guide and update the Pulse section in AGENTS.md.

**Files:**

- `AGENTS.md` (update Pulse section)
- `contributing/design-system.md` (document new shared UI components)

## Dependency Graph

```
T1 (shared UI + deps)
├── T4 (sidebar) ← T3 (hooks)
│   └── T9 (active runs + toasts)
├── T5 (PulsePanel states) ← T3 (hooks)
│   └── T6 (ScheduleRow) ← T5
│       └── T9 (toasts) ← T6
├── T7 (CreateScheduleDialog) ← T1
│   (also depends on T3 for pulse-enabled check in edit mode)
└── T8 (RunHistoryPanel) ← T1

T2 (server config) ← (independent, needed by T3)
T3 (hooks) ← T2

T10 (tests) ← T4, T5, T6, T7, T8, T9
T11 (docs) ← T10
```

## Parallel Execution Opportunities

- T1 and T2 can run in parallel (no dependencies between them)
- T4 and T5 can run in parallel after T1 + T3
- T7 and T8 can run in parallel after T1
- T6 depends on T5 completing first
- T9 depends on T6 completing first
- T10 depends on all feature tasks (T4-T9)
- T11 depends on T10

## Critical Path

T2 → T3 → T5 → T6 → T9 → T10 → T11
