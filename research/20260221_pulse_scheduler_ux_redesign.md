# Pulse Scheduler UI/UX Redesign Research

**Date**: 2026-02-21
**Research Mode**: Deep Research
**Searches performed**: 14
**Topic**: Best practices for redesigning the Pulse cron scheduler feature in DorkOS

---

## Research Summary

Production scheduler UIs across GitHub Actions, Vercel, Railway, and Cronicle converge on a handful of patterns: a three-tier input model for cron (presets → visual builder → raw expression), run history as a compact activity log with inline status indicators, and feature-disabled states that keep UI discoverable with clear upgrade/enable paths. For a "Calm Tech" tool like DorkOS, the right approach is progressive disclosure — simple presets surfaced first, power-user controls hidden behind a single toggle, and status communicated through color-coded micro-indicators rather than intrusive alerts.

The current Pulse prototype has the right structural skeleton (schedule list, expand-to-history, create dialog) but is missing the design system integration, animation layer, preset shortcuts, timezone combobox, and proper empty state that would make it feel intentional.

---

## Key Findings

### 1. Cron Input Patterns

The universal consensus across every production tool (Vercel, GitHub Actions, crontab.guru, neocron, cron-builder-ui) is a **three-tier hybrid approach**:

1. **Preset chips/buttons** for the 80% use case (every hour, daily at 9am, weekdays only, etc.)
2. **Visual field builder** as an optional middle layer (dropdowns for minute/hour/day/month/weekday)
3. **Raw cron input** for power users, with real-time human-readable translation directly below it

All three tiers update the same underlying cron expression state, so switching between them never loses work. The cronstrue library (already used in Pulse) is exactly the right tool for the real-time translation — the current implementation already has this wired up in `getCronPreview()`.

**What is missing in the current `CreateScheduleDialog`**: There are no preset shortcuts. Users are dropped directly into a raw `<input>` with a placeholder of `0 9 * * 1-5`. A developer knows what that means, but even developers don't want to type it from scratch every time.

### 2. Run History and Activity Feed Patterns

GitHub Actions and CircleCI converge on a **compact list** pattern for run history:
- Status icon leftmost (colored dot or check/X icon)
- Trigger type (scheduled / manual)
- Timestamp (relative: "2 hours ago", not absolute)
- Duration
- Click-row to navigate to the session (Pulse already does this via `setActiveSession`)

