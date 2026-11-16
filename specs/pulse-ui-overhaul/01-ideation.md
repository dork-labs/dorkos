---
slug: pulse-ui-overhaul
number: 47
created: 2026-02-21
status: ideation
---

# Pulse UI/UX Overhaul — World-Class Scheduler Experience

**Slug:** pulse-ui-overhaul
**Author:** Claude Code
**Date:** 2026-02-21
**Related:** Spec #43 (pulse-scheduler), Spec #46 (pulse-completion-gaps)

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the Pulse scheduler UI from prototype-grade to world-class across four tiers: (1) adopt design system primitives, (2) UX polish with better inputs and feedback, (3) rich information architecture, and (4) advanced features like DirectoryPicker integration and run detail panels. Additionally, the client should detect whether Pulse is enabled or disabled on the server and handle both states gracefully.

- **Assumptions:**
  - Server API remains unchanged (no new endpoints needed beyond exposing `scheduler.enabled` in the existing config response)
  - The existing `GET /api/config` already returns the full `UserConfig` including `scheduler.enabled`
  - This is primarily a client-side effort with minor server config exposure changes
  - Toast infrastructure does not exist yet and will need to be added (or a lightweight alternative)
  - All changes follow the Calm Tech design philosophy and FSD architecture rules

- **Out of scope:**
  - Server-side scheduler logic, cron engine, or persistence changes
  - New REST API endpoints (beyond config exposure)
  - Visual cron builder (middle-tier — presets + raw input is sufficient for V1)
  - Alerting/notification system for run completions (Calm Tech: check history, don't push)

---

## 2) Pre-reading Log

### Developer Guides

- `contributing/design-system.md`: Calm Tech philosophy (less, but better), 8pt grid, semantic color tokens, motion specs (100-300ms), no pure black/white, responsive scale system
- `contributing/animations.md`: Motion.dev 12.x, GPU-accelerated transforms only, AnimatePresence for enter/exit, spring physics (stiffness 400, damping 30), respect prefers-reduced-motion
- `contributing/styling-theming.md`: Tailwind v4 CSS-first, OKLCH color space, `cn()` utility, dark mode via class strategy
- `contributing/data-fetching.md`: TanStack Query + Transport abstraction, entity hooks wrap queries, SSE for streaming, ETag caching
- `contributing/state-management.md`: Zustand for UI state, TanStack Query for server state, nuqs for URL state

### Pulse Components (Current State)

- `features/pulse/ui/PulsePanel.tsx` (171 lines): Raw div modal, custom toggle switch, StatusDot component, inline buttons, accordion expand for run history
- `features/pulse/ui/CreateScheduleDialog.tsx` (223 lines): Custom overlay, 7 flat form fields, raw `<select>` for timezone (400+ options), native radio buttons for permission mode, cronstrue preview
- `features/pulse/ui/RunHistoryPanel.tsx` (87 lines): Fixed-width grid, Unicode character status icons, absolute timestamps, click-to-navigate (no visual affordance)
- `entities/pulse/model/use-schedules.ts` (69 lines): 5 TanStack Query hooks, cache invalidation on mutations
- `entities/pulse/model/use-runs.ts` (41 lines): 3 hooks, 10s refetchInterval for live status

### Reference Components (Gold Standard)

- `shared/ui/responsive-dialog.tsx`: Context-based responsive wrapper (Dialog desktop, Drawer mobile), all sub-components responsive
- `shared/ui/switch.tsx`: Radix Switch primitive with consistent Tailwind styling
- `shared/ui/badge.tsx`: CVA variants (default/secondary/destructive/outline)
- `features/settings/ui/SettingsDialog.tsx`: Gold standard dialog — ResponsiveDialog + Tabs + SettingRow pattern, config via TanStack Query
- `features/session-list/ui/DirectoryPicker.tsx`: ResponsiveDialog + breadcrumb navigation, recent dirs, skeleton loading
- `features/chat/ui/ToolCallCard.tsx`: AnimatePresence expand/collapse with spring physics

### Server Config

- `routes/config.ts`: GET returns ServerConfig (version, tunnel, CLI path), PATCH validates with Zod
- `config-schema.ts`: `scheduler.enabled` (default false), `maxConcurrentRuns` (1-10), `timezone`, `retentionCount`
- `transport.ts`: 8 Pulse methods defined; config methods available via `getConfig()`

### Sidebar Integration

- `SessionSidebar.tsx` lines 186-233: HeartPulse icon button, custom `<div>` modal overlay with `bg-black/50`, hardcoded `&times;` close button — no ResponsiveDialog, no feature flag check

---

## 3) Codebase Map

### Primary Components (Files to Change)

| File                                          | Role                          | Lines |
| --------------------------------------------- | ----------------------------- | ----- |
| `features/pulse/ui/PulsePanel.tsx`            | Main scheduler dashboard      | 171   |
| `features/pulse/ui/CreateScheduleDialog.tsx`  | Create/edit form              | 223   |
| `features/pulse/ui/RunHistoryPanel.tsx`       | Per-schedule run history      | 87    |
| `features/session-list/ui/SessionSidebar.tsx` | Pulse button + modal mount    | 237   |
| `entities/pulse/model/use-schedules.ts`       | Schedule query/mutation hooks | 69    |
| `entities/pulse/model/use-runs.ts`            | Run query/mutation hooks      | 41    |
| `entities/pulse/index.ts`                     | Entity barrel exports         | 13    |
| `features/pulse/index.ts`                     | Feature barrel exports        | 8     |

### Shared Dependencies (Reuse As-Is)

| Component          | From                                           | Use For                     |
| ------------------ | ---------------------------------------------- | --------------------------- |
| `ResponsiveDialog` | `shared/ui/responsive-dialog.tsx`              | Replace custom modal        |
| `Switch`           | `shared/ui/switch.tsx`                         | Replace custom toggle       |
| `Badge`            | `shared/ui/badge.tsx`                          | Status indicators           |
| `Select`           | `shared/ui/select.tsx`                         | Form selects                |
| `Label`            | `shared/ui/label.tsx`                          | Form labels                 |
| `Tabs`             | `shared/ui/tabs.tsx`                           | Potential panel tabs        |
| `Dialog`           | `shared/ui/dialog.tsx`                         | Confirmation dialogs        |
| `DirectoryPicker`  | `features/session-list/ui/DirectoryPicker.tsx` | CWD field                   |
| `cn()`             | `shared/lib/utils.ts`                          | Class merging               |
| `motion/react`     | motion.dev                                     | Animations                  |
| `cronstrue`        | npm                                            | Cron preview (already used) |

### Data Flow

```
Server Config (GET /api/config)
  → useConfig() hook (TanStack Query)
  → SessionSidebar reads scheduler.enabled
  → Conditional: show Pulse button or hide/disable

User clicks Pulse button
  → PulsePanel opens (ResponsiveDialog)
  → useSchedules() fetches GET /api/pulse/schedules
  → Schedule list renders with status, nextRun, last run info

User creates schedule
  → CreateScheduleDialog (ResponsiveDialog nested)
  → useCreateSchedule() mutation → POST /api/pulse/schedules
  → Cache invalidation → schedule list refreshes

User expands schedule row
  → RunHistoryPanel appears (AnimatePresence)
  → useRuns({ scheduleId }) fetches GET /api/pulse/runs
  → Auto-refetch every 10s for live status

User clicks run row
  → setActiveSession(run.sessionId)
  → Main chat panel shows run transcript
```

### Feature Flag Detection

The server's `GET /api/config` already returns `scheduler.enabled`. The client needs:

1. A `useServerConfig()` hook (or reuse the existing config query from SettingsDialog)
2. Conditional rendering in SessionSidebar: show Pulse button at reduced opacity when disabled
3. PulsePanel renders a "Pulse not enabled" empty state when disabled

### Potential Blast Radius

- **Direct changes:** 8 files (listed above)
- **New files:** 2-4 (new sub-components extracted from PulsePanel, possibly a cron preset component, possibly a timezone combobox)
- **Test updates:** 5 test files in `features/pulse/__tests__/` and `entities/pulse/__tests__/`
- **Shared UI:** No changes to existing shared components
- **Server:** Minimal — may need to ensure config endpoint includes `scheduler.enabled` in the response (likely already does)

---

## 4) Root Cause Analysis

N/A — this is a feature enhancement, not a bug fix.

---

## 5) Research

### Cron Input: Three-Tier Hybrid

Production tools (Vercel, GitHub Actions, crontab.guru, neocron) converge on:

1. **Preset pills** for the 80% case (9 canonical presets)
2. **Raw cron input** with live human-readable preview (already implemented via cronstrue)
3. Visual builder as optional V2 enhancement

**Recommendation:** Add preset pills as a scrollable row above the cron input. Clicking a preset fills the cron field. The field remains editable for custom expressions. This is the highest-impact, lowest-effort improvement.

**Canonical presets:**

| Label            | Cron           |
| ---------------- | -------------- |
| Every 5 min      | `*/5 * * * *`  |
| Every 15 min     | `*/15 * * * *` |
| Hourly           | `0 * * * *`    |
| Every 6 hours    | `0 */6 * * *`  |
| Daily (midnight) | `0 0 * * *`    |
| Daily (9am)      | `0 9 * * *`    |
| Weekdays (9am)   | `0 9 * * 1-5`  |
| Weekly (Mon)     | `0 9 * * 1`    |
| Monthly (1st)    | `0 9 1 * *`    |

### Feature Enablement: Disable, Don't Hide

Smashing Magazine (2024) + Cloudscape Design System: **always show the nav item** for features that _can_ be enabled; use reduced opacity + tooltip to communicate disabled state. When clicked while disabled, show an educational empty state explaining how to enable.

**Recommendation:**

- Sidebar icon at `opacity-50` when disabled, with tooltip "Pulse is disabled"
- PulsePanel renders empty state: icon + explanation + `dorkos --pulse` code snippet
- No spinner, no error — just calm explanation

### Timezone: Searchable Combobox

Replace native `<select>` with a shadcn `Popover + Command` combobox pattern:

- Auto-detect user timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`
- Group by continent (parse IANA prefix: `America/`, `Europe/`, `Asia/`)
- Support fuzzy search by city name
- "System default" option at top

### Run History: Compact Activity Log

- Replace Unicode status entities with Lucide icons (animated `Loader2` for running)
- Relative timestamps ("2 hours ago") via `Intl.RelativeTimeFormat`
- Click-to-session affordance: `ChevronRight` icon or "View session" on hover
- Skeleton loading state (3 skeleton rows)
- Show output summary on hover or in expandable detail

### Empty States: Three-Part Formula (NN/Group)

1. **System status:** "No schedules yet"
2. **Learning cue:** "Pulse runs AI agent tasks on a schedule"
3. **Action CTA:** "New Schedule" button

### Confirmation & Feedback Decision Tree

| Action           | Pattern                                                       |
| ---------------- | ------------------------------------------------------------- |
| Toggle on/off    | Optimistic update, no toast (switch state is self-evidencing) |
| Run Now          | Brief toast: "Run triggered"                                  |
| Approve schedule | Brief toast: "Schedule approved"                              |
| Reject schedule  | No toast (low stakes)                                         |
| Delete schedule  | Confirmation dialog (destructive, irreversible)               |
| Cancel run       | Optimistic status update in run row                           |
| Create/edit      | Close dialog on success (current pattern, correct)            |

### Form Progressive Disclosure

Stage the CreateScheduleDialog into three sections:

1. **Essential** (always visible): Name, Prompt, Schedule (presets + cron)
2. **Common** (visible, below divider): Timezone, Working Directory
3. **Advanced** (collapsed by default): Permission Mode, Max Runtime

---

## 6) Clarification

1. **Toast infrastructure:** The client has no toast/notification system. Should we add one (e.g., sonner, react-hot-toast) or use a simpler inline feedback pattern? Sonner is the standard shadcn recommendation.

2. **Pulse button visibility when disabled:** Should the HeartPulse icon in the sidebar be (a) always visible at reduced opacity with a tooltip, (b) hidden entirely when Pulse is disabled, or (c) visible but with a lock/disabled indicator?

3. **Delete action for active schedules:** Currently there's no way to delete a non-pending schedule. Should we add a three-dot dropdown menu on each schedule row with Edit/Delete options, or keep it minimal?

4. **Run detail panel vs. direct session navigation:** When clicking a run, should we (a) navigate directly to the session transcript (current behavior), (b) open an intermediate detail panel showing output summary + error + metadata with a "View full session" link, or (c) both — detail on single click, session on double-click or explicit button?

5. **Sidebar active run indicator:** Should the HeartPulse icon show a small badge/dot when runs are actively executing? This would require polling the runs endpoint from the sidebar level.

6. **Scope of motion/animation:** Should we add entrance animations to individual schedule cards in the list (like message entrance animations), or keep animations limited to expand/collapse transitions?
