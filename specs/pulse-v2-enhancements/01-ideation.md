---
slug: pulse-v2-enhancements
number: 48
created: 2026-02-21
status: specified
---

# Pulse V2 Enhancements — Visual Cron Builder, DirectoryPicker, Calm Notifications

**Slug:** pulse-v2-enhancements
**Author:** Claude Code
**Date:** 2026-02-21
**Related:** Spec #47 (pulse-ui-overhaul), Spec #43 (pulse-scheduler), Spec #46 (pulse-completion-gaps)

---

## 1) Intent & Assumptions

- **Task brief:** Implement three V2 enhancements deferred from the Pulse UI/UX Overhaul (Spec #47): (1) a visual cron builder that augments the existing preset pills + raw input with 5-field dropdowns, (2) refactoring DirectoryPicker to accept an `onSelect` callback so it can be reused in the CreateScheduleDialog working directory field, and (3) an alerting/notification system for run completions following Calm Tech philosophy.

- **Assumptions:**
  - The V1 pulse-ui-overhaul implementation is complete (ResponsiveDialog, CronPresets, TimezoneCombobox, ScheduleRow, toast infrastructure, etc.)
  - Server API remains unchanged — these are client-side enhancements only
  - Sonner toast library is already installed and mounted in App.tsx
  - The existing `useActiveRunCount` hook and green dot indicator in sidebar are in place
  - No new npm dependencies are needed — all three features build on existing shadcn/ui primitives
  - FSD layer rules apply (no cross-feature imports; DirectoryPicker lives in `features/session-list/`)

- **Out of scope:**
  - Server-side scheduler logic, cron engine, or persistence changes
  - Multi-value cron field selectors (e.g., "Monday AND Wednesday") — V3 scope
  - Browser Notification API (push notifications) — violates Calm Tech philosophy
  - Favicon/PWA badging API — limited browser support for non-PWAs
  - New REST API endpoints

---

## 2) Pre-reading Log

### Existing Pulse Components
- `features/pulse/ui/CronPresets.tsx` (42 lines): 9 preset pills, `{ value, onChange }` props — identical API needed for the visual builder
- `features/pulse/ui/CreateScheduleDialog.tsx` (~280 lines): ResponsiveDialog form with progressive disclosure, CronPresets at line ~158, cwd as plain text input at line ~186
- `features/pulse/ui/ScheduleRow.tsx` (~230 lines): Status dot, toggle, dropdown actions, uses `sonner` toast for Run Now/Approve feedback
- `features/pulse/ui/PulsePanel.tsx` (~130 lines): Schedule list with AnimatePresence, empty states, dialog state management
- `features/pulse/ui/RunHistoryPanel.tsx` (~210 lines): Grid layout, Lucide status icons, `useRuns()` with 10s refetchInterval
- `features/pulse/ui/TimezoneCombobox.tsx` (~120 lines): Command-based combobox pattern — reference for searchable selects

### DirectoryPicker
- `features/session-list/ui/DirectoryPicker.tsx` (~230 lines): Browse/recent views, breadcrumb navigation, hidden files toggle. Selection writes to global state via `setSelectedCwd()` in two places: `handleSelect()` (browse mode) and `handleRecentSelect()` (recent mode)
- `features/session-list/ui/SessionSidebar.tsx` (~270 lines): Only consumer of DirectoryPicker — mounts it with `open`/`onOpenChange` props

### Notification Infrastructure
- `shared/ui/sonner.tsx` (~40 lines): Theme-aware Toaster with custom Lucide icons, already mounted in App.tsx
- `entities/pulse/model/use-runs.ts` (66 lines): `useRuns()` with 10s refetch, `useActiveRunCount()` for sidebar green dot, `useCancelRun()` mutation
- `features/session-list/ui/SessionSidebar.tsx` lines 215-216: Animated green dot on HeartPulse button when `activeRunCount > 0`
- `shared/lib/favicon-utils.ts`: Existing utility file for favicon manipulation

### Shared UI Available
- `shared/ui/select.tsx`: Shadcn Select wrapper — base for visual builder dropdowns
- `shared/ui/command.tsx` (~130 lines): cmdk wrapper — already used by TimezoneCombobox
- `shared/ui/tooltip.tsx`: Radix Tooltip — already mounted via TooltipProvider in App.tsx

### Research
- `research/20260221_pulse_scheduler_ux_redesign.md`: Original 14-source UX research; deferred these 3 items
- `research/20260221_pulse_v2_enhancements.md`: New research on cron builder libraries, DirectoryPicker patterns, calm notification approaches

---

## 3) Codebase Map

### Primary Components/Modules

| File | Role | Lines | Change Type |
|------|------|-------|-------------|
| `features/pulse/ui/CreateScheduleDialog.tsx` | Schedule create/edit form | ~280 | Modify: add CronVisualBuilder toggle, mount DirectoryPicker |
| `features/pulse/ui/CronPresets.tsx` | Preset pill buttons | 42 | Unchanged |
| `features/pulse/ui/CronVisualBuilder.tsx` | **NEW**: 5-field dropdown cron builder | ~150 | New file |
| `features/session-list/ui/DirectoryPicker.tsx` | Directory browser modal | ~230 | Modify: add `onSelect` callback prop |
| `features/session-list/ui/SessionSidebar.tsx` | Sidebar with Pulse button | ~270 | Modify: add `onSelect` handler, completion badge |
| `entities/pulse/model/use-completed-run-badge.ts` | **NEW**: Track completed runs since last view | ~60 | New file |
| `entities/pulse/index.ts` | Entity barrel exports | 13 | Modify: export new hook |

### Shared Dependencies (Reuse As-Is)

| Component | From | Use For |
|-----------|------|---------|
| `Select` | `shared/ui/select.tsx` | Visual builder field dropdowns |
| `Label` | `shared/ui/label.tsx` | Field labels in visual builder |
| `cn()` | `shared/lib/utils.ts` | Class merging |
| `cronstrue` | npm (already installed) | Cron preview (already used) |
| `sonner` | npm (already installed) | Run completion toasts |
| `ResponsiveDialog` | `shared/ui/responsive-dialog.tsx` | DirectoryPicker container |

### Data Flow

```
Visual Cron Builder:
  User clicks "Custom schedule →" in CreateScheduleDialog
    → CronVisualBuilder expands (AnimatePresence)
    → User selects values in 5 Select dropdowns
    → onChange fires with assembled cron string
    → form.cron updates → cronstrue preview renders
    → If cron matches a preset, preset pill highlights

DirectoryPicker Integration:
  CreateScheduleDialog renders DirectoryPicker with onSelect callback
    → User browses directories
    → onSelect(path) fires → form.cwd updates
    → Text input shows selected path

Run Completion Notification:
  useCompletedRunBadge() polls useRuns() every 10s
    → Detects runs that transitioned from 'running' → terminal
    → Increments unviewedCount
    → SessionSidebar renders amber dot when unviewedCount > 0
    → Opening PulsePanel calls clearBadge()
    → Optional: Sonner toast fires on transition detection
    → Optional: document.title updates with count when tab hidden
```

### Potential Blast Radius

- **Direct changes:** 4 files modified, 2 new files
- **Indirect impacts:** Minimal — DirectoryPicker refactor is backward-compatible
- **Test updates:** CreateScheduleDialog tests (cron builder), DirectoryPicker tests (onSelect), new hook tests
- **No shared UI changes needed**
- **No server changes needed**
- **No schema changes needed**

---

## 4) Root Cause Analysis

N/A — these are feature enhancements, not bug fixes.

---

## 5) Research

### Visual Cron Builder

**Library Assessment:**

| Library | Verdict |
|---------|---------|
| `react-js-cron` | Disqualified — requires antd dependency |
| `cron-builder-ui` | 2 commits, 1 star — effectively unmaintained |
| `neocron` | Tailwind v3 peer dep — mismatch with v4 |
| `react-cron-generator` | Legacy API, jQuery-era — incompatible with React 19 |

**Recommendation: Build custom.** The implementation surface is small (5 Select components + a `parseCron`/`assembleCron` utility). All needed primitives (`Select`, `Label`) exist in the shadcn/ui inventory. No external dependency needed.

**Architecture Decision:**
- **Augment, don't replace.** Preset pills remain the default entry point (handle 80% of cases). The visual builder appears as a "Custom schedule" expansion below the presets.
- **Same API**: `CronVisualBuilder` takes `{ value: string, onChange: (cron: string) => void }` — identical to `CronPresets`. The dialog shares a single `cron` state value across both input modes.
- **Two-way binding**: When the visual builder is open and a preset is clicked, parse the preset cron back into the 5 fields. When fields change, assemble and fire `onChange`.

**V2 Field Scope (single-value per field):**

| Field | Options | Wildcard |
|-------|---------|----------|
| Minute | `*`, 0, 5, 10, 15, 20, 30, 45 | "Every minute" |
| Hour | `*`, 0–23 | "Every hour" |
| Day of Month | `*`, 1–31 | "Every day" |
| Month | `*`, Jan–Dec | "Every month" |
| Day of Week | `*`, Sun–Sat | "Every weekday" |

Multi-value selectors (e.g., "Mon AND Wed", "1,15") are V3 scope.

### DirectoryPicker Integration

**Pattern: Optional-callback override.**

When `onSelect` prop is provided, it replaces the `setSelectedCwd()` call. When omitted, the component continues to write to global state (backward compatible). This is the React controlled/uncontrolled duality pattern.

**Change surface:**
- Add `onSelect?: (path: string) => void` to props
- Modify `handleSelect()` and `handleRecentSelect()` — 2 call sites, single conditional branch each
- SessionSidebar: zero changes (omits `onSelect`, existing behavior preserved)
- CreateScheduleDialog: mount DirectoryPicker with `onSelect={(path) => updateField('cwd', path)}`

**FSD Layer Compliance:**
- DirectoryPicker lives in `features/session-list/` — cannot be imported by `features/pulse/` directly
- Solution: CreateScheduleDialog accepts a `directoryPicker` render prop or the DirectoryPicker is passed down from the parent (PulsePanel/SessionSidebar level where both features are accessible)
- Alternative: Move DirectoryPicker to `shared/ui/` since it's now used by multiple features — this is the cleaner FSD approach if a component needs cross-feature reuse

### Calm Tech Notifications

**Three-layer ambient notification system (from quietest to loudest):**

**Layer 1 — Sidebar amber dot (always on, zero interruption)**
- HeartPulse button gets a second dot state: static amber dot for "completed runs not yet viewed"
- States: (no dot) → green pulse (running) → amber static (completed unseen) → both possible
- `useCompletedRunBadge()` hook tracks runs transitioning from `running` → terminal
- Badge clears when Pulse panel opens
- Calm Tech alignment: 10/10

**Layer 2 — Sonner toast (opt-in via setting, low interruption)**
- Fire a brief Sonner toast when a run completes: schedule name + outcome + "View history" action
- Auto-dismisses in 6 seconds, non-modal, non-blocking
- Only fires for runs that transition during current session (not on initial load)
- Can be gated behind a user setting: `notifications.pulseRunCompletion` (default: true)
- Calm Tech alignment: 8/10

**Layer 3 — Tab title badge (background tab awareness)**
- When tab is hidden and runs complete, prepend count: `"(2) DorkOS"`
- Clear on `visibilitychange` (tab regains focus)
- Implement in `shared/lib/favicon-utils.ts` as `updateTabBadge(count)`
- Calm Tech alignment: 9/10

**Explicitly NOT implementing:**
- Browser Notification API — requires permission prompt, system-level disruption, violates "check history, don't push"
- Favicon/PWA badging API — only works for installed PWAs, limited reach

---

## 6) Clarification

1. **DirectoryPicker FSD placement:** DirectoryPicker currently lives in `features/session-list/`. For CreateScheduleDialog (in `features/pulse/`) to use it, we either (a) move DirectoryPicker to `shared/ui/` since it's now cross-feature, (b) mount it at the `widgets/` or `app` layer and pass results down, or (c) accept a render-prop pattern. Which approach do you prefer?

2. **Visual builder toggle UX:** Should the "Custom schedule" builder be (a) a collapsible section below the preset pills (always visible as a toggle), (b) a tab alongside presets ("Presets | Custom"), or (c) automatically shown when the user types in the raw cron input field?

3. **Notification opt-in:** Should the Sonner toast for run completions be (a) always on by default (user can't disable), (b) on by default with a setting to disable, or (c) off by default with a setting to enable? The Calm Tech principle suggests (c) but the toast is already quite unobtrusive.

4. **Tab title badge:** Should the `(N) DorkOS` tab title update be included in V2 scope, or deferred? It's low effort but adds a dependency on `document.title` management that could conflict with other title-setting logic.

5. **CronVisualBuilder field granularity:** Should the Minute field include every value 0–59, or just the common intervals (0, 5, 10, 15, 20, 30, 45)? Every value is more flexible but creates a long dropdown. The preset pills already cover common intervals.
