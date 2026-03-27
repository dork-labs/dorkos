---
slug: ext-platform-02-extension-registry
number: 182
created: 2026-03-26
status: specified
project: extensibility-platform
phase: 2
---

# Extension Point Registry

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-03-26
**Ideation:** `specs/ext-platform-02-extension-registry/01-ideation.md`
**Brief:** `specs/ext-platform-02-extension-registry/00-brief.md`

---

## Overview

Create a typed, queryable extension point registry — a Zustand store that replaces hardcoded arrays and static component lists throughout the client with a single registration API. Built-in features register at app startup via the same API that third-party extensions will use in Phase 3. This is a pure refactor: zero user-visible behavior changes.

The registry maps **slot IDs** (string constants identifying UI surfaces that accept contributions) to arrays of **contributions** (typed objects describing what to render or offer at that surface). Components query the registry via a `useSlotContributions(slotId)` hook and render contributions alongside — or instead of — their previous hardcoded content.

## Background / Problem Statement

Extension points in the DorkOS client are currently implicit. Features are wired through:

- **Static arrays** — `FEATURES[]` and `QUICK_ACTIONS[]` in `use-palette-items.ts` define command palette entries as constants
- **Hardcoded dialog lists** — `DialogHost.tsx` renders 6 dialogs via explicit imports and per-dialog boolean state
- **Hardcoded button lists** — `SidebarFooterBar.tsx` renders 4 icon buttons with inline click handlers
- **Computed tab arrays** — `use-sidebar-tabs.ts` builds a `SidebarTab[]` array with feature-flag conditionals
- **Fixed section composition** — `DashboardPage.tsx` composes 5 sections in a fixed order

There is no dynamic way to add contributions to these surfaces. This blocks the extensibility platform (Phases 3-4) and makes it impossible to build features that register themselves without modifying host components.

## Goals

- Create a single, typed registry store that all extensible UI surfaces query
- Migrate all existing hardcoded UI registrations to use the registry API
- Prove the registry pattern works end-to-end with built-in features before extensions add complexity
- Provide a `useSlotContributions(slotId)` hook for reactive, priority-sorted contribution queries
- Return unsubscribe functions from every `register()` call for future extension lifecycle management
- Maintain 100% behavioral parity — no user-visible changes

## Non-Goals

- Third-party extension loading, manifest parsing, or sandboxing (Phase 3)
- Agent-built extensions or AI-generated UI (Phase 4)
- Server-side extension registry or API
- New extension points not already present in the codebase
- Changes to `app-store.ts` dialog state fields — dialogs continue using `settingsOpen`, `pulseOpen`, etc.
- Runtime extension hot-loading or deactivation UI

## Technical Dependencies

| Dependency     | Version   | Purpose                                                  |
| -------------- | --------- | -------------------------------------------------------- |
| `zustand`      | `^5.0.0`  | Registry store (matches existing `app-store.ts` pattern) |
| `react`        | `^19.0.0` | `useSyncExternalStore` under the hood via Zustand        |
| `lucide-react` | existing  | Icon types for contribution interfaces                   |
| `vitest`       | existing  | Registry store unit tests                                |

No new dependencies required.

## Detailed Design

### 1. Registry Store (`layers/shared/model/extension-registry.ts`)

#### Slot ID Constants

```typescript
export const SLOT_IDS = {
  SIDEBAR_FOOTER: 'sidebar.footer',
  SIDEBAR_TABS: 'sidebar.tabs',
  DASHBOARD_SECTIONS: 'dashboard.sections',
  HEADER_ACTIONS: 'header.actions',
  COMMAND_PALETTE_ITEMS: 'command-palette.items',
  DIALOG: 'dialog',
  SETTINGS_TABS: 'settings.tabs',
  SESSION_CANVAS: 'session.canvas',
} as const;

export type SlotId = (typeof SLOT_IDS)[keyof typeof SLOT_IDS];
```

#### Contribution Type Interfaces

Each slot has a specific contribution shape. A base interface provides `id` and `priority`:

```typescript
/** Base interface for all contributions. */
interface BaseContribution {
  /** Unique identifier within the slot. */
  id: string;
  /** Sort priority. Lower = higher priority. Default: 50. */
  priority?: number;
}
```

