# Pulse Schedule Preset Gallery

**Status:** Draft
**Authors:** Claude Code — 2026-03-11
**Spec:** `specs/pulse-schedule-templates/02-specification.md`
**Ideation:** `specs/pulse-schedule-templates/01-ideation.md`

---

## Overview

Pulse schedule presets already exist as a complete server-side system (`~/.dork/pulse/presets.json`, `GET /api/pulse/presets`) and are surfaced once — during onboarding — but then disappear entirely. A user who skips onboarding, or who wants to create a second schedule later, gets a blank form with no guidance.

This spec promotes the preset system to a first-class creation mechanism by surfacing presets in three new locations: (1) the `CreateScheduleDialog` two-step flow, (2) the `PulseEmptyState` main panel empty state, and (3) the `SchedulesView` sidebar empty state. The work is primarily architectural promotion and UI wiring — no server-side changes required.

---

## Background / Problem Statement

The four factory presets (Health Check, Dependency Audit, Docs Sync, Code Review) represent the most common agent scheduling patterns. They were designed to reduce time-to-first-schedule during onboarding, but that's the only place they're used. The result:

- Users who completed onboarding but skipped the preset step have no way back
- New users who create schedules post-onboarding face a blank form with no starting points
- The sidebar `SchedulesView` empty state is dead space with a single link
- The main `PulseEmptyState` shows decorative ghost cards but no actionable presets

The existing infrastructure is fully functional. This spec wires up the UI surfaces.

---

## Goals

- Surface presets in `CreateScheduleDialog` as a two-step flow: picker first, form second
- Show the preset gallery in `PulseEmptyState` (main panel empty state)
- Show 2 compact preset cards in `SchedulesView` sidebar empty state with a quick-create action
- Promote `usePulsePresets` to the `entities/pulse` layer (FSD compliance)
- Promote `PresetCard` to the `features/pulse` layer so multiple features can use it
- Ensure onboarding is unaffected (no regressions to `PulsePresetsStep`)

---

## Non-Goals

- User-created custom presets ("Save as preset") — out of scope
- Server-side changes — no modifications to `pulse-presets.ts`, API routes, or schemas
- Adding new factory presets beyond the existing 4
- Renaming "preset" to "template" anywhere — "presets" is the canonical term
- A remote preset marketplace or sharing mechanism

---

## Technical Dependencies

| Dependency        | Version           | Notes                                     |
| ----------------- | ----------------- | ----------------------------------------- |
| React 19          | `^19.0.0`         | Already installed                         |
| `motion/react`    | Already installed | Used for step transitions                 |
| TanStack Query v5 | Already installed | `usePulsePresets` hook                    |
| Zustand           | Already installed | `usePulsePresetDialog` coordination store |
| `@dorkos/shared`  | workspace         | `PulsePreset` type                        |

No new dependencies required.

---

## Technical Design

### Architecture Overview

```
entities/pulse/
  model/
    use-pulse-presets.ts         ← MOVE from features/onboarding/model/
    use-pulse-preset-dialog.ts   ← NEW: Zustand store for cross-feature trigger
  index.ts                       ← ADD: export usePulsePresets, usePulsePresetDialog

features/pulse/ui/
  PresetCard.tsx                 ← MOVE from features/onboarding/ui/
  PresetGallery.tsx              ← NEW: 2-column grid of PresetCards
  CreateScheduleDialog.tsx       ← MODIFY: two-step (picker → form)
  PulseEmptyState.tsx            ← MODIFY: add PresetGallery
  index.ts                       ← ADD: export PresetCard, PresetGallery

features/onboarding/ui/
  PulsePresetsStep.tsx           ← MODIFY: update import path for PresetCard
  OnboardingFlow.tsx             ← MODIFY: update import for usePulsePresets

features/session-list/ui/
  SchedulesView.tsx              ← MODIFY: empty state with compact preset cards
```

### Cross-Feature Communication

`SchedulesView` (in `features/session-list`) and `CreateScheduleDialog` (in `features/pulse`) cannot import each other — FSD forbids cross-feature imports. Coordination uses a Zustand store in `entities/pulse/model/use-pulse-preset-dialog.ts`. Both features can import from `entities/pulse` (features → entities is valid).

