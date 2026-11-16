---
slug: pulse-schedule-templates
number: 124
created: 2026-03-11
status: ideation
---

# Pulse Schedule Preset Gallery

**Slug:** pulse-schedule-templates
**Author:** Claude Code
**Date:** 2026-03-11
**Branch:** preflight/pulse-schedule-templates

---

## 1) Intent & Assumptions

- **Task brief:** The Pulse scheduler has hardcoded "presets" (factory-default schedule templates) that are already written to `~/.dork/pulse/presets.json`. These presets should be surfaced as a first-class discovery and creation mechanism everywhere a user can create a schedule — not just during onboarding.
- **Assumptions:**
  - "Presets" is the correct, stable term everywhere (not "templates")
  - The existing file location (`~/.dork/pulse/presets.json`) and API endpoint (`GET /api/pulse/presets`) are already correct
  - The 4 built-in presets (Health Check, Dependency Audit, Docs Sync, Code Review) are sufficient for this spec
  - Presets remain file-based (no database table)
- **Out of scope:**
  - Renaming "presets" to "templates" anywhere in code or UI
  - User-created custom presets ("Save as preset" feature)
  - A remote preset marketplace or sharing mechanism
  - Adding new built-in presets (that can be a follow-on)

---

## 2) Pre-reading Log

- `apps/server/src/services/pulse/pulse-presets.ts`: Factory defaults + file I/O; `ensureDefaultPresets()` creates `presets.json` on startup; `loadPresets()` reads it
- `apps/server/src/routes/pulse.ts`: `GET /api/pulse/presets` already exists, returns `PulsePreset[]`
- `apps/server/src/services/pulse/__tests__/pulse-presets.test.ts`: Good test coverage for the preset loading/saving system
- `packages/shared/src/schemas.ts`: `PulsePresetSchema` — fields: `id`, `name`, `description`, `prompt`, `cron`, `timezone?`, `category?`
- `packages/shared/src/transport.ts`: `getPulsePresets(): Promise<PulsePreset[]>` method in Transport interface
- `apps/client/src/layers/shared/lib/transport/pulse-methods.ts`: `getPulsePresets()` → `GET /pulse/presets`
- `apps/client/src/layers/features/onboarding/model/use-pulse-presets.ts`: `usePulsePresets()` TanStack Query hook (queryKey: `['pulse', 'presets']`)
- `apps/client/src/layers/features/onboarding/ui/PulsePresetsStep.tsx`: Onboarding step — toggleable preset cards, creates schedules for selected presets
- `apps/client/src/layers/features/onboarding/ui/PresetCard.tsx`: Preset card with mouse-tracking spotlight effect; shows name, description, cron, prompt snippet
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`: Full schedule creation form; **no preset integration currently**
- `apps/client/src/layers/features/pulse/ui/PulseEmptyState.tsx`: Main panel empty state; **no preset cards currently**
- `apps/client/src/layers/features/session-list/ui/SchedulesView.tsx`: Sidebar schedule summary; empty state shows "No schedules configured" + link to Pulse panel
- `apps/server/src/lib/dork-home.ts`: Single source of truth for `~/.dork/` path resolution
- `apps/client/src/layers/entities/pulse/`: TanStack Query hooks for all Pulse CRUD + run operations

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/services/pulse/pulse-presets.ts` — Preset file I/O service; the single server-side source of truth for presets
- `apps/server/src/routes/pulse.ts` — `GET /api/pulse/presets` route handler (already functional)
- `apps/client/src/layers/features/onboarding/model/use-pulse-presets.ts` — TanStack Query hook; currently onboarding-only but should be promoted to entities layer
- `apps/client/src/layers/features/onboarding/ui/PresetCard.tsx` — Preset display card; currently onboarding-only but should become a shared component
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx` — Needs two-step UX (preset picker → form)
- `apps/client/src/layers/features/pulse/ui/PulseEmptyState.tsx` — Needs preset cards
- `apps/client/src/layers/features/session-list/ui/SchedulesView.tsx` — Needs inline preset cards in empty state

**Shared Dependencies:**

- `@dorkos/shared` — `PulsePreset` type, `PulsePresetSchema`, `Transport.getPulsePresets()`
- `apps/client/src/layers/entities/pulse/` — TanStack Query hooks; `usePulsePresets` should move here
- `apps/client/src/layers/shared/lib/transport/pulse-methods.ts` — HTTP binding for `getPulsePresets`

**Data Flow:**
`~/.dork/pulse/presets.json` → `loadPresets()` → `GET /api/pulse/presets` → `HttpTransport.getPulsePresets()` → `usePulsePresets()` → UI components

**Feature Flags/Config:**

- Pulse must be enabled (`isPulseEnabled()`) for preset routes to be mounted and UI to appear

**Potential Blast Radius:**

- Direct: 5 files (CreateScheduleDialog, PulseEmptyState, SchedulesView, usePulsePresets location, PresetCard location)
- Indirect: OnboardingFlow (imports PresetCard/usePulsePresets from new location after move)
- Tests: CreateScheduleDialog tests, SchedulesView tests

---

## 4) Root Cause Analysis

_N/A — this is a feature addition, not a bug fix._

---

## 5) Research

### The Core UX Problem

Presets exist and work in onboarding but are completely invisible after that. A user who skips onboarding, or who wants to create a second or third schedule later, gets a blank form with no guidance. This creates friction for the exact workflows presets are designed to accelerate.

### Where Presets Should Appear

**1. CreateScheduleDialog** (highest impact)

The GitHub Actions "new workflow" flow is the right model: present templates first, let users pick one or start blank. Power users who know what they want click "Start from scratch" immediately — this costs them nothing. New users get a nudge toward useful defaults.

**Two-step flow:**

- Step 1: Preset gallery grid (name, description, cron summary) + "Start from scratch" button
- Step 2: Full form, pre-populated from selected preset (all fields editable)
- Back button on step 2 returns to gallery

This is preferable to an inline gallery section because:

- Avoids layout tension (template section competing with form fields)
- Templates become a purposeful choice, not decoration
- Step 2 makes it clear the user is editing, not just accepting

**2. SchedulesView sidebar empty state** (visibility)

When no schedules exist, the sidebar is dead. Showing 2–3 preset cards (not all 4 — space is limited) turns it into a quick-start surface. A single "+ Use preset" action should directly open the CreateScheduleDialog pre-populated with that preset at step 2 (skip the picker step, they already chose).

**3. PulseEmptyState** (consistency)

The main Pulse panel empty state should also show the full preset gallery, consistent with how the panel works. Less critical than the above two but completes the picture.

**4. Onboarding** (already implemented)

`PulsePresetsStep` already handles this well. No changes needed there.

### Component Architecture Decision

`usePulsePresets` is currently in `features/onboarding/model/` — FSD violation risk if other features import it. It should move to `entities/pulse/` so any feature can consume it without violating layer rules.

`PresetCard` is currently in `features/onboarding/ui/` — same issue. It should move to `features/pulse/ui/` (or a shared location) so it can be reused in CreateScheduleDialog and PulseEmptyState.

### Recommended Approach

1. **Promote `usePulsePresets` to `entities/pulse/`** — makes it properly shared
2. **Promote `PresetCard` to `features/pulse/ui/`** — reusable in dialog and empty states
3. **Retrofit CreateScheduleDialog with two-step UX** — preset picker as step 1
4. **Retrofit PulseEmptyState with preset gallery** — show all 4 presets with CTAs
5. **Retrofit SchedulesView empty state with 2–3 preset cards** — compact variant of PresetCard

### Potential Solutions Comparison

**Option A: Promote + retrofit (recommended)**

- Move `usePulsePresets` to entities, move `PresetCard` to pulse feature
- Add two-step flow to CreateScheduleDialog
- Pros: Clean architecture, minimal duplication, FSD-compliant
- Cons: Slightly more moving parts

**Option B: Duplicate**

- Copy PresetCard and usePulsePresets for each new use site
- Pros: Zero risk of breaking onboarding
- Cons: Violates DRY, multiple components to maintain

**Option C: Only add to dialog, skip sidebar/empty states**

- Minimal scope — just fix CreateScheduleDialog
- Pros: Smallest diff
- Cons: Doesn't solve discovery in the sidebar (where users spend most time)

**Recommendation: Option A** — clean and FSD-correct.

---

## 6) Decisions

| #   | Decision                              | Choice                                                   | Rationale                                                                                                                                                                                  |
| --- | ------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Terminology: "presets" vs "templates" | **Keep "presets" everywhere**                            | "presets" is already the consistent term in code, file system, and API. No rename needed — avoids a mechanical 14-file churn with no user-facing benefit.                                  |
| 2   | CreateScheduleDialog UX               | **Two-step: preset picker → form**                       | Step 1 shows a gallery grid + "Start from scratch"; selecting pre-populates the form in step 2. Matches GitHub Actions workflow picker. Power users skip to scratch; new users get nudged. |
| 3   | User-defined presets                  | **Out of scope — built-ins only**                        | Keep scope tight. "Save as preset" is a meaningful follow-on feature. The 4 built-ins cover the primary use cases for this iteration.                                                      |
| 4   | Sidebar SchedulesView empty state     | **Show 2–3 preset cards inline with "+ Use preset" CTA** | Turns the empty sidebar into a quick-start surface. "Use preset" opens CreateScheduleDialog pre-populated at step 2 (skipping the picker).                                                 |

---

## 7) Implementation Sketch

### New/Modified Files

```
apps/client/src/layers/entities/pulse/
  └── model/
      └── use-pulse-presets.ts          ← MOVE from features/onboarding/model/