Per-slot contribution interfaces:

```typescript
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

export interface SidebarFooterContribution extends BaseContribution {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  /** Only show when `import.meta.env.DEV` is true. */
  showInDevOnly?: boolean;
}

export interface SidebarTabContribution extends BaseContribution {
  icon: LucideIcon;
  label: string;
  component: ComponentType;
  /** Return false to hide this tab. Evaluated reactively. */
  visibleWhen?: () => boolean;
  /** Keyboard shortcut label (e.g., "⌘1"). */
  shortcut?: string;
}

export interface DashboardSectionContribution extends BaseContribution {
  component: ComponentType;
  title?: string;
  /** Return false to hide this section. Evaluated reactively. */
  visibleWhen?: () => boolean;
}

export interface HeaderActionContribution extends BaseContribution {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'ghost' | 'outline';
}

export interface CommandPaletteContribution extends BaseContribution {
  label: string;
  /** Lucide icon name (string, not component). */
  icon: string;
  /** Action identifier dispatched via `usePaletteActions`. */
  action: string;
  shortcut?: string;
  category: 'feature' | 'quick-action';
}

export interface DialogContribution extends BaseContribution {
  /** Dialog component accepting `open` and `onOpenChange` props. */
  component: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  /** Key in `useAppStore()` that controls open state (e.g., 'settingsOpen'). */
  openStateKey: string;
}

export interface SettingsTabContribution extends BaseContribution {
  label: string;
  icon: LucideIcon;
  component: ComponentType;
}

export interface SessionCanvasContribution extends BaseContribution {
  component: ComponentType;
  /** MIME-like content type this renderer handles. */
  contentType: string;
}
```

#### SlotContributionMap Interface

The central type that maps slot IDs to their contribution types. Declared as an `interface` (not `type`) to support `declare module` augmentation in Phase 3:

```typescript
export interface SlotContributionMap {
  'sidebar.footer': SidebarFooterContribution;
  'sidebar.tabs': SidebarTabContribution;
  'dashboard.sections': DashboardSectionContribution;
  'header.actions': HeaderActionContribution;
  'command-palette.items': CommandPaletteContribution;
  dialog: DialogContribution;
  'settings.tabs': SettingsTabContribution;
  'session.canvas': SessionCanvasContribution;
}
```

#### Store Implementation

```typescript
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface ExtensionRegistryState {
  /** Internal storage: slot ID → array of contributions. */
  slots: { [K in SlotId]: SlotContributionMap[K][] };

  /** Register a contribution to a slot. Returns an unsubscribe function. */
  register: <K extends SlotId>(slotId: K, contribution: SlotContributionMap[K]) => () => void;

  /** Get raw (unsorted) contributions for a slot. */
  getContributions: <K extends SlotId>(slotId: K) => SlotContributionMap[K][];
}

/** Initial state factory — every slot starts empty. */
function createInitialSlots(): ExtensionRegistryState['slots'] {
  return Object.values(SLOT_IDS).reduce(
    (acc, id) => ({ ...acc, [id]: [] }),
    {} as ExtensionRegistryState['slots']
  );
}

export const useExtensionRegistry = create<ExtensionRegistryState>()(
  devtools(
    (set, get) => ({
      slots: createInitialSlots(),

      register: (slotId, contribution) => {
        const withDefaults = { priority: 50, ...contribution };

        set(
          (state) => ({
            slots: {
              ...state.slots,
              [slotId]: [...state.slots[slotId], withDefaults],
            },
          }),
          undefined,
          `register/${slotId}/${contribution.id}`
        );

        // Return unsubscribe function
        return () => {
          set(
            (state) => ({
              slots: {
                ...state.slots,
                [slotId]: state.slots[slotId].filter((c) => c.id !== contribution.id),
              },
            }),
            undefined,
            `unregister/${slotId}/${contribution.id}`
          );
        };
      },

      getContributions: (slotId) => get().slots[slotId],
    }),
    { name: 'extension-registry' }
  )
);
```

#### useSlotContributions Hook

A convenience hook that subscribes to a slot and returns priority-sorted contributions:

```typescript
/**
 * Subscribe to a slot and return its contributions sorted by priority.
 * Lower priority number = appears first. Stable sort preserves insertion order for ties.
 */
export function useSlotContributions<K extends SlotId>(slotId: K): SlotContributionMap[K][] {
  const contributions = useExtensionRegistry((state) => state.slots[slotId]);

  return useMemo(
    () => [...contributions].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50)),
    [contributions]
  );
}
```

### 2. Initialization (`apps/client/src/app/init-extensions.ts`)

Called synchronously from `main.tsx` before `createRoot().render()`. The app layer is the only FSD layer that can import from all other layers, making it the correct place to wire features to the registry.

```typescript
import { useExtensionRegistry } from '@/layers/shared/model';
// Feature contribution data imports from barrels
import { PALETTE_FEATURES, PALETTE_QUICK_ACTIONS } from '@/layers/features/command-palette';
import { DIALOG_CONTRIBUTIONS } from '@/layers/features/command-palette'; // or wherever dialogs export from
import { SIDEBAR_FOOTER_BUTTONS } from '@/layers/features/session-list';
import { SIDEBAR_TAB_CONTRIBUTIONS } from '@/layers/features/session-list';
import { DASHBOARD_SECTION_CONTRIBUTIONS } from '@/layers/widgets/dashboard';
// ... etc.

/**
 * Register all built-in features into the extension registry.
 * Called once at app startup, before React renders.
 */
export function initializeExtensions(): void {
  const { register } = useExtensionRegistry.getState();

  // Command palette items (priority 1-10 for built-ins)
  for (const feature of PALETTE_FEATURES) {
    register('command-palette.items', feature);
  }
  for (const action of PALETTE_QUICK_ACTIONS) {
    register('command-palette.items', action);
  }

  // Dialogs
  for (const dialog of DIALOG_CONTRIBUTIONS) {
    register('dialog', dialog);
  }

  // Sidebar footer buttons
  for (const button of SIDEBAR_FOOTER_BUTTONS) {
    register('sidebar.footer', button);
  }

  // Sidebar tabs
  for (const tab of SIDEBAR_TAB_CONTRIBUTIONS) {
    register('sidebar.tabs', tab);
  }

  // Dashboard sections
  for (const section of DASHBOARD_SECTION_CONTRIBUTIONS) {
    register('dashboard.sections', section);
  }
}
```

**Integration in `main.tsx`:**

```typescript
import { initializeExtensions } from './app/init-extensions';

// Call BEFORE createRoot().render()
initializeExtensions();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
```

### 3. Migration Details

Each migration converts a hardcoded list into exported contribution data + a registry query. The transformation is mechanical and preserves exact behavior.

#### 3.1 Command Palette Items

**Current:** `FEATURES[]` and `QUICK_ACTIONS[]` are `const` arrays in `use-palette-items.ts`.

**After:** Export contribution arrays from the feature barrel. The hook queries the registry.

```typescript
// features/command-palette/model/palette-contributions.ts (NEW)
import type { CommandPaletteContribution } from '@/layers/shared/model';

export const PALETTE_FEATURES: CommandPaletteContribution[] = [
  {
    id: 'pulse',
    label: 'Pulse Scheduler',
    icon: 'Clock',
    action: 'openPulse',
    category: 'feature',
    priority: 1,
  },
  {
    id: 'relay',
    label: 'Relay Messaging',
    icon: 'Radio',
    action: 'openRelay',
    category: 'feature',
    priority: 2,
  },
  {
    id: 'mesh',
    label: 'Mesh Network',
    icon: 'Globe',
    action: 'openMesh',
    category: 'feature',
    priority: 3,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'Settings',
    action: 'openSettings',
    category: 'feature',
    priority: 4,
  },
];

export const PALETTE_QUICK_ACTIONS: CommandPaletteContribution[] = [
  {
    id: 'dashboard',
    label: 'Go to Dashboard',
    icon: 'Home',
    action: 'navigateDashboard',
    category: 'quick-action',
    priority: 1,
  },
  {
    id: 'new-session',
    label: 'New Session',
    icon: 'Plus',
    action: 'newSession',
    category: 'quick-action',
    priority: 2,
  },
  {
    id: 'create-agent',
    label: 'Create Agent',
    icon: 'Plus',
    action: 'createAgent',
    category: 'quick-action',
    priority: 3,
  },
  {
    id: 'discover',
    label: 'Discover Agents',
    icon: 'Search',
    action: 'discoverAgents',
    category: 'quick-action',
    priority: 4,
  },
  {
    id: 'browse',
    label: 'Browse Filesystem',
    icon: 'FolderOpen',
    action: 'browseFilesystem',
    category: 'quick-action',
    priority: 5,
  },
  {
    id: 'theme',
    label: 'Toggle Theme',
    icon: 'Moon',
    action: 'toggleTheme',
    category: 'quick-action',
    priority: 6,
  },
];
```

