# Pulse Scheduler V2 — Research Report

**Date**: 2026-02-21
**Scope**: Three deferred V2 items — visual cron builder, DirectoryPicker refactoring, calm tech notifications
**Research depth**: Deep

---

## Research Summary

All three V2 enhancements have clear, implementable solutions. The best path for the cron builder is a custom 5-field visual component built on existing shadcn/ui primitives (no external library), because every library option has disqualifying trade-offs for this codebase. The DirectoryPicker refactor follows a well-established optional-callback pattern requiring a minimal prop addition and one conditional branch. The notification system should be a purely passive, poll-driven status layer using the existing infrastructure already present in the sidebar (`useActiveRunCount`, the green dot indicator, and Sonner which is already installed).

---

## Key Findings

### 1. Visual Cron Builder

**Finding**: No available open-source library is a good fit. All have at least one disqualifying issue (antd dependency, stale maintenance, or requires Tailwind v3 while this project is on Tailwind v4). The correct approach is a custom component — the implementation surface is small and fully within the capabilities of existing `Select` primitives already in the shadcn/ui inventory.

**Finding**: The existing CronPresets + raw input architecture should be *augmented*, not replaced. The preset pills handle ~80% of real-world scheduling needs. The visual builder should be a third mode, accessible via a "Custom..." expansion panel, not the default entry point.

**Finding**: `cronstrue` is already imported in `CreateScheduleDialog.tsx` and produces human-readable previews. This covers the feedback loop for any expression the builder produces.

### 2. DirectoryPicker Refactoring

**Finding**: The DirectoryPicker has exactly two call sites for selection: `handleSelect` (browse mode) and `handleRecentSelect` (recent mode). Both currently call `setSelectedCwd` unconditionally. Adding an optional `onSelect` prop and a single branch at those two call sites is sufficient — the component needs no structural changes.

**Finding**: The correct pattern is the optional-callback override: when `onSelect` is provided it replaces the `setSelectedCwd` call; when omitted the component continues to write to global state. This keeps backward compatibility at the single existing usage in `SessionSidebar.tsx`.

**Finding**: The `CreateScheduleDialog` form field use-case needs the picker to write into local `FormState.cwd` rather than global Zustand state. This is a textbook optional-callback situation.

### 3. Calm Tech Notifications

**Finding**: The existing green dot on the HeartPulse button (`activeRunCount > 0`) is already a correct ambient indicator for *in-progress* runs. The gap is a completed-run signal that persists until the user acknowledges it, without interrupting them.

**Finding**: The Sonner library is already installed in this project (`apps/client/src/layers/shared/ui/sonner.tsx` present per git status). A low-priority Sonner toast on run completion is the lowest-friction notification — it auto-dismisses, is non-modal, and integrates with the existing design system.

**Finding**: The browser Badging API (`navigator.setAppBadge()`) is the best zero-interruption ambient indicator for tab-level awareness. It works without any permission prompt, unlike the Notification API. Badge count = number of completed runs since last Pulse panel open.

**Finding**: A "completed run badge" on the HeartPulse button itself (distinct orange/green dot for "done, unseen" vs "currently running") is the most contextually appropriate ambient indicator — it is where the user already looks for Pulse status.

---

## Detailed Analysis

### Visual Cron Builder

#### Library Landscape Assessment

| Library | Stars | Last Release | Deps | Verdict |
|---|---|---|---|---|
| `cron-builder-ui` (vpfaiz) | 1 | Aug 2025 | Radix + Tailwind | 2 commits, effectively unmaintained |
| `react-js-cron` | ~250 | >12mo ago | **antd** | Disqualified — antd is a huge dep tree incompatible with this project's design system |
| `neocron` | ~30 | Nov 2023 | Radix + Tailwind v3 | Tailwind v3 only; peer dep mismatch with Tailwind v4 |
| `react-cron-generator` | modest | unclear | jQuery-era patterns | Legacy API; incompatible with React 19 |
| `@sbzen/re-cron` | small | older | Angular-first | Not React-native |

**Conclusion**: Build custom. The implementation is not large.

#### Custom Builder Architecture