```typescript
// entities/pulse/model/use-pulse-preset-dialog.ts
import { create } from 'zustand';
import type { PulsePreset } from '@dorkos/shared/types';

interface PulsePresetDialogState {
  /** Preset to pre-populate, or null for blank form */
  pendingPreset: PulsePreset | null;
  /** Whether the dialog is being triggered externally */
  externalTrigger: boolean;
  openWithPreset: (preset: PulsePreset) => void;
  clear: () => void;
}

export const usePulsePresetDialog = create<PulsePresetDialogState>((set) => ({
  pendingPreset: null,
  externalTrigger: false,
  openWithPreset: (preset) => set({ pendingPreset: preset, externalTrigger: true }),
  clear: () => set({ pendingPreset: null, externalTrigger: false }),
}));
```

`SchedulesView` calls `openWithPreset(preset)` when a user clicks "Use preset". `PulsePanel` watches `externalTrigger` and opens `CreateScheduleDialog` — jumping directly to the form step with the preset pre-populated. After the dialog opens, `clear()` is called.

### `usePulsePresets` Promotion

Move file from `features/onboarding/model/` to `entities/pulse/model/`:

```typescript
// entities/pulse/model/use-pulse-presets.ts
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/contexts/TransportContext';
import type { PulsePreset } from '@dorkos/shared/types';

/** Fetches available Pulse schedule presets from the server. */
export function usePulsePresets() {
  const transport = useTransport();
  return useQuery<PulsePreset[]>({
    queryKey: ['pulse', 'presets'],
    queryFn: () => transport.getPulsePresets(),
  });
}
```

Add to `entities/pulse/index.ts`:

```typescript
export { usePulsePresets } from './model/use-pulse-presets';
export { usePulsePresetDialog } from './model/use-pulse-preset-dialog';
```

### `PresetCard` Promotion

Move `PresetCard` from `features/onboarding/ui/PresetCard.tsx` to `features/pulse/ui/PresetCard.tsx`. The component is unchanged — it retains the toggle switch for use in onboarding and accepts a new `selectable` variant for the dialog picker.

```typescript
// features/pulse/ui/PresetCard.tsx

interface PresetCardProps {
  /** The preset to display */
  preset: PulsePreset;
  /** Interaction variant: toggle switch (onboarding) or click-to-select (dialog) */
  variant: 'toggle' | 'selectable';
  /** For variant='toggle': controlled checked state */
  checked?: boolean;
  /** For variant='toggle': called on toggle change */
  onCheckedChange?: (checked: boolean) => void;
  /** For variant='selectable': called when card is clicked */
  onSelect?: (preset: PulsePreset) => void;
  /** For variant='selectable': whether this card is currently selected */
  selected?: boolean;
}
```

**Toggle variant** (used in onboarding): renders the existing UI — toggle switch, spotlight effect, name, description, cron, prompt snippet.

**Selectable variant** (used in dialog): renders a clickable card with a visible selection ring when `selected=true`. No toggle. Spotlight effect still applies on hover. Clicking calls `onSelect(preset)`.

Update `PulsePresetsStep.tsx` import:

```diff
- import { PresetCard } from './PresetCard';
+ import { PresetCard } from '@/layers/features/pulse/ui/PresetCard';
```

Export `PresetCard` from `features/pulse/index.ts`.

### `PresetGallery` Component (New)

```typescript
// features/pulse/ui/PresetGallery.tsx

interface PresetGalleryProps {
  /** Called when user selects a preset. Used in dialog context. */
  onSelect?: (preset: PulsePreset) => void;
  /** Currently selected preset id (for selectable variant) */
  selectedId?: string;
  /** When true, shows a skeleton grid while loading */
  className?: string;
}
```

Renders a responsive 2-column grid of `PresetCard` components in `selectable` variant. Handles loading (skeleton cards) and error states. Uses `usePulsePresets()` internally.

```
┌─────────────────────┐  ┌─────────────────────┐
│ Health Check        │  │ Dependency Audit     │
│ Mon–Fri, 8 AM       │  │ Mon–Fri, 9 AM        │
└─────────────────────┘  └─────────────────────┘
┌─────────────────────┐  ┌─────────────────────┐
│ Docs Sync           │  │ Code Review          │
│ Daily, 10 AM        │  │ Fridays, 8 AM        │
└─────────────────────┘  └─────────────────────┘
```

### `CreateScheduleDialog` Two-Step Flow

Add step state and preset state to the dialog:

```typescript
type DialogStep = 'preset-picker' | 'form';

const [step, setStep] = useState<DialogStep>('preset-picker');
const [appliedPreset, setAppliedPreset] = useState<PulsePreset | null>(null);
```