**Modified `usePaletteItems()`:** Replace static array references with registry queries:

```typescript
export function usePaletteItems(activeCwd: string | null): PaletteItems {
  const allPaletteItems = useSlotContributions('command-palette.items');

  const features = useMemo(
    () => allPaletteItems.filter((item) => item.category === 'feature'),
    [allPaletteItems]
  );

  const quickActions = useMemo(
    () => allPaletteItems.filter((item) => item.category === 'quick-action'),
    [allPaletteItems]
  );

  // ... rest of hook unchanged, using `features` and `quickActions` as before
}
```

The `FeatureItem` and `QuickActionItem` types remain exported for backward compatibility but become aliases or are replaced by `CommandPaletteContribution`.

#### 3.2 DialogHost

**Current:** 6 explicit dialog renders controlled by per-dialog booleans from `useAppStore()`.

**After:** `DialogHost` queries the `dialog` slot and renders contributions dynamically. Dialog open/close state continues to live in `useAppStore()` — the registry only knows which dialogs exist.

```typescript
// In DialogHost.tsx
const dialogContributions = useSlotContributions('dialog');
const appState = useAppStore();

return (
  <>
    {dialogContributions.map((dialog) => {
      const isOpen = appState[dialog.openStateKey as keyof typeof appState] as boolean;
      const setOpen = appState[
        `set${dialog.openStateKey.charAt(0).toUpperCase()}${dialog.openStateKey.slice(1)}` as keyof typeof appState
      ] as (open: boolean) => void;

      return (
        <dialog.component
          key={dialog.id}
          open={isOpen}
          onOpenChange={setOpen}
        />
      );
    })}

    {/* OnboardingFlow remains hardcoded — it's an overlay, not a standard dialog */}
    {onboardingStep !== null && (
      <OnboardingFlow initialStep={onboardingStep} onComplete={...} />
    )}
  </>
);
```

**Dialog contributions exported from their feature modules:**

```typescript
// features/settings/contributions.ts
export const SETTINGS_DIALOG: DialogContribution = {
  id: 'settings',
  component: SettingsDialog,
  openStateKey: 'settingsOpen',
  priority: 1,
};
```

Similar exports for PulsePanel, RelayPanel, MeshPanel, AgentDialog, DirectoryPicker.

#### 3.3 SidebarFooterBar

**Current:** 4 hardcoded buttons with inline `onClick` handlers.