The 5-field cron structure maps directly to 5 `Select` components already available in `@/layers/shared/ui`:

```
┌───────────┬─────────────┬──────────────┬────────────┬─────────────────┐
│  Minute   │    Hour     │  Day of Mo   │   Month    │  Day of Week    │
│  Select   │   Select    │   Select     │   Select   │    Select       │
└───────────┴─────────────┴──────────────┴────────────┴─────────────────┘
        ↓  produces: "0 9 * * 1-5"  →  cronstrue preview
```

Each select has three value modes: `*` (every), `*/N` (every N), or a list of specific values. The tricky field is day-of-week and day-of-month ranges like `1-5` or `*/2`. A reasonable V2 scope simplifies to: each field supports either `*` (any) or a single specific value. This covers the long tail of real-world schedules beyond what the presets handle, without requiring a multi-value picker (which would need a `Popover` + checkbox list — a V3 scope item).

#### Recommended Component Structure

```
features/pulse/ui/
├── CronVisualBuilder.tsx      # New: the 5 Select controls + preview line
├── CronPresets.tsx            # Existing (unchanged)
├── CreateScheduleDialog.tsx   # Updated: add "Custom..." toggle
```

`CronVisualBuilder` accepts `value: string` + `onChange: (cron: string) => void` — identical API to `CronPresets`. The dialog can share a single `cron` state value across both modes.

**Toggle UX**: Below the preset pills, a `"Custom schedule →"` text button expands the visual builder. When a preset is active, its pill highlights. When the visual builder produces an expression not in the preset list, no pill highlights. The `cronstrue` preview line renders below both, in muted text. This matches how tools like Railway and Render present cron — presets first, custom as an escape hatch.

#### Field Spec (V2 scope)

| Field | Options in Select | Wildcard label |
|---|---|---|
| Minute | `*` (any), 0, 5, 10, 15, 20, 30, 45 | "Every minute" |
| Hour | `*` (any), 0–23 | "Every hour" |
| Day of Month | `*` (any), 1–31 | "Every day" |
| Month | `*` (any), Jan–Dec | "Every month" |
| Day of Week | `*` (any), Sun–Sat | "Every day of week" |

Expression assembly: concatenate the five select values with spaces. When all are `*`, the string is `* * * * *`.

#### Preset Interaction

When the visual builder is open and the user clicks a preset pill, parse the preset cron string back into the 5-field state. This requires a simple `parseCron(expr: string)` utility that splits on whitespace. The reverse — visual builder → preset highlight — happens by comparing the assembled string against the preset list.

---

### DirectoryPicker Refactoring

#### Current Behaviour

The DirectoryPicker writes directly to global state in two places:

```typescript
// handleSelect (browse mode)
setSelectedCwd(data.path);  // line 56

// handleRecentSelect (recent mode)
setSelectedCwd(dirPath);    // line 78
```

It also calls `onClose()` immediately after both writes. Both of these behaviours need to be overridable for form-field use.

#### Proposed Prop Addition

```typescript
interface DirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (path: string) => void;   // NEW: when provided, overrides global state write
}
```

#### Refactored Internal Logic

```typescript
const handleSelect = useCallback(() => {
  if (!data?.path) return;
  if (onSelect) {
    onSelect(data.path);   // caller manages state
  } else {
    setSelectedCwd(data.path);   // existing global behaviour
  }
  onClose();
}, [data?.path, onSelect, setSelectedCwd, onClose]);

const handleRecentSelect = useCallback((dirPath: string) => {
  if (onSelect) {
    onSelect(dirPath);
  } else {
    setSelectedCwd(dirPath);
  }
  onClose();
}, [onSelect, setSelectedCwd, onClose]);
```

The `setSelectedCwd` import and call remain unconditionally present in the non-`onSelect` branch, so the existing `SessionSidebar` usage requires zero changes.

#### Usage in CreateScheduleDialog

```typescript
// In CreateScheduleDialog form state
const [cwdPickerOpen, setCwdPickerOpen] = useState(false);

// In render, inline with the cwd field
<DirectoryPicker
  open={cwdPickerOpen}
  onOpenChange={setCwdPickerOpen}
  onSelect={(path) => setForm((f) => ({ ...f, cwd: path }))}
/>
```