The current `RunHistoryPanel` grid layout is structurally correct. The main gaps are:
- Unicode character entity icons (`&#9679;`, `&#10003;`, `&#10007;`) instead of Lucide icons
- No skeleton loading state — it shows "Loading runs..." as plain text
- No animation on row expansion
- Absolute timestamps instead of relative ones
- The "No runs yet" empty state has no actionable CTA (but in this context a CTA isn't necessary — a brief hint is fine)

### 3. Feature Enablement UX

Smashing Magazine's 2024 "Hidden vs. Disabled" research establishes the decision rule cleanly: **disable if the user might ever be able to enable the feature; hide if it is permanently inaccessible**.

For Pulse, the feature can be enabled via the `--pulse` CLI flag or the config file — so it should **always be visible in the sidebar/nav**, never hidden. When disabled, the pattern is:
- Show the nav item at reduced opacity
- On click, show a tooltip or inline callout: "Pulse is disabled. Start DorkOS with --pulse to enable it."
- The Pulse panel itself should render an empty state explaining how to enable — not an error, not a spinner

The AWS Cloudscape Design System articulates this succinctly: "Use one sentence to describe what is disabled and the reason. If additional context would help the user solve for the disabled state, use a second sentence to explain next steps."

### 4. Timezone Selection

The Vitaly Friedman (Smart Interface Design Patterns) research and NN/Group both agree:
- A native `<select>` with 400+ options is hostile UX — confirmed by the current implementation
- The correct pattern is a **searchable combobox** (shadcn/ui's `<Combobox>` or `<Command>` palette pattern)
- Search should support: city name, country name, timezone abbreviation (CEST, PST), and UTC offset
- Options should be sorted alphabetically by city, **not** by UTC offset
- Always include a "System default" option at the top, separate from the list
- Auto-detect the user's timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone` and pre-select it
- Show the current local time in each timezone option to aid scanning (optional enhancement)

The current implementation uses `Intl.supportedValuesOf('timeZone')` to get timezone names and renders them in a `<select>` — this is correct data sourcing but wrong interaction pattern.

### 5. Preset Catalog (What to Include)

Based on crontab.guru's most-used examples, GitHub Actions documentation, and production scheduler tools, the canonical preset list for an AI agent scheduler is:

| Label | Cron | Use case |
|---|---|---|
| Every 5 minutes | `*/5 * * * *` | Health checks, polling |
| Every 15 minutes | `*/15 * * * *` | Frequent syncs |
| Every hour | `0 * * * *` | Periodic tasks |
| Every 6 hours | `0 */6 * * *` | Semi-frequent digests |
| Daily at midnight | `0 0 * * *` | Nightly jobs |
| Daily at 9am | `0 9 * * *` | Business hours kickoff |
| Weekdays at 9am | `0 9 * * 1-5` | Work-day tasks |
| Weekly (Monday) | `0 9 * * 1` | Weekly reports |
| Monthly (1st) | `0 9 1 * *` | Monthly digests |

The UI should show these as a scrollable row of small pill buttons above the cron input field. Clicking one fills the cron field and updates the preview. The pills should be dismissible (the user can clear the selection by editing the field directly).

### 6. Empty State Design

NN/Group's 2024 "Empty States in Complex Applications" research defines three requirements for good empty states in feature panels:

1. **Communicate system status** — not "No scheduled jobs" but "No schedules yet"
2. **Provide learning cues** — a single sentence about what Pulse does (e.g., "Pulse runs AI agent tasks on a schedule")
3. **Offer a direct task pathway** — a single primary CTA that opens the CreateScheduleDialog

For the "feature disabled" variant of the empty state, the CTA changes from "New Schedule" to a code snippet or instruction showing the `--pulse` flag. This is the "educational empty state" pattern used by tools like DataDog for features behind a flag.

Do not use sample/fake data (ghost schedules) — this is a power-user tool and fake data creates confusion about what is real.

### 7. Confirmation and Feedback Patterns

The LogRocket UX research and the broader "optimistic UI" literature converge on this decision tree:

| Action | Pattern |
|---|---|
| Toggle schedule on/off | Optimistic update, no confirmation, no toast — the toggle itself is the feedback |
| Delete schedule | Confirmation dialog (destructive, irreversible) |
| Approve agent schedule | Optimistic update + brief toast "Schedule approved" |
| Reject agent schedule | Optimistic update, no toast (less important than approve) |
| Run Now (manual trigger) | Optimistic update + brief toast "Run triggered" |
| Cancel running job | Optimistic update + status update in run history row |
| Create/edit schedule | Form submission → close dialog on success (current pattern is correct) |

The key principle from the literature: "Email archived. Undo?" beats "Are you sure?" for reversible actions. But schedule deletion is genuinely destructive (all associated run history), so a confirmation dialog is warranted there. The current code calls `deleteSchedule.mutate(schedule.id)` directly on Reject without any confirmation — this is acceptable because Reject on a `pending_approval` schedule is lower-stakes than delete, but it would be better to at minimum show a brief confirmation tooltip.

For the enable/disable toggle: the current implementation already does optimistic update via TanStack Query. The main gap is that there is no visual feedback while the mutation is in-flight (no loading spinner on the toggle, no rollback indicator if it fails).

### 8. Calm Tech Application to Scheduler UIs

Mark Weiser's Calm Technology principles, as applied to scheduler interfaces, yield these rules:

- **Status should live in the periphery**: The status dot (green/yellow/grey) is correct. Avoid badges with numbers unless the count is directly actionable.
- **Notifications should start off**: Never auto-show a toast when a scheduled run completes. Users should discover run completion by checking the history panel.
- **Protect whitespace**: The current dense grid in RunHistoryPanel is appropriate for the "expanded details" context. The main schedule list should have more vertical breathing room per row.
- **Progressive disclosure**: Most schedule metadata (timezone, working directory, permission mode, max runtime) should be hidden behind an "advanced" section in the create dialog — the critical path is: name, prompt, schedule. Everything else is optional.

---

## Detailed Analysis

### CreateScheduleDialog Redesign Priorities

The current dialog (`CreateScheduleDialog.tsx`) presents all 7 fields as a flat vertical list. The cognitive load is high, especially for the cron expression field which requires external knowledge. The redesign should apply progressive disclosure in three stages:

**Stage 1 — Essential fields** (always visible):
- Name
- Prompt (textarea, perhaps collapsible after entry)
- Schedule (preset pills + cron input + live preview)

**Stage 2 — Common fields** (visible by default, but below a visual divider):
- Timezone (combobox replacing current native select)
- Working Directory

**Stage 3 — Advanced settings** (collapsed by default, `<details>` or shadcn Collapsible):
- Permission Mode
- Max Runtime

The preset pills should be implemented as a `ToggleGroup` (shadcn) where selecting a preset fills the cron field. A "Custom" option keeps the field editable without a preset selected. This is exactly the pattern used by `cron-builder-ui` (toggle groups for schedule type) and neocron (dual selector/input modes).

### PulsePanel Schedule List Redesign Priorities

The current list renders one card per schedule with a 2px border. The improvements needed:

1. **Replace raw `<button>` elements** with shadcn Button components for consistent styling
2. **Add AnimatePresence** from motion.dev for list item enter/exit animations (consistent with other panels)
3. **Replace the custom toggle switch** with shadcn's Switch component
4. **Add a "last run" status** to the schedule row subtitle (currently shows only nextRun, not the last run outcome)
5. **Pending approval visual treatment**: The current "Approve/Reject" button pair is functional but visually unanchored — it should use a distinct amber/warning color treatment consistent with the status dot
6. **Delete action**: There is no delete button for active (non-pending) schedules. Users can only delete via reject on pending schedules. A delete option should live in a `DropdownMenu` on the row (three-dot icon) to avoid cluttering the row with a visible delete button.

### RunHistoryPanel Redesign Priorities

1. Replace Unicode entities with Lucide icons: `CircleDot` for running, `CheckCircle2` for completed, `XCircle` for failed, `MinusCircle` for cancelled
2. Add `framer-motion` / motion.dev list animations for new rows appearing
3. Switch from absolute to relative timestamps using `Intl.RelativeTimeFormat` or the existing date-fns patterns in the codebase
4. Add a skeleton loading state (3 skeleton rows) instead of the "Loading runs..." text
5. The click-to-open-session affordance is not visually obvious — add a `ChevronRight` icon or a `Go to session` link on hover to communicate that the row is navigable

### Feature-Disabled State Design

When Pulse is disabled at the server level (the `--pulse` flag is not set), the current behavior is unknown from the client code — the API endpoints simply 404. The correct client-side treatment:

1. The server's `GET /api/config` response should include a `features.pulse: boolean` field
2. The client reads this from the server config hook and conditionally renders the disabled state
3. The disabled Pulse panel renders: icon + title + explanation + code block

```
[Clock icon]

Pulse is not enabled

Pulse runs AI agent tasks on a schedule. Start DorkOS with
the --pulse flag to enable it.

  dorkos --pulse

```

The sidebar icon for Pulse should render at `opacity-50` when disabled, with a tooltip on hover explaining the disabled state. This follows the Smashing Magazine "disable, don't hide" recommendation.

### Timezone Combobox Implementation Path

The existing data source (`Intl.supportedValuesOf('timeZone')`) is correct and already used in `CreateScheduleDialog`. The change needed is purely at the presentation layer:

- Replace `<select>` with a shadcn `<Popover>` + `<Command>` (the standard shadcn combobox pattern)
- Pre-populate the input with the detected local timezone: `Intl.DateTimeFormat().resolvedOptions().timeZone`
- The "System default" option maps to an empty string in the state (current behavior, correct)
- Group options by continent for better scanning (extract continent prefix from IANA names: `America/`, `Europe/`, `Asia/`, etc.)
- Show a UTC offset badge next to each option: `(UTC-05:00)` computed from `Intl.DateTimeFormat`

---

## Sources & Evidence

- "Hidden vs. Disabled In UX" — [Smashing Magazine](https://www.smashingmagazine.com/2024/05/hidden-vs-disabled-ux/) (May 2024)
- "Designing A Time Zone Selection UX" — [Smart Interface Design Patterns](https://smart-interface-design-patterns.com/articles/time-zone-selection-ux/)
- "Designing Empty States in Complex Applications: 3 Guidelines" — [Nielsen Norman Group](https://www.nngroup.com/articles/empty-state-interface-design/)
- "What is a toast notification? Best practices" — [LogRocket Blog](https://blog.logrocket.com/ux-design/toast-notifications/)
- "What Are Optimistic Updates?" — [Medium / Kyle DeGuzman](https://medium.com/@kyledeguzmanx/what-are-optimistic-updates-483662c3e171)
- "Managing Cron Jobs" — [Vercel Docs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- "Cron Expression Examples" — [Crontab.guru](https://crontab.guru/examples.html)
- "cron-builder-ui" — [GitHub / vpfaiz](https://github.com/vpfaiz/cron-builder-ui)
- "neocron" — [GitHub / nucleuscloud](https://github.com/nucleuscloud/neocron)
- "Cronicle" — [GitHub / jhuckaby](https://github.com/jhuckaby/Cronicle)
- "The Rise of Quiet Design: Why Calm Interfaces Win" — [Medium](https://medium.com/design-bootcamp/the-rise-of-quiet-design-why-calm-interfaces-win-9dd8930d15ae)
- "Calm Technology" — [calmtech.com](https://calmtech.com/)
- "Disabled and read-only states" — [Cloudscape Design System](https://cloudscape.design/patterns/general/disabled-and-read-only-states/)

---

## Research Gaps & Limitations

- **Railway and Render scheduler UIs**: These platforms have cron-like features but their dashboard UIs are not documented publicly in a way that surfaced in research. Both are primarily code-config driven (Railway uses a Cron service type, Render uses a YAML config) rather than dashboard-first schedulers.
- **Airplane.dev**: The product has been acquired/sunset; its UI patterns were not accessible.
- **Mobile/responsive patterns for scheduler UIs**: All research focused on desktop. Pulse appears to be a desktop-only panel, so this is unlikely to matter.
- **Error recovery flows**: How to handle a failed schedule (retry UI, error message display, alerting) was not researched in depth. This is a likely V2 concern.

---

## Contradictions & Disputes

- **Toast vs. no-toast for schedule toggle**: The LogRocket research recommends toasts for confirmations, but the "Calm Tech" philosophy argues against them for low-stakes actions. Resolution: no toast for toggle (the switch state is self-evidencing); toast only for triggered runs and approvals where the feedback is not immediately visible.
- **Preset pills vs. preset dropdown**: The vpfaiz cron-builder-ui uses a toggle group; neocron uses dropdowns. For a small, curated preset list (9 items), pills are preferable — they make all options scannable at once. A dropdown is better when options are dynamic or numerous (>12).

---

## Concrete Recommendations (Ordered by Impact)

### High Impact, Low Effort
1. Replace `<select>` timezone with shadcn Combobox + auto-detect current timezone
2. Replace Unicode status entities in RunHistoryPanel with Lucide icons
3. Add preset pill shortcuts above the cron expression input
4. Replace custom toggle switch with shadcn `Switch` component
5. Add deletion via a `DropdownMenu` three-dot button on each schedule row

### High Impact, Medium Effort
6. Implement progressive disclosure in CreateScheduleDialog (3-stage layout)
7. Add skeleton loading states to both PulsePanel and RunHistoryPanel
8. Implement relative timestamps in run history (e.g., "2 hours ago")
9. Add motion.dev `AnimatePresence` for schedule list and run history row animations
10. Add "last run status" to the schedule row subtitle

### Medium Impact, Medium Effort
11. Implement the feature-disabled empty state with server config integration
12. Add confirmation dialog for schedule deletion
13. Add optimistic loading indicator on toggle while mutation is in-flight
14. Add brief toast for "Run triggered" and "Schedule approved" actions
15. Add `ChevronRight` / hover affordance to run history rows to signal they're clickable

### Lower Priority
16. Group timezone options by continent in the combobox
17. Show UTC offset badges in timezone options
18. Collapsible "Advanced" section in CreateScheduleDialog
19. Add a "last run outcome" status dot variant (distinct from the enabled/disabled dot)

---

## Search Methodology

- **Searches performed**: 14
- **Most productive search terms**: "hidden vs disabled UX", "timezone selector UX best practices combobox", "cron expression builder UI presets shadcn react", "optimistic update toggle switch toast confirmation"
- **Primary source types**: Design system documentation (Carbon, Cloudscape), UX research articles (NN/Group, Smashing Magazine), production tool documentation (Vercel), open-source React component repos (cron-builder-ui, neocron, Cronicle)
- **Research depth**: Deep — covered all 7 requested topic areas with production examples