**After:** Queries `sidebar.footer` slot. The DorkOS logo and version display remain hardcoded (they're not extensible).

```typescript
const footerButtons = useSlotContributions('sidebar.footer');
const filteredButtons = useMemo(
  () => footerButtons.filter((b) => !b.showInDevOnly || import.meta.env.DEV),
  [footerButtons]
);

return (
  <div className="flex items-center px-2 py-1.5">
    <DorkLogo ... />
    <div className="ml-auto flex items-center gap-0.5">
      {filteredButtons.map((button) => (
        <SidebarFooterButton key={button.id} {...button} />
      ))}
    </div>
  </div>
);
```

**Contribution data:**

```typescript
export const SIDEBAR_FOOTER_BUTTONS: SidebarFooterContribution[] = [
  {
    id: 'edit-agent',
    icon: Pencil,
    label: 'Edit Agent',
    onClick: () => useAppStore.getState().setAgentDialogOpen(true),
    priority: 1,
  },
  {
    id: 'settings',
    icon: Settings,
    label: 'Settings',
    onClick: () => useAppStore.getState().setSettingsOpen(true),
    priority: 2,
  },
  {
    id: 'theme',
    icon: Sun,
    label: 'Toggle Theme',
    onClick: () => {
      /* cycle theme */
    },
    priority: 3,
  },
  {
    id: 'devtools',
    icon: Bug,
    label: 'Devtools',
    onClick: () => useAppStore.getState().toggleDevtools(),
    priority: 4,
    showInDevOnly: true,
  },
];
```

**Note:** The theme button's icon changes dynamically (Sun/Moon/Monitor). The contribution's `icon` field represents the default; the rendering component handles the dynamic icon swap based on current theme. This may require the contribution to accept a `renderIcon?: () => ReactNode` override, or the `SidebarFooterButton` wrapper component handles it by ID.

#### 3.4 Sidebar Tabs

**Current:** `useSidebarTabs()` builds `visibleTabs` array with `pulseToolEnabled` conditional.

**After:** Tab contributions include `visibleWhen` predicates. The hook queries the registry and filters.

```typescript
export const SIDEBAR_TAB_CONTRIBUTIONS: SidebarTabContribution[] = [
  {
    id: 'overview',
    icon: LayoutDashboard,
    label: 'Overview',
    component: OverviewPanel,
    shortcut: '⌘1',
    priority: 1,
  },
  {
    id: 'sessions',
    icon: MessageSquare,
    label: 'Sessions',
    component: SessionsView,
    shortcut: '⌘2',
    priority: 2,
  },
  {
    id: 'schedules',
    icon: Clock,
    label: 'Schedules',
    component: SchedulesView,
    visibleWhen: () => useAppStore.getState().pulseToolEnabled,
    shortcut: '⌘3',
    priority: 3,
  },
  {
    id: 'connections',
    icon: Radio,
    label: 'Connections',
    component: ConnectionsView,
    shortcut: '⌘4',
    priority: 4,
  },
];
```

**Modified `useSidebarTabs()`:**

```typescript
export function useSidebarTabs(): SidebarTabsResult {
  const allTabs = useSlotContributions('sidebar.tabs');

  const visibleTabs = useMemo(
    () => allTabs.filter((tab) => !tab.visibleWhen || tab.visibleWhen()),
    [allTabs]
  );

  // ... rest of hook (active tab fallback, keyboard shortcuts) uses visibleTabs
}
```

**Note:** The `pulseToolEnabled` parameter to `useSidebarTabs()` is removed. The `visibleWhen` predicate on the schedules tab reads it directly from the store. The hook's signature changes from `useSidebarTabs(pulseToolEnabled: boolean)` to `useSidebarTabs()`.

#### 3.5 Dashboard Sections

**Current:** 5 sections composed in fixed JSX order.

**After:** Sections are registered with explicit priorities. `DashboardPage` queries the registry and renders in priority order.

```typescript
export const DASHBOARD_SECTION_CONTRIBUTIONS: DashboardSectionContribution[] = [
  { id: 'needs-attention', component: NeedsAttentionSection, priority: 1 },
  { id: 'promo', component: PromoSlotWrapper, priority: 2 },
  { id: 'active-sessions', component: ActiveSessionsSection, priority: 3 },
  { id: 'system-status', component: SystemStatusRow, priority: 4 },
  { id: 'recent-activity', component: RecentActivityFeed, priority: 5 },
];
```

**Modified `DashboardPage`:**

```typescript
const sections = useSlotContributions('dashboard.sections');
const visibleSections = useMemo(
  () => sections.filter((s) => !s.visibleWhen || s.visibleWhen()),
  [sections]
);

return (
  <ScrollArea className="h-full">
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:space-y-8 sm:px-6 sm:py-8">
      {visibleSections.map((section) => (
        <section.component key={section.id} />
      ))}
    </div>
  </ScrollArea>
);
```

**Note:** Detail sheets (`DeadLetterDetailSheet`, `FailedRunDetailSheet`, `OfflineAgentDetailSheet`) remain hardcoded in `DashboardPage` — they are route-driven overlays, not dashboard sections.

### 4. Barrel Export Updates

#### `shared/model/index.ts`

Add registry exports:

```typescript
export {
  useExtensionRegistry,
  useSlotContributions,
  SLOT_IDS,
  type SlotId,
  type SlotContributionMap,
  type BaseContribution,
  type SidebarFooterContribution,
  type SidebarTabContribution,
  type DashboardSectionContribution,
  type HeaderActionContribution,
  type CommandPaletteContribution,
  type DialogContribution,
  type SettingsTabContribution,
  type SessionCanvasContribution,
} from './extension-registry';
```

#### Feature barrels

Each feature barrel exports its contribution data arrays for `init-extensions.ts` to import.

## User Experience

No user-visible changes. This is a pure internal refactor. Every button, dialog, tab, palette item, and dashboard section renders exactly as before — in the same order, with the same icons, labels, and actions.

## Testing Strategy

### Registry Store Unit Tests

New file: `layers/shared/model/__tests__/extension-registry.test.ts`

Test via `getState()` without React rendering. Reset between tests:

```typescript
beforeEach(() => {
  useExtensionRegistry.setState({ slots: createInitialSlots() }, true);
});
```

**Core test cases:**

1. **Register and retrieve** — `register('sidebar.footer', contribution)` then `getContributions('sidebar.footer')` returns it
2. **Unregister removes** — call the returned unsubscribe function, contribution is gone
3. **Priority ordering** — register items with priorities 3, 1, 2; `useSlotContributions` returns them sorted [1, 2, 3]
4. **Cross-slot isolation** — registering to `sidebar.footer` doesn't affect `dialog`
5. **Empty slot returns empty array** — `getContributions('session.canvas')` returns `[]`
6. **Default priority** — contribution without `priority` field gets 50
7. **Stable sort tie-breaking** — contributions with equal priority maintain insertion order

### Existing Test Compatibility

All existing tests must continue passing unchanged. The registry is an implementation detail — the public API of each component/hook doesn't change.

| Test File                   | What It Validates                                                             | Migration Impact                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `use-palette-items.test.ts` | `features` has 4 items, `quickActions` has 6, `searchableItems` includes both | Hook still returns same shape. Tests may need to call `initializeExtensions()` in `beforeEach` or mock the registry. |
| `DialogHost.test.tsx`       | Each dialog renders when its open state is true                               | Mock registry or register contributions in test setup. Same assertions.                                              |
| `SidebarFooterBar.test.tsx` | Buttons fire correct app-store actions, theme cycling works                   | Register footer buttons in test setup. Same assertions.                                                              |
| `SessionSidebar.test.tsx`   | Tabs computed based on `pulseToolEnabled`                                     | Register tab contributions in test setup. Same assertions.                                                           |

**Test helper:** Consider adding a `setupTestRegistry()` function to `@dorkos/test-utils` that registers all built-in contributions, so tests don't need to manually set up the registry.

### Integration Tests

No new E2E tests required — existing browser tests cover the behavioral surface. If any browser tests break, it indicates a regression (the migration is supposed to be invisible).

## Performance Considerations

- **Registration is O(n)** where n is the number of contributions per slot. With 4-10 built-in items per slot, this is negligible.
- **Sorting happens at render time** via `useSlotContributions`, not at registration time. With <20 items per slot, sort cost is sub-microsecond.
- **Zustand selectors** are reference-equality checked. The `slots[slotId]` reference changes only when that slot's contributions change, preventing unnecessary re-renders in unrelated components.
- **No lazy loading overhead** — all built-in contributions are registered synchronously before first render.

## Security Considerations

- The registry is client-side only — no server interaction, no user data, no authentication.
- Contribution `onClick` handlers have the same access as the hardcoded handlers they replace (full app-store access). This is not a privilege escalation.
- Phase 3 will need to consider sandboxing for third-party extension contributions. This is explicitly out of scope for Phase 2.

## Documentation

- Update `contributing/state-management.md` to document the extension registry pattern alongside the existing app-store pattern
- Update `contributing/project-structure.md` to mention `app/init-extensions.ts` as the extension initialization entry point
- No external user-facing docs needed — this is an internal refactor

## Implementation Phases

### Phase 1: Registry Core

Create the registry store, types, and hook:

- `layers/shared/model/extension-registry.ts` — Store, types, `useSlotContributions` hook
- `layers/shared/model/__tests__/extension-registry.test.ts` — 7 core test cases
- `layers/shared/model/index.ts` — Barrel export updates

### Phase 2: Initialization Wiring

Create the app-layer initialization and contribution data exports:

- `app/init-extensions.ts` — `initializeExtensions()` function
- `main.tsx` — Call `initializeExtensions()` before render
- Feature barrel updates — Export contribution data arrays

### Phase 3: Component Migrations

Migrate each component to query the registry. One component at a time, verifying tests pass after each:

1. `use-palette-items.ts` — Replace `FEATURES[]` and `QUICK_ACTIONS[]` with registry queries
2. `DialogHost.tsx` — Replace hardcoded dialog renders with registry loop
3. `SidebarFooterBar.tsx` — Replace hardcoded buttons with registry query
4. `use-sidebar-tabs.ts` — Replace computed tab array with registry query
5. `DashboardPage.tsx` — Replace hardcoded sections with registry query

### Phase 4: Test Updates & Cleanup

- Update existing tests to set up the registry in `beforeEach` (or use `setupTestRegistry()`)
- Remove dead code (old static arrays, unused imports)
- Run full test suite to confirm behavioral parity
- Update contributing docs

## Open Questions

None — all questions resolved during ideation (see `01-ideation.md` Section 6).

## Related ADRs

- **ADR-0001:** Hexagonal architecture with Transport interface — establishes the decoupling pattern this registry follows
- **ADR-0020:** Adapter registry with `Promise.allSettled()` — server-side registry pattern; error isolation strategy applicable to extension registration
- **ADR-0030:** Dynamic import for adapter plugins — plugin loading mechanism relevant to Phase 3 extension loading

## References

- Ideation document: `specs/ext-platform-02-extension-registry/01-ideation.md`
- Brief: `specs/ext-platform-02-extension-registry/00-brief.md`
- Prior research: `research/20260323_plugin_extension_ui_architecture_patterns.md` (VSCode, Obsidian, Backstage, Grafana patterns)
- New research: `research/20260326_extension_point_registry_patterns.md` (API shapes, TypeScript typing, initialization patterns)
- Previous ideation: `specs/plugin-extension-system/01-ideation.md` (spec #173)
- [VSCode Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
- [Backstage Extension Points](https://backstage.io/docs/backend-system/architecture/extension-points/)
- [Zustand Testing Guide](https://zustand.docs.pmnd.rs/guides/testing)
- [TypeScript Declaration Merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html)

## Acceptance Criteria

- [ ] `extension-registry.ts` exists in `layers/shared/model/` as a Zustand store with `devtools` middleware
- [ ] All 8 slot IDs defined as string constants with typed contribution interfaces
- [ ] `SlotContributionMap` is an `interface` (not `type`) for future module augmentation
- [ ] `useSlotContributions(slotId)` hook returns priority-sorted contributions for any slot
- [ ] `register()` returns an unsubscribe function; calling it removes the contribution
- [ ] Priority ordering works: lower number appears first, default is 50, stable sort
- [ ] `initializeExtensions()` called from `main.tsx` synchronously before `createRoot().render()`
- [ ] `FEATURES[]` and `QUICK_ACTIONS[]` registered via registry — `usePaletteItems()` queries the registry
- [ ] `DialogHost` queries the `dialog` slot and renders contributions dynamically
- [ ] `SidebarFooterBar` queries the `sidebar.footer` slot and renders contributions dynamically
- [ ] `use-sidebar-tabs.ts` queries the `sidebar.tabs` slot with `visibleWhen` predicates
- [ ] `DashboardPage` queries the `dashboard.sections` slot and renders in priority order
- [ ] `session.canvas` slot defined with placeholder type — no registrations
- [ ] No user-visible behavior change — pure refactor
- [ ] Registry exported from `@/layers/shared/model` barrel
- [ ] Unit tests for registry: register, query, unregister, priority ordering, cross-slot isolation, empty slot, stable sort
- [ ] All existing tests pass unchanged (or with minimal test setup changes)