The `cwd` field label + button to open the picker replace the current plain text input for `cwd`, giving users a visual browser instead of requiring them to type a path.

#### Pattern Classification

This is the **optional-callback override** pattern — identical to how React's own controlled/uncontrolled input duality works. The presence of the prop signals "controlled by caller"; its absence signals "self-managed". This is the correct pattern because:

1. Zero breaking changes to the existing consumer
2. No state duplication — the caller provides their own state slot
3. No compound component complexity needed — the picker is a single-concern dialog

---

### Calm Tech Notifications

#### Calm Tech Principle Hierarchy (applied to run completion)

Amber Case's calm technology principles, ordered by attention demand:

1. **Periphery first** — information that informs without overwhelming
2. **Center only when necessary** — escalate to focus only if urgent
3. **Inform, don't interrupt** — communicate without taking the user out of their task

A completed Pulse run is never urgent. The user schedules it; they expect it to run. The notification goal is: *when the user naturally glances at the UI, they can see something completed*. Not: *alert the user right now*.

#### Notification System Design

**Three ambient layers, from quietest to loudest:**

**Layer 1 — Sidebar button badge (always on, zero interruption)**

The HeartPulse button already has a pulsing green dot for active runs. Add a second dot state: a static orange/amber dot for "completed runs not yet viewed". The dot appears when `completedSinceLastView > 0` and clears when the Pulse panel is opened.

```
States of the HeartPulse icon:
  (no dot)     → pulse disabled or no activity
  green pulse  → run(s) currently active
  amber static → run(s) completed since last panel open
  both         → run(s) active AND prior completions unseen
```

Implementation: a `useCompletedRunBadge()` hook in `entities/pulse` that:
- Polls `useRuns()` (already at 10s interval)
- Tracks the set of run IDs that were `running` in the previous poll and are now `success` or `failed`
- Persists "last viewed at" timestamp to `localStorage`
- Returns `{ unviewedCount: number, clearBadge: () => void }`

The `SessionSidebar` calls `clearBadge()` when `pulseOpen` transitions from false → true.

**Layer 2 — Sonner toast (opt-in, low interruption)**

When a run completes, fire a Sonner toast. Sonner is already installed. The toast should be:
- `duration: 6000` (6 seconds, longer than default 4s since the user may not be looking)
- `position: 'bottom-right'`
- Variant: default (not destructive) for success, destructive for failure
- Content: schedule name + outcome + "View history →" action button

```typescript
toast(`"${scheduleName}" completed`, {
  description: 'Pulse run finished successfully.',
  duration: 6000,
  action: {
    label: 'View history',
    onClick: () => setPulseOpen(true),
  },
});
```

The toast is dismissible and auto-clears. It doesn't demand focus and doesn't block interaction. This is well within calm tech principles — a toast that slides in at the periphery of vision and disappears without acknowledgement.

**Layer 3 — Tab title badge (optional, browser-tab awareness)**

When the tab is in the background (`document.hidden === true`) and a run completes, prepend a count to the document title: `"(2) DorkOS"`. Clear when the tab regains focus. This is a common and well-understood pattern (used by GitHub, Linear, Slack).

```typescript
// In a useEffect tied to completedCount
document.title = completedCount > 0 ? `(${completedCount}) DorkOS` : 'DorkOS';
```

This can be implemented entirely in `shared/lib/favicon-utils.ts` (already exists per CLAUDE.md) as a `updateTabBadge(count: number)` utility.

**Layer 4 — Browser Notification API (explicitly NOT recommended)**

The browser `Notification` API requires a permission prompt, is disruptive by nature (system-level popup), and is architecturally inappropriate for a calm tool. The "check history, don't push" philosophy directly excludes this approach. Do not implement.

**Layer 5 — Favicon badge dot (optional, very advanced)**

The `navigator.setAppBadge()` API (Badging API) places a dot on the browser tab favicon. It requires no permission prompt (unlike Notification API), works in all modern browsers, and is entirely ambient. However it only works for installed PWAs in most browsers, limiting its reach for a web-only app. This is a V3+ item.