apps/client/src/layers/features/pulse/ui/
  ├── PresetCard.tsx                    ← MOVE from features/onboarding/ui/
  ├── PresetGallery.tsx                 ← NEW: grid of PresetCards
  ├── CreateScheduleDialog.tsx          ← MODIFY: two-step UX
  └── PulseEmptyState.tsx              ← MODIFY: add PresetGallery

apps/client/src/layers/features/session-list/ui/
  └── SchedulesView.tsx                 ← MODIFY: add compact preset cards

apps/client/src/layers/features/onboarding/ui/
  └── PulsePresetsStep.tsx             ← MODIFY: import PresetCard from new location
```

### Data Shape (no changes needed)

`PulsePreset` is already sufficient:

```typescript
{ id, name, description, prompt, cron, timezone?, category? }
```

No schema changes. No new API endpoints. No database changes.

### CreateScheduleDialog Two-Step State

```typescript
type DialogStep = 'preset-picker' | 'form';
const [step, setStep] = useState<DialogStep>('preset-picker');
const [selectedPreset, setSelectedPreset] = useState<PulsePreset | null>(null);

// When user picks a preset: setSelectedPreset(preset); setStep('form')
// When user clicks "Start from scratch": setSelectedPreset(null); setStep('form')
// Back button: setStep('preset-picker')
// Form initialValues derived from selectedPreset (or empty)
```

### SchedulesView Preset Cards

- Only show when `schedules.length === 0`
- Show 2 cards max (Health Check + Docs Sync as the most universally useful)
- Compact variant of PresetCard: name + cron description + "+ Use preset" button
- "Use preset" → opens `CreateScheduleDialog` with step='form' and preset pre-filled (bypasses picker)
- "Open Pulse →" CTA preserved below the cards
