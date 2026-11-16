---
slug: feature-promo-system
number: 178
created: 2026-03-24
status: specified
---

# Feature Promo System

## Overview

A declarative framework for contextually surfacing feature promos to users based on their current state. Each promo is a typed config object in a central registry. The framework handles condition evaluation, placement, rendering, dismissal, and state persistence. Adding a new promo is: define a config object + (optionally) write a dialog content component.

Three placement slots: dashboard main area, dashboard sidebar, and agent sidebar (in a new Overview tab). Each slot has a `maxUnits` cap. Promos fill slots by priority. Permanent dismissal via manual localStorage persistence (matching the app store's existing pattern). Global off switch in Settings.

## Technical Design

### Type System

All types live in `features/feature-promos/model/promo-types.ts`.

```typescript
import type { LucideIcon } from 'lucide-react';

/** Placement slots where promos can render */
type PromoPlacement = 'dashboard-main' | 'dashboard-sidebar' | 'agent-sidebar';

/** Action types when user clicks the CTA */
type PromoAction =
  | { type: 'dialog'; component: React.ComponentType<PromoDialogProps> }
  | { type: 'navigate'; to: string }
  | { type: 'action'; handler: () => void };

/** Props passed to dialog content components */
interface PromoDialogProps {
  onClose: () => void;
}

/** Content fields — slots pick which subset to render */
interface PromoContent {
  icon: LucideIcon;
  title: string;
  shortDescription: string;
  ctaLabel: string;
}

/** Condition context injected into shouldShow */
interface PromoContext {
  hasAdapter: (name: string) => boolean;
  isPulseEnabled: boolean;
  isMeshEnabled: boolean;
  isRelayEnabled: boolean;
  sessionCount: number;
  agentCount: number;
  daysSinceFirstUse: number;
}

/** Full promo definition */
interface PromoDefinition {
  id: string; // unique, kebab-case
  placements: PromoPlacement[]; // where this promo can appear
  priority: number; // higher = shown first (0-100)
  shouldShow: (ctx: PromoContext) => boolean;
  content: PromoContent;
  action: PromoAction;
}
```

Design rationale:

- `PromoContext` is a curated object, not raw store access — keeps `shouldShow` pure and testable
- `PromoAction` is a discriminated union — TypeScript enforces valid action shapes
- `PromoContent` is flat — no markdown or rich content in the card itself; rich content lives in dialog components
- `PromoDialogProps` is minimal — just `onClose`. Dialog components can import from entities/shared for additional data per FSD rules
- Priority range 0-100 gives room for ordering without reordering everything when adding promos

### Module Structure

```
layers/features/feature-promos/
├── model/
│   ├── promo-types.ts              # All types (PromoDefinition, PromoContext, etc.)
│   ├── promo-registry.ts           # PROMO_REGISTRY array — all promo definitions
│   ├── promo-context.ts            # usePromoContext() — assembles PromoContext
│   ├── use-promo-slot.ts           # usePromoSlot(placement, maxUnits) — main consumer hook
│   └── use-promo-state.ts          # Zustand slice — dismissal + global toggle
├── ui/
│   ├── PromoSlot.tsx               # Renders N promo cards for a given placement
│   ├── PromoCard.tsx               # Individual promo unit (slot-driven format)
│   ├── PromoDialog.tsx             # ResponsiveDialog shell for action.component
│   └── dialogs/                    # Dialog content components
│       ├── RemoteAccessDialog.tsx
│       ├── RelayAdaptersDialog.tsx
│       ├── SchedulesDialog.tsx
│       └── AgentChatDialog.tsx
├── __tests__/
│   ├── promo-registry.test.ts      # Registry validation
│   ├── use-promo-slot.test.ts      # Filtering, sorting, capping logic
│   ├── use-promo-state.test.ts     # Dismissal persistence
│   ├── PromoCard.test.tsx          # Component rendering
│   └── PromoSlot.test.tsx          # Slot rendering + zero DOM
└── index.ts                        # Barrel exports
```

The barrel exports: `PromoSlot`, `usePromoSlot`, all types, and `PROMO_REGISTRY` (for dev playground).

### Hooks

**`usePromoState`** — Fields added to the existing app store (`shared/model/app-store.ts`):

```typescript
// New state fields
dismissedPromoIds: string[];   // default: []
promoEnabled: boolean;         // default: true

// New actions
dismissPromo: (id: string) => void;
setPromoEnabled: (enabled: boolean) => void;
```

Persistence follows the app store's existing manual localStorage pattern:

- `promoEnabled` uses the `readBool`/`writeBool` helpers (add `'promoEnabled'` to the boolean keys)
- `dismissedPromoIds` uses `localStorage.getItem`/`setItem` with `JSON.parse`/`JSON.stringify` (same pattern as other non-boolean state in the store)
- `dismissPromo` checks for duplicates before appending (idempotent)
- `resetPreferences` resets both fields to defaults

The app store does NOT use Zustand's `persist` middleware — all persistence is manual.

**`usePromoContext`** — Assembles the condition context from entity/shared hooks:

```typescript
function usePromoContext(): PromoContext {
  // Existing hooks
  const isPulseEnabled = usePulseEnabled(); // from entities/pulse (exists)
  const isRelayEnabled = useRelayEnabled(); // from entities/relay (exists)
  const { sessions } = useSessions(); // from entities/session (exists)
  const agents = useAgents(); // from entities/agent (exists, returns agent list)

  // New hooks to create
  const adapters = useAdapterStatus(); // NEW — wrapper around relay adapter state
  const isMeshEnabled = useMeshEnabled(); // NEW — derive from mesh connection state
  const firstUseDate = useFirstUseDate(); // NEW — store in localStorage on first app load

  return useMemo(
    () => ({
      hasAdapter: (name) => adapters.some((a) => a.type === name && a.connected),
      isPulseEnabled,
      isMeshEnabled,
      isRelayEnabled,
      sessionCount: sessions.length,
      agentCount: agents.length,
      daysSinceFirstUse: daysSince(firstUseDate),
    }),
    [
      adapters,
      isPulseEnabled,
      isMeshEnabled,
      isRelayEnabled,
      sessions.length,
      agents.length,
      firstUseDate,
    ]
  );
}
```

All imports are from entities or shared — no cross-feature imports. The context is memoized so `shouldShow` functions don't re-evaluate on unrelated renders. Extending the context is: add a field to `PromoContext`, wire up the hook source.

**Hook inventory** (existing vs. new):

| Hook                 | Status  | Source                                                                                                           |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `usePulseEnabled()`  | Exists  | `entities/pulse`                                                                                                 |
| `useRelayEnabled()`  | Exists  | `entities/relay`                                                                                                 |
| `useSessions()`      | Exists  | `entities/session` — use `sessions.length` for count                                                             |
| `useAgents()`        | Exists  | `entities/agent` — use `.length` for count                                                                       |
| `useAdapterStatus()` | **New** | Create in `features/feature-promos/model/` — reads relay adapter connection state from server via TanStack Query |
| `useMeshEnabled()`   | **New** | Create in `features/feature-promos/model/` — derive from mesh connection state (no server feature flag for mesh) |
| `useFirstUseDate()`  | **New** | Create in `features/feature-promos/model/` — read/write a `firstUseDate` key in localStorage on first app load   |

Implementation should verify hook signatures against current codebase — the entity hooks listed as "exists" should be confirmed during implementation.

**`usePromoSlot`** — The main consumer hook:

```typescript
function usePromoSlot(placement: PromoPlacement, maxUnits: number): PromoDefinition[] {
  const ctx = usePromoContext();
  const { dismissedPromoIds, promoEnabled } = usePromoState();

  return useMemo(() => {
    if (!promoEnabled) return [];

    return PROMO_REGISTRY.filter((p) => p.placements.includes(placement))
      .filter((p) => !dismissedPromoIds.includes(p.id))
      .filter((p) => p.shouldShow(ctx))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, maxUnits);
  }, [placement, maxUnits, ctx, dismissedPromoIds, promoEnabled]);
}
```

Pipeline: filter by placement → exclude dismissed → evaluate conditions → sort by priority descending → cap at maxUnits. Returns empty array when global toggle is off or no promos qualify.

### UI Components

**`PromoSlot`** — The only component other modules interact with:

```tsx
interface PromoSlotProps {
  placement: PromoPlacement;
  maxUnits: number;
}
```

Internally calls `usePromoSlot`, wraps results in `AnimatePresence` for enter/exit animations. Renders zero DOM when no promos qualify (same pattern as `NeedsAttentionSection`). Root element has `data-slot="promo-slot"`.

Layout varies by placement:

- `dashboard-main`: Section header ("DISCOVER" in `text-xs font-medium tracking-widest uppercase text-muted-foreground`) + responsive grid (1 col mobile, 2 col desktop, `gap-3`)
- `dashboard-sidebar` and `agent-sidebar`: Vertical stack with `space-y-2`, no section header

Uses `motion.section` with the `sectionEntrance` animation variant and `staggerContainer` for child staggering (40ms intervals), matching existing dashboard section patterns.

**`PromoCard`** — Two visual formats, dictated by the slot:

_Standard format_ (dashboard-main):

- Vertical card: `rounded-xl border border-border bg-card p-6`, `data-slot="promo-card"`
- Icon (36px, rounded-md, subtle gradient background) → title (`text-sm font-medium`) → short description (`text-sm text-muted-foreground`, 1-2 lines) → CTA link (`text-xs font-medium text-muted-foreground` with arrow)
- Dismiss X button: `<button>` with `aria-label="Dismiss suggestion"`, absolute positioned `top-3 right-3`, `text-muted-foreground` with hover, calls `dismissPromo(id)`
- Entire card is a `<button>` element with `role="button"` (triggers the action), or an `<a>` for `type: 'navigate'`
- Uses `motion.div` with `staggerItem` variant for staggered entrance

_Compact format_ (dashboard-sidebar, agent-sidebar):

- Horizontal row: `rounded-lg border border-border bg-card px-3 py-2.5`, `data-slot="promo-card-compact"`
- Icon (32px) + title (`text-xs font-medium`) + short description (`text-2xs text-muted-foreground`) + arrow indicator
- No dismiss button in compact format — compact cards are dismissed from the standard format in dashboard-main, or via the Settings toggle. Keeping compact clean avoids cramming controls into a small row.
- Entire row is a `<button>` element (triggers the action)

**`PromoDialog`** — Thin wrapper around `ResponsiveDialog`:

```tsx
interface PromoDialogShellProps {
  promo: PromoDefinition; // the promo whose dialog to show
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

Note: `PromoDialogShellProps` is the outer wrapper's props. The inner dialog content components receive `PromoDialogProps` (just `{ onClose }`). The two interfaces have different shapes — the naming distinction prevents confusion.

Renders the promo's `action.component` inside `ResponsiveDialogBody`. Dialog on desktop (with fullscreen toggle), Drawer on mobile. The dialog content component receives `{ onClose }` as props and has full creative freedom inside the shell.

**Dialog content components** (e.g., `RemoteAccessDialog.tsx`):

Regular React components receiving `PromoDialogProps` (`{ onClose }`). Can import from entities/shared per FSD rules. Each dialog contains benefit-first copy, feature explanation, visual elements as appropriate, and CTAs (primary action button + secondary "Learn more" or dismiss). No enforced template — each dialog can be as simple or rich as the feature demands.

### Integration Points

**1. DashboardPage.tsx** — One line after NeedsAttentionSection:

```tsx
import { PromoSlot } from '@/layers/features/feature-promos';

// Inside the section stack, after NeedsAttentionSection:
<PromoSlot placement="dashboard-main" maxUnits={4} />;
```

**2. SessionSidebar.tsx** — New Overview tab as default (tab 1):

Add a fourth tab at position 0. Existing tabs shift: Overview (Cmd+1), Sessions (Cmd+2), Schedules (Cmd+3), Connections (Cmd+4).

The Overview tab panel contains:

- Agent context section (top) — if an agent is selected, shows name, status, key stats. If no agent context, shows a general welcome/summary.
- `<PromoSlot placement="agent-sidebar" maxUnits={3} />` — below agent context
- Quick action links (bottom) — contextual actions like "New session", "View schedules"

**Files requiring changes for the Overview tab:**

| File                                                      | Change                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/model/app-store.ts`                               | Add `'overview'` to the `sidebarActiveTab` union type (`'sessions' \| 'schedules' \| 'connections'` → `'overview' \| 'sessions' \| 'schedules' \| 'connections'`). Update localStorage deserialization guard (lines ~237-243) to handle the new value. Update `resetPreferences` to default to `'overview'`. |
| `features/session-list/ui/SessionSidebar.tsx`             | Add Overview tab panel. Update `visibleTabs` construction (~line 100) to include the Overview entry. Update keyboard shortcut `tabMap` object (~lines 120-136) to map Cmd+1→overview, Cmd+2→sessions, etc.                                                                                                   |
| `features/session-list/ui/SidebarTabRow.tsx`              | Add fourth entry to `TAB_CONFIG` array with icon (`LayoutGrid` or `Home`), label "Overview", and shortcut "1".                                                                                                                                                                                               |
| `features/session-list/__tests__/SessionSidebar.test.tsx` | Update tests for new tab count, default tab, keyboard shortcut mappings.                                                                                                                                                                                                                                     |

**3. DashboardSidebar.tsx** — PromoSlot below Recent Agents:

```tsx
import { PromoSlot } from '@/layers/features/feature-promos';

// Below the "Recent Agents" SidebarGroup:
<PromoSlot placement="dashboard-sidebar" maxUnits={3} />;
```

**4. SettingsDialog.tsx** — Toggle in Preferences tab:

```tsx
<SettingRow
  label="Feature suggestions"
  description="Show feature discovery cards on the dashboard and sidebar"
>
  <Switch checked={promoEnabled} onCheckedChange={setPromoEnabled} />
</SettingRow>
```

Added to the Preferences panel, grouped with other display preferences.

**5. App store (Zustand)** — Extend with promo fields:

Add `dismissedPromoIds: string[]` (default: `[]`) and `promoEnabled: boolean` (default: `true`) plus their actions to the existing app store. Persistence uses the store's manual localStorage pattern (see Hooks section above). Add `promoEnabled` to the boolean keys for `readBool`/`writeBool`, and `dismissedPromoIds` as a JSON-serialized localStorage key.

### Initial Promo Registry

Four promos ship with the framework:

**1. Remote Access** (`remote-access`) — Priority 90

- Placements: `dashboard-main`, `dashboard-sidebar`
- Condition: `() => true` (always show — no server-side dependency)
- Icon: `Globe`
- Title: "Use DorkOS on the go"
- Short description: "Access your agents from anywhere"
- CTA: "Learn more"
- Action: `{ type: 'dialog', component: RemoteAccessDialog }`

**2. Relay Adapters** (`relay-adapters`) — Priority 80

- Placements: `dashboard-main`, `agent-sidebar`, `dashboard-sidebar`
- Condition: `(ctx) => ctx.isRelayEnabled && !ctx.hasAdapter('slack') && !ctx.hasAdapter('telegram')`
- Icon: `MessageSquare`
- Title: "Connect to Slack & Telegram"
- Short description: "Get notifications where you already are"
- CTA: "Learn more"
- Action: `{ type: 'dialog', component: RelayAdaptersDialog }`

**3. Schedules** (`schedules`) — Priority 70

- Placements: `dashboard-main`, `agent-sidebar`, `dashboard-sidebar`
- Condition: `(ctx) => ctx.isPulseEnabled && ctx.sessionCount > 0`
- Icon: `Moon`
- Title: "Run agents while you sleep"
- Short description: "Set schedules and wake up to results"
- CTA: "Set up"
- Action: `{ type: 'dialog', component: SchedulesDialog }`

**4. Agent-to-Agent Chat** (`agent-chat`) — Priority 60

- Placements: `dashboard-main`, `agent-sidebar`
- Condition: `(ctx) => ctx.isMeshEnabled && ctx.agentCount >= 2`
- Icon: `MessagesSquare`
- Title: "Agent-to-agent conversations"
- Short description: "Let your agents collaborate"
- CTA: "Learn more"
- Action: `{ type: 'dialog', component: AgentChatDialog }`

Priority ordering rationale: Remote Access (90) drives daily engagement. Relay (80) drives retention through notifications. Schedules (70) unlocks autonomous operation. Agent Chat (60) is advanced/power-user territory.

### Dev Playground

New showcase section on the Features page of the dev playground.

**Files:**

- `apps/client/src/dev/showcases/PromoShowcases.tsx` — showcase component
- `apps/client/src/dev/sections/features-sections.ts` — add section entry with id `feature-promos`, keywords `['promo', 'promotion', 'feature', 'education', 'discovery']`

**Showcase sections:**

1. **Registry Table** — All registered promos in a table: id, title, placements (badges), priority, live `shouldShow` result (green/red dot), dismiss state.

2. **Slot Previews** — Three live PromoSlot renders side by side: dashboard-main (2-col grid), dashboard-sidebar (compact stack), agent-sidebar (compact stack). Shows exactly what users see with current state.

3. **Override Controls**:
   - "Reset all dismissals" button — clears `dismissedPromoIds`
   - "Toggle global setting" — flips `promoEnabled`
   - Per-promo "Force show" toggle — bypasses `shouldShow` for visual testing
   - Mock context overrides — checkboxes/inputs to pretend adapters are connected, change session count, etc.

4. **Dialog Previews** — Button per dialog-type promo to open its dialog content directly. Tests the dialog component without needing to navigate to a placement slot.

### Animation

All animations follow existing dashboard section patterns:

- **Section enter/exit**: `AnimatePresence` wrapping the PromoSlot. Section uses `motion.section` with locally-defined `sectionEntrance` variant (fade + y-slide, 200ms duration). Note: these variants are currently copy-pasted per dashboard section file — follow the same local definition pattern for consistency.
- **Card stagger**: Locally-defined `staggerContainer` variant on the grid/stack, `staggerItem` on each PromoCard (opacity: 0, y: 12 → opacity: 1, y: 0, staggerChildren: 0.04).
- **Card dismiss**: `motion.div` with `exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}`. Remaining cards reflow with layout animation. Exit animation suppressed under `useReducedMotion()`.
- **Dialog open/close**: Handled by ResponsiveDialog's built-in animation (no custom work needed).
- All animations respect `useReducedMotion()` — both section entrance and card dismiss.

## Testing

### Registry Validation (`promo-registry.test.ts`)

- All promo IDs are unique
- All promo IDs are kebab-case (regex: `/^[a-z0-9]+(-[a-z0-9]+)*$/`)
- All placements are valid `PromoPlacement` values
- All priorities are within 0-100 range
- All `type: 'dialog'` actions have a component defined
- All `type: 'navigate'` actions have a non-empty `to` string
- No orphaned dialog component files in `dialogs/` (every file is referenced by a registry entry)

### Hook Logic (`use-promo-slot.test.ts`)

- Filters promos by placement correctly (only dashboard-main promos in dashboard-main slot)
- Excludes dismissed promos from results
- Evaluates `shouldShow` with mock context (returns promo when true, excludes when false)
- Sorts by priority descending (highest first)
- Caps at maxUnits (returns exactly N when more qualify)
- Returns empty array when `promoEnabled` is false
- Re-evaluates when context changes (adapter connected → promo disappears from results)
- Returns empty array when no promos qualify for a placement

### Dismissal State (`use-promo-state.test.ts`)

- `dismissPromo` adds ID to `dismissedPromoIds`
- `dismissPromo` is idempotent (dismissing twice doesn't duplicate)
- `setPromoEnabled` toggles the global flag
- State persists across hook re-renders (via manual localStorage)

### Component Tests

**`PromoCard.test.tsx`:**

- Renders title, short description, icon, CTA label
- Standard format shows dismiss X button
- Compact format does not show dismiss X button
- Clicking dismiss calls `dismissPromo` with correct ID
- Clicking card with `type: 'dialog'` action opens PromoDialog
- Clicking card with `type: 'navigate'` action calls router navigation

**`PromoSlot.test.tsx`:**

- Renders zero DOM when no promos qualify (`promoEnabled: false`, all dismissed, none match placement)
- Renders correct number of PromoCard children up to maxUnits
- Renders section header for dashboard-main placement
- Does not render section header for sidebar placements
- Cards animate in with stagger (verify motion props or snapshot)

## How to Add a New Promo

1. Open `features/feature-promos/model/promo-registry.ts`
2. Add a new entry to `PROMO_REGISTRY`:
   ```typescript
   {
     id: 'my-new-feature',
     placements: ['dashboard-main', 'agent-sidebar'],
     priority: 75,
     shouldShow: (ctx) => ctx.sessionCount > 3,
     content: {
       icon: Sparkles,
       title: 'Try the new thing',
       shortDescription: 'It makes everything better',
       ctaLabel: 'Learn more',
     },
     action: { type: 'dialog', component: MyNewFeatureDialog },
   }
   ```
3. If action is `type: 'dialog'`, create `ui/dialogs/MyNewFeatureDialog.tsx`:
   ```typescript
   export function MyNewFeatureDialog({ onClose }: PromoDialogProps) {
     return (
       <div className="space-y-4">
         <h3>...</h3>
         <p>...</p>
         <Button onClick={onClose}>Got it</Button>
       </div>
     )
   }
   ```
4. Run `pnpm vitest run` on `promo-registry.test.ts` — this validates unique IDs, valid placements, priority range, and catches orphaned dialog files
5. Check the dev playground to preview all formats and the dialog content