#### Implementation Plan (sequenced by calm tech alignment)

| Priority | Feature | Calm score | Effort |
|---|---|---|---|
| 1 | Sidebar amber dot badge | 10/10 | Low |
| 2 | Sonner toast on completion | 8/10 | Low |
| 3 | Tab title `(N) DorkOS` | 9/10 | Low |
| Later | Favicon badging API | 10/10 | Medium |
| Never | Browser Notification API | 2/10 | — |

**Data plumbing**: All three tiers can be driven from a single `useCompletedRunBadge()` hook that compares consecutive `useRuns()` snapshots. The hook lives at `entities/pulse/model/use-completed-run-badge.ts`. The toast fires as a side effect inside the hook (or in a dedicated `useRunCompletionToasts.ts` if keeping the hook pure).

**Key design decision**: The toast and badge should *not* fire for runs that were already complete when the app first loads. They should only fire for runs that transition from `running` → terminal during the current browser session. This prevents spamming users who open the app after a batch of overnight runs.

---

## Security & Performance Considerations

- **CronVisualBuilder**: The assembled cron string must pass through the existing `cronstrue.toString()` validation before submission. The visual builder can only produce valid 5-field standard expressions, so the validation is more of a belt-and-suspenders guard. No additional server-side validation is needed beyond what already exists.

- **DirectoryPicker onSelect callback**: The `onSelect` path still routes through the same `data.path` value returned from the `browseDirectory` transport call, which is validated on the server by `lib/boundary.ts`. No new attack surface.

- **Notification polling**: `useRuns()` already polls at 10-second intervals. The completion badge detection adds O(n) comparison of run IDs across two consecutive poll results. For any realistic Pulse schedule list (< 100 runs displayed), this is negligible.

- **Tab title updates**: `document.title` writes are synchronous and cheap. No debounce needed. Clear on `visibilitychange` event (tab focus regained).

- **localStorage for badge state**: Storing "last viewed timestamp" in localStorage is appropriate. The badge state is not sensitive, it is ephemeral, and localStorage survives tab refresh (which is desirable — a completed run stays "unseen" until the user opens the Pulse panel).

---

## Research Gaps & Limitations

- The `neocron` library was not tested locally against Tailwind v4. It is possible its Tailwind v3 peer dep warning is non-fatal in practice. However, given the low maintenance cadence (last release Nov 2023) and small community, building custom remains the safer long-term choice.

- The Sonner toast trigger location is unresolved: the hook should be placed where it can access `setPulseOpen`. This suggests it lives in `SessionSidebar` or a new `PulseNotificationBridge` component rendered inside the layout. A `useRunCompletionToasts(onOpenPulse: () => void)` hook signature makes this dependency explicit.

- Railway and Render's exact cron UI implementations were not accessible via scraping during this session (login-gated). Based on documentation, both use raw text input + human-readable preview (cronstrue equivalent). Neither appears to have a visual 5-field builder in their schedule creation UI as of 2025.

---

## Contradictions & Disputes

- `cron-builder-ui` markets itself as "built with shadcn/ui design patterns" but has 2 commits and 1 star. It should not be treated as a production-ready dependency despite the appealing description.

- Some sources suggest the browser Notification API is "the right way" to notify users of background task completion. This directly conflicts with the Calm Tech design language documented in `.claude/rules/components.md` ("Check history, don't push"). The Calm Tech principle takes priority here.

---

## Search Methodology

- Searches performed: 9
- Most productive terms: `"cron-builder-ui" github`, `neocron react tailwind`, `calm technology notification design patterns`, `favicon badge tab title update web app`, `react component onSelect callback pattern dual mode`
- Primary sources: GitHub repositories (direct inspection), calmtech.com (primary source), npm package pages, MDN Web Docs (Badging API), shadcn/ui docs
- Codebase files read: `DirectoryPicker.tsx`, `SessionSidebar.tsx`, `CreateScheduleDialog.tsx`, `CronPresets.tsx`, `use-runs.ts`