Also consume `usePulsePresetDialog` to handle external triggers:

```typescript
const { pendingPreset, externalTrigger, clear } = usePulsePresetDialog();

// When externally triggered (e.g., from SchedulesView sidebar)
useEffect(() => {
  if (externalTrigger && pendingPreset) {
    setAppliedPreset(pendingPreset);
    setStep('form');
    clear();
  }
}, [externalTrigger, pendingPreset, clear]);
```

**Step 1 — Preset picker:**

```
┌─────────────────────────────────────────┐
│  New Schedule                           │
│  ─────────────────────────────────────  │
│  Start from a template                  │
│                                         │
│  ┌───────────────┐  ┌───────────────┐  │
│  │ Health Check  │  │ Dep. Audit    │  │
│  │ Mon 8am       │  │ Mon 9am       │  │
│  └───────────────┘  └───────────────┘  │
│  ┌───────────────┐  ┌───────────────┐  │
│  │ Docs Sync     │  │ Code Review   │  │
│  │ Daily 10am    │  │ Fri 8am       │  │
│  └───────────────┘  └───────────────┘  │
│                                         │
│  [ Start from scratch ]                 │
└─────────────────────────────────────────┘
```

- Renders `<PresetGallery onSelect={handleSelectPreset} />`
- "Start from scratch" button: `setAppliedPreset(null); setStep('form')`
- Selecting a preset: `setAppliedPreset(preset); setStep('form')`

**Step 2 — Form:**

```
┌─────────────────────────────────────────┐
│  ← Back   New Schedule                  │
│  ─────────────────────────────────────  │
│  Name: Health Check                     │
│  Prompt: [pre-filled, editable]         │
│  Schedule: 0 8 * * 1  (pre-filled)      │
│  ...                                    │
│           [ Cancel ]  [ Create ]        │
└─────────────────────────────────────────┘
```

- "← Back" button: `setStep('preset-picker')`
- Form `defaultValues` derived from `appliedPreset`:

```typescript
const defaultValues = appliedPreset
  ? {
      name: appliedPreset.name,
      prompt: appliedPreset.prompt,
      cron: appliedPreset.cron,
      timezone: appliedPreset.timezone ?? '',
      // other fields remain at their normal defaults
    }
  : {
      name: '',
      prompt: '',
      cron: '',
      timezone: '',
    };
```

- If dialog is opened in edit mode (existing schedule), skip to `'form'` step directly (no picker)
- Reset step to `'preset-picker'` when dialog closes

**Dialog open state:** When `PulsePanel` detects `externalTrigger` from the store, it sets `dialogOpen = true`. The dialog is already wired to the store's `pendingPreset`, so it opens directly at form step.

### `PulseEmptyState` Modification

Replace the current decorative ghost cards with functional preset cards:

```
┌─────────────────────────────────────────┐
│  No schedules yet.                      │
│  Automate your workflows with Pulse.    │
│                                         │
│  ┌───────────────┐  ┌───────────────┐  │
│  │ Health Check  │  │ Dep. Audit    │  │
│  │ Mon 8am       │  │ Mon 9am       │  │
│  │ [ Create → ]  │  │ [ Create → ]  │  │
│  └───────────────┘  └───────────────┘  │
│  ┌───────────────┐  ┌───────────────┐  │
│  │ Docs Sync     │  │ Code Review   │  │
│  │ Daily 10am    │  │ Fri 8am       │  │
│  │ [ Create → ]  │  │ [ Create → ]  │  │
│  └───────────────┘  └───────────────┘  │
│                                         │
│  [ New custom schedule ]                │
└─────────────────────────────────────────┘
```

- Clicking a preset card CTA opens `CreateScheduleDialog` at form step with the preset pre-filled
- "New custom schedule" button opens dialog at picker step (step 1)

`PulseEmptyState` accepts an `onCreateWithPreset` callback and `onCreateBlank` callback from `PulsePanel`, which manages the dialog open state.

### `SchedulesView` Empty State Modification

When `schedules.length === 0`, replace the current "No schedules configured" text with 2 compact preset cards:

```
┌─────────────────────────────┐
│ Schedules                   │
│ ─────────────────────────── │
│  No schedules yet.          │
│  Get started:               │
│                             │
│  ┌─────────────────────┐   │
│  │ Health Check        │   │
│  │ Mondays at 8 AM     │   │
│  │ [ + Use preset ]    │   │
│  └─────────────────────┘   │
│  ┌─────────────────────┐   │
│  │ Docs Sync           │   │
│  │ Daily at 10 AM      │   │
│  │ [ + Use preset ]    │   │
│  └─────────────────────┘   │
│                             │
│  [ Open Pulse → ]           │
└─────────────────────────────┘
```

**Implementation:**

- `SchedulesView` imports `usePulsePresets` from `entities/pulse` ✓ (valid FSD layer direction)
- `SchedulesView` imports `usePulsePresetDialog` from `entities/pulse` ✓
- The compact card is rendered inline (no separate component needed — it's just 2 cards with a static layout)
- The 2 presets shown are selected by index: `presets[0]` (Health Check) and `presets[2]` (Docs Sync) — avoids hardcoding IDs, uses first and third factory defaults
- "+ Use preset" handler: `openWithPreset(preset)` → triggers `PulsePanel` to open dialog at form step

**Note:** `SchedulesView` does not directly render `CreateScheduleDialog` — it only fires the store trigger. `PulsePanel` (in the main panel area) handles dialog rendering. If the Pulse panel is not currently open, the user is also navigated there (via the existing "Open Pulse →" link behavior).

---

## User Experience

### Creating a Schedule (Post-Change Flow)

1. User clicks "+ New schedule" in `PulsePanel`
2. `CreateScheduleDialog` opens at **step 1**: preset gallery grid
3. If user picks a preset → advances to step 2 with form pre-filled (all fields editable)
4. If user clicks "Start from scratch" → advances to step 2 with empty form
5. User fills/edits fields → clicks "Create" → schedule created

### Using a Preset from the Sidebar

1. User sees the `SchedulesView` empty state with 2 preset cards
2. Clicks "+ Use preset" on "Health Check"
3. `usePulsePresetDialog.openWithPreset()` fires
4. Main content area navigates to Pulse panel (if not already there)
5. `CreateScheduleDialog` opens at step 2 with Health Check pre-filled
6. User confirms or edits → creates schedule

### Empty State in Main Panel

1. User opens Pulse panel, no schedules exist
2. `PulseEmptyState` shows all 4 preset cards with "Create →" CTAs
3. Clicking a CTA opens `CreateScheduleDialog` at step 2 with that preset pre-filled
4. "New custom schedule" button opens dialog at step 1 (picker)

### Onboarding (Unchanged)

The onboarding `PulsePresetsStep` flow is unchanged. It still shows all presets as toggleable cards (toggle variant of `PresetCard`). Functionally identical to before, just importing from the new location.

---

## Testing Strategy

### Unit Tests

**`PresetCard.tsx`:**

```typescript
// features/pulse/__tests__/PresetCard.test.tsx
describe('PresetCard', () => {
  it('toggle variant: renders toggle switch and calls onCheckedChange', ...)
  it('toggle variant: shows name, description, cron schedule', ...)
  it('selectable variant: calls onSelect when clicked', ...)
  it('selectable variant: shows selection ring when selected=true', ...)
  it('selectable variant: does not render toggle switch', ...)
})
```

**`PresetGallery.tsx`:**

```typescript
describe('PresetGallery', () => {
  it('renders a card for each preset returned by usePulsePresets', ...)
  it('shows skeleton cards while loading', ...)
  it('calls onSelect with the correct preset when a card is clicked', ...)
  it('handles empty preset list gracefully', ...)
})
```

**`usePulsePresetDialog`:**

```typescript
describe('usePulsePresetDialog', () => {
  it('openWithPreset sets pendingPreset and externalTrigger=true', ...)
  it('clear resets pendingPreset and externalTrigger to null/false', ...)
})
```

**`CreateScheduleDialog.tsx`:**

```typescript
describe('CreateScheduleDialog', () => {
  it('opens at preset-picker step by default', ...)
  it('advances to form step when a preset is selected', ...)
  it('pre-populates name, prompt, cron, timezone from selected preset', ...)
  it('advances to empty form when "Start from scratch" is clicked', ...)
  it('returns to picker step when "Back" is clicked', ...)
  it('opens directly at form step in edit mode (existing schedule)', ...)
  it('resets to picker step when dialog closes', ...)
  it('opens at form step when externalTrigger fires with pendingPreset', ...)
})
```

**`SchedulesView.tsx`:**

```typescript
describe('SchedulesView empty state', () => {
  it('shows compact preset cards when schedules list is empty', ...)
  it('calls openWithPreset with correct preset on "+ Use preset" click', ...)
  it('shows schedule list when schedules exist (no preset cards)', ...)
})
```

**`PulseEmptyState.tsx`:**

```typescript
describe('PulseEmptyState', () => {
  it('calls onCreateWithPreset with preset when a CTA is clicked', ...)
  it('calls onCreateBlank when "New custom schedule" is clicked', ...)
  it('renders a card for each available preset', ...)
})
```

### Regression Tests

**Onboarding integration:**

```typescript
describe('PulsePresetsStep regression', () => {
  it('still renders toggle cards for each preset', ...)
  it('still creates schedules for selected presets on confirm', ...)
  it('imports PresetCard from new location without errors', ...)
})
```

### Mocking Strategy

- `usePulsePresets`: Mock via `vi.mock('@/layers/entities/pulse')`, return controlled `PulsePreset[]`
- `useCreateSchedule`: Mock the mutation function
- `usePulsePresetDialog`: Mock via Zustand `create` or provide test wrapper with preset state

---

## Performance Considerations

- `usePulsePresets` is a single GET request cached by TanStack Query under `['pulse', 'presets']`. Presets are fetched once and cached for the session. Loading the dialog, empty state, and sidebar all share this cache — no duplicate requests.
- The `PresetGallery` adds a small initial render cost (4 cards) but is only shown in empty states or step 1 of the dialog — not in the critical rendering path.
- `usePulsePresetDialog` Zustand store is a trivial singleton — no performance impact.

---

## Security Considerations

No new API endpoints. No user-input validated server-side. Preset data is read-only and fetched from the server — no injection risk. The form pre-population populates controlled form fields that are validated before submission (existing validation unchanged).

---

## Documentation

No external documentation changes required. The `CreateScheduleDialog` UI is self-explanatory. Internal dev guide `contributing/architecture.md` should note the `usePulsePresetDialog` pattern as the canonical example of cross-feature FSD coordination via entity-layer stores.

---

## Implementation Phases

### Phase 1 — Infrastructure Promotion

1. Move `usePulsePresets` to `entities/pulse/model/use-pulse-presets.ts`
2. Create `usePulsePresetDialog` store at `entities/pulse/model/use-pulse-preset-dialog.ts`
3. Update `entities/pulse/index.ts` barrel exports
4. Move `PresetCard` to `features/pulse/ui/PresetCard.tsx`, add `variant` prop
5. Update `PulsePresetsStep` and `OnboardingFlow` imports
6. Create `PresetGallery` component at `features/pulse/ui/PresetGallery.tsx`
7. Update `features/pulse/index.ts` barrel exports
8. Verify onboarding regressions: `pnpm vitest run`

### Phase 2 — CreateScheduleDialog Two-Step

1. Add `step` and `appliedPreset` state to `CreateScheduleDialog`
2. Implement step 1 (preset picker) UI
3. Implement step 2 (form with back button) and field pre-population
4. Wire `externalTrigger` handler from `usePulsePresetDialog`
5. Ensure edit-mode dialog skips picker step
6. Reset state on close

### Phase 3 — Empty State Surfaces

1. Retrofit `PulseEmptyState` with functional `PresetGallery` and `onCreateWithPreset` callback
2. Wire `PulsePanel` to handle the empty state callbacks (open dialog with preset or blank)
3. Retrofit `SchedulesView` empty state with 2 compact preset cards
4. Wire `SchedulesView` to call `openWithPreset` from `usePulsePresetDialog`
5. Ensure `PulsePanel` watches `externalTrigger` and opens dialog accordingly

---

## Open Questions

_None — all decisions were resolved during ideation._

---

## Related ADRs

- None directly applicable. This work follows existing patterns established in the FSD architecture (`.claude/rules/fsd-layers.md`).

---

## References

- Ideation document: `specs/pulse-schedule-templates/01-ideation.md`
- FSD layer rules: `.claude/rules/fsd-layers.md`
- Existing preset infrastructure: `apps/server/src/services/pulse/pulse-presets.ts`
- Transport interface: `packages/shared/src/transport.ts`
- Onboarding step (before change): `apps/client/src/layers/features/onboarding/ui/PulsePresetsStep.tsx`
- Research: `research/20260311_pulse_template_gallery_ux.md`
