---
title: 'Extension Point Registry: API Shape, TypeScript Typing, Testing, and Initialization Patterns'
date: 2026-03-26
type: implementation
status: active
tags:
  [
    extension-registry,
    plugin-system,
    zustand,
    typescript,
    typed-slots,
    testing,
    fsd,
    react,
    backstage,
    vscode,
  ]
feature_slug: ext-platform-02-extension-registry
searches_performed: 12
sources_count: 22
---

# Extension Point Registry: Research Report

**Date**: 2026-03-26
**Research Depth**: Deep Research
**Feature**: ext-platform-02-extension-registry

---

## Research Summary

This report answers the six specific open questions for the DorkOS extension point registry. It synthesizes existing cached research on VSCode/Obsidian/Backstage patterns with new targeted research on TypeScript typed-slot patterns, Zustand testing strategies, contribution ordering systems, and initialization patterns compatible with Feature-Sliced Design. The clear recommendation across all six questions is: generic mapped-type approach for typing, Zustand store with `Map<slotId, Contribution[]>` shape, slot-handles empty state themselves, direct `getState()` testing without React rendering, numeric priority with stable insertion order, and explicit initialization from the `app` layer in `main.tsx`.

---

## 1. Existing Research Summary

### From `research/20260323_plugin_extension_ui_architecture_patterns.md`

**VSCode contribution points:** 34+ declarative UI registration points in `package.json`. The key insight is that UI registration is _data_, not code — manifests are read at startup without activating extension code. Menu ordering uses `"group": "navigation@1"` syntax: group name + `@<number>` for intra-group position. The `navigation` group is always sorted to the top.

**Obsidian cleanup pattern:** All `register*()` and `add*()` calls are tracked automatically. On `onunload()`, Obsidian cleans everything that was registered. This auto-cleanup model prevents resource leaks and is the correct model for DorkOS's unsubscribe function pattern.

**Backstage `createApp` pattern:** Built-in features passed explicitly in a `features` array. Plugins can be auto-discovered or manually installed. The `createApp` entrypoint handles wiring — critically, features don't import each other directly, they are wired at the app-level entrypoint.

**Backstage backend extension points:** `createExtensionPoint<T>({ id })` — generic typed interface, string ID. Modules call `registerExtensionPoint(point, implementation)`. All modules are fully initialized _before_ the owning plugin's `init` runs, eliminating ordering race conditions.

**Grafana props-based rendering:** Plugin components receive all data via props (`PanelProps`), never reaching into global state. This "props-as-contract" pattern is directly applicable to how slot components should pass context to registered contributions.

**Factory functions (Backstage):** `createPlugin()`, `createRoutableExtension()`, `createComponentExtension()` — typed factories make the API IDE-discoverable and compile-time checked. Better DX than raw registration calls.

### From `specs/plugin-extension-system/01-ideation.md`

The spec has already settled on:

- Seven v1 slot IDs: `sidebar.footer`, `sidebar.tabs`, `dashboard.sections`, `header.actions`, `command-palette.items`, `dialog`, `settings.tabs`
- Zustand store as the registry mechanism
- `registerComponent(slot, id, component, { priority? })` as the primary API
- Automatic cleanup (returns unsubscribe function)
- Located at `layers/shared/model/plugin-registry.ts`

---

## 2. API Shape Analysis

### The Three Approaches

**Approach A — Single generic method:**

```typescript
registry.register(slotId, contribution);
```

- Pro: One method to learn, maximal flexibility
- Pro: Easy to add new slot types without API changes
- Con: `contribution` type is `unknown` or `any` without additional type machinery
- Con: Mistakes (passing wrong shape to a slot) are not caught at registration time

**Approach B — Typed method per contribution category:**

```typescript
registry.registerComponent(slotId, component, meta);
registry.registerCommand(id, label, callback, options);
registry.registerDialog(id, component);
```

- Pro: Each method has a clear, strongly-typed signature
- Pro: Familiar from Obsidian (`addCommand`, `registerView`, etc.)
- Pro: IDE autocomplete surfaces all the right fields
- Con: Adding a new contribution category requires a new method on the API
- Con: Component-type slots (sidebar, dashboard, header) all get the same `registerComponent` — the slot-specific contribution shape differences are lost

**Approach C — Separate method per slot:**

```typescript
registry.registerCommand();
registry.registerDialog();
registry.registerSidebarFooterAction();
registry.registerDashboardSection();
```

- Pro: Maximum type safety — each slot's exact shape is enforced
- Pro: Compile-time error if you try to register the wrong shape to a slot
- Con: More methods to maintain; adding a new slot requires a new method
- Con: Doesn't scale well to externally-defined slots from third-party plugins

### The Recommended Hybrid

The ideal is **Approach A with generic type inference**, which achieves Approach C's type safety without the proliferation of methods. This is the pattern used by Backstage's `createExtensionPoint<T>` and is enabled by TypeScript's mapped types:

```typescript
// Central slot map — the single source of truth for what each slot accepts
interface SlotContributionMap {
  'sidebar.footer': SidebarFooterContribution;
  'dashboard.sections': DashboardSectionContribution;
  'command-palette.items': CommandPaletteContribution;
  dialog: DialogContribution;
  'sidebar.tabs': SidebarTabContribution;
  'header.actions': HeaderActionContribution;
  'settings.tabs': SettingsTabContribution;
}

// Single register method, generic-constrained to the map
function register<K extends keyof SlotContributionMap>(
  slotId: K,
  contribution: SlotContributionMap[K]
): () => void;
```

When you call `register('sidebar.footer', { ... })`, TypeScript infers `K = 'sidebar.footer'` and constrains `contribution` to `SidebarFooterContribution`. Wrong slot shapes fail at compile time. No method proliferation.

**Verdict:** Use Approach A (single generic `register` method) with a `SlotContributionMap` typed interface. Provide convenience wrappers as syntactic sugar but make the underlying `register` the canonical primitive.

---

## 3. TypeScript Typing Patterns

### Pattern 1: Mapped Type Slot Map (Recommended)

The core mechanism: a single interface maps slot IDs to their contribution types.

```typescript
// In layers/shared/model/extension-registry.ts

export interface SidebarFooterContribution {
  id: string;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  onClick: () => void;
  priority?: number;
}

export interface DashboardSectionContribution {
  id: string;
  title: string;
  component: React.ComponentType;
  priority?: number;
}

export interface CommandPaletteContribution {
  id: string;
  label: string;
  shortcut?: string;
  action: () => void;
  priority?: number;
}

export interface DialogContribution {
  id: string;
  component: React.ComponentType;
}

// The registry map — one entry per slot, each with a distinct contribution shape
export interface SlotContributionMap {
  'sidebar.footer': SidebarFooterContribution;
  'dashboard.sections': DashboardSectionContribution;
  'command-palette.items': CommandPaletteContribution;
  dialog: DialogContribution;
  'sidebar.tabs': SidebarTabContribution;
  'header.actions': HeaderActionContribution;
  'settings.tabs': SettingsTabContribution;
}

export type SlotId = keyof SlotContributionMap;
```

The Zustand store shape:

```typescript
type RegistryState = {
  // Map from slot ID to ordered array of contributions
  contributions: {
    [K in SlotId]: SlotContributionMap[K][];
  };

  // The single generic register method
  register: <K extends SlotId>(slotId: K, contribution: SlotContributionMap[K]) => () => void; // returns unsubscribe

  // Query method — slot consumers call this
  getContributions: <K extends SlotId>(slotId: K) => SlotContributionMap[K][];
};
```

This gives full type safety through the entire stack: the registrant cannot pass the wrong shape, and the slot consumer gets the correctly typed array back.

### Pattern 2: Module Augmentation for Future Extensibility

The Type Registry Pattern (from Frontend Masters TypeScript v4) uses `declare module` for open-ended extensibility, allowing third-party code to extend the `SlotContributionMap`:

```typescript
// In a hypothetical third-party plugin package
declare module '@dorkos/plugin-api' {
  interface SlotContributionMap {
    'my-plugin.widget': MyPluginWidgetContribution;
  }
}
```

This is worth supporting in the future but is **not required for v1** (where all slots are first-party and known ahead of time). It should be designed into the `SlotContributionMap` interface location from day one — make it an exported interface in a stable module path so augmentation works when needed.

### Pattern 3: What NOT to Do

**Avoid discriminated unions for the registry itself:** A large `type Contribution = SidebarFooterContribution | DashboardSectionContribution | ...` union degrades TypeScript performance at scale (per Slash Engineering's 1M-line report). The mapped type approach avoids union type checking entirely.

**Avoid `any` for contribution values:** Even if initially convenient, `any` in the store makes slot components lose their type safety. The generic mapped-type approach eliminates the need for `any`.

---

## 4. Empty State Patterns

### What the Research Shows

**react-slots / grlt-hub pattern:** When zero components are registered to a slot, `<Slots.SlotName />` renders nothing — empty, no DOM output. The slot component itself is a no-op when empty.

**VSCode:** The host UI is built declaratively from contribution point data. If a view container has no views, it simply doesn't render. Empty handling is the host's responsibility via conditional rendering.

**Obsidian:** Sidebar ribbon icons, view containers, status bar items all work with the assumption that they may have zero contributions. Native Obsidian UI components handle their own empty states.

**effector-react-slots:** Slot components accept optional `fallback` content that renders when no component is set. This is the cleanest model: the slot declares its own fallback, not the registry.

### Recommended Pattern

**Slot components own their empty state.** The registry is a passive data store — it returns an empty array for slots with zero contributions. The `<SidebarFooterSlot>` component decides what (if anything) to render when the array is empty.

```typescript
// In SidebarFooterBar.tsx
function SidebarFooterBar() {
  const contributions = useExtensionRegistry(s => s.getContributions('sidebar.footer'));

  // Empty state: just don't render anything
  // The built-in footer actions are NOT registered via the extension registry —
  // they live in the component and always render.
  // Extension registry only handles additions.
  return (
    <div className="sidebar-footer">
      {/* Built-in actions always present */}
      <BuiltInSettingsButton />

      {/* Extension contributions rendered after built-ins */}
      {contributions
        .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
        .map(c => (
          <button key={c.id} onClick={c.onClick} title={c.label}>
            <c.icon size={16} />
          </button>
        ))
      }
    </div>
  );
}
```

Key principle: **built-in features should NOT register themselves via the extension registry for slot rendering.** They exist in the component directly. The registry only handles additions beyond the built-in baseline. This avoids a chicken-and-egg initialization problem and keeps built-in behavior predictable.

---

## 5. Testing Strategy

### Testing Zustand Registry Stores

Zustand stores are particularly testable because they can be exercised entirely outside React — no `render()`, no JSX, no DOM. For a registry store, this is the right testing approach:

```typescript
// __tests__/extension-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useExtensionRegistry } from '../extension-registry';

beforeEach(() => {
  // Reset the store to initial state between tests
  // Zustand exposes setState(initialState, true) to replace state entirely
  useExtensionRegistry.setState(useExtensionRegistry.getInitialState(), true);
});

describe('extension registry', () => {
  it('registers a contribution and retrieves it', () => {
    const contribution: SidebarFooterContribution = {
      id: 'test-action',
      icon: TestIcon,
      label: 'Test',
      onClick: vi.fn(),
    };

    useExtensionRegistry.getState().register('sidebar.footer', contribution);
    const items = useExtensionRegistry.getState().getContributions('sidebar.footer');

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('test-action');
  });

  it('unregister function removes the contribution', () => {
    const unregister = useExtensionRegistry.getState().register('sidebar.footer', {
      id: 'temp',
      icon: TestIcon,
      label: 'Temp',
      onClick: vi.fn(),
    });

    expect(useExtensionRegistry.getState().getContributions('sidebar.footer')).toHaveLength(1);

    unregister();

    expect(useExtensionRegistry.getState().getContributions('sidebar.footer')).toHaveLength(0);
  });

  it('orders contributions by priority', () => {
    useExtensionRegistry.getState().register('sidebar.footer', { id: 'b', priority: 20, ...base });
    useExtensionRegistry.getState().register('sidebar.footer', { id: 'a', priority: 10, ...base });
    useExtensionRegistry.getState().register('sidebar.footer', { id: 'c', priority: 30, ...base });

    const items = useExtensionRegistry.getState().getContributions('sidebar.footer');

    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for slot with no contributions', () => {
    const items = useExtensionRegistry.getState().getContributions('dialog');
    expect(items).toEqual([]);
  });

  it('does not affect other slots when unregistering', () => {
    useExtensionRegistry
      .getState()
      .register('dashboard.sections', { id: 'section-1', ...sectionBase });
    const unregister = useExtensionRegistry
      .getState()
      .register('sidebar.footer', { id: 'footer-1', ...footerBase });

    unregister();

    expect(useExtensionRegistry.getState().getContributions('dashboard.sections')).toHaveLength(1);
    expect(useExtensionRegistry.getState().getContributions('sidebar.footer')).toHaveLength(0);
  });
});
```

### Store Reset Pattern for Vitest

The official Zustand recommendation for Vitest is to create a `__mocks__/zustand.ts` that wraps `create` and auto-resets all stores in `beforeEach`. For a registry store specifically, it is cleaner to just call `setState(initialState, true)` in `beforeEach` within each test file:

```typescript
beforeEach(() => {
  useExtensionRegistry.setState(useExtensionRegistry.getInitialState(), true);
});
```

`getInitialState()` is available on Zustand stores created with `create` (as of Zustand v4+). The second argument `true` to `setState` replaces the entire state rather than merging.

### Testing Slot Components with Registry Contributions

For integration tests that verify slot components render registered contributions:

```typescript
// __tests__/SidebarFooterBar.test.tsx
/**
 * @vitest-environment jsdom
 */
it('renders registered footer contributions', async () => {
  const unregister = useExtensionRegistry.getState().register('sidebar.footer', {
    id: 'test-btn',
    icon: MockIcon,
    label: 'Test Action',
    onClick: vi.fn(),
  });

  render(<SidebarFooterBar />, { wrapper: Wrapper });

  expect(screen.getByTitle('Test Action')).toBeInTheDocument();

  unregister();

  // After unregister, re-render should not show it
  // (Zustand reactivity will update the component)
});
```

### Snapshot vs. Behavioral Testing

For registry stores: **behavioral testing only, no snapshots.** Registry tests should verify:

- Correct array contents after register/unregister
- Correct ordering after multiple registrations with different priorities
- Type safety (compile-time, not runtime tests)
- Cross-slot isolation (registering to slot A doesn't affect slot B)

Snapshots are inappropriate here — the data structure is too dynamic and snapshot diffs would be brittle as contribution shapes evolve.

---

## 6. Priority/Ordering Systems

### How Real Systems Handle It

**VSCode menus:** Group-based with `@<number>` intra-group position. `"group": "navigation@1"` places an item at position 1 in the `navigation` group (which is always first). Groups sorted lexicographically. This is powerful but complex — requires understanding both group naming conventions and numeric suffixes.

**grlt-hub/react-slots:** Simple numeric `order` field. Lower renders first. Components with equal order maintain insertion sequence. Exactly the pattern described in the brief.

**Backstage:** No built-in ordering for extensions — declarative, positional within page structure. Plugins define their position via route structure.

**Obsidian:** No explicit ordering for commands or views — registry insertion order is the only ordering mechanism.

### Priority System Recommendation

For DorkOS v1: **numeric priority, lower = higher priority, default = 50.**

```typescript
interface BaseContribution {
  id: string;
  priority?: number; // default: 50
}
```

Sorting in slot components:

```typescript
const sorted = contributions.slice().sort((a, b) => {
  const pa = a.priority ?? 50;
  const pb = b.priority ?? 50;
  if (pa !== pb) return pa - pb;
  // Stable tie-breaking: insertion order (preserved by Map iteration order)
  return 0;
});
```

**Priority range conventions:**

- `1-10`: Core built-in features (if any are registered via the registry)
- `10-40`: High-priority third-party integrations
- `50`: Default (most contributions land here)
- `51-90`: Lower-priority additions
- `90-100`: Last-resort / catch-all items

**Why not before/after anchoring?**

Before/after anchoring (e.g., `"after": "some-other-item-id"`) creates dependency chains between registrations. If the anchor item is removed, all items anchored to it have undefined behavior. For a developer tool where the slot host controls the built-in items, numeric priority is simpler and sufficient.

**Why not groups?**

VSCode's group system is powerful but adds cognitive overhead. DorkOS slots are smaller and less complex than VSCode's command palette — numeric priority is adequate and more developer-friendly.

**Insertion order as stable tie-breaker:**

When two items have the same priority, they should render in registration order. The Zustand store should use an array (not a Set or object) internally to preserve insertion order. Sorting should be stable (Array.prototype.sort is guaranteed stable in ES2019+, which all modern runtimes implement).

---

## 7. Initialization Patterns in React + Zustand + FSD

### The Core Problem

FSD's hard rule: slices on the same layer cannot import from each other. Features cannot import features. This means the `features/command-palette` feature cannot import `features/session-list` to register its contributions. Each feature needs to register its own contributions _without_ knowing about other features.

### Option A: Module-Level Side Effects

```typescript
// In features/command-palette/model/register-contributions.ts
import { useExtensionRegistry } from '@/layers/shared/model/extension-registry';

// Module-level registration — runs when this module is imported
useExtensionRegistry.getState().register('command-palette.items', {
  id: 'new-session',
  label: 'New Session',
  action: () => navigate('/session'),
});
```

Then in `main.tsx`:

```typescript
import '@/layers/features/command-palette/model/register-contributions';
import '@/layers/features/session-list/model/register-contributions';
```

- Pro: Zero boilerplate in each feature — just import the registration file
- Pro: Registration runs synchronously before React renders
- Con: Module-level side effects at import time are an anti-pattern — hard to test, hard to control execution order, creates tight coupling between module loading and runtime behavior
- Con: Difficult to conditionally disable in tests without module system gymnastics

### Option B: Explicit Initialization Function from main.tsx

```typescript
// In layers/shared/lib/register-built-ins.ts
import { useExtensionRegistry } from '../model/extension-registry';
import { commandPaletteContributions } from '@/layers/features/command-palette/model/contributions';
import { sidebarFooterContributions } from '@/layers/features/session-list/model/contributions';

export function registerBuiltInContributions(): void {
  const { register } = useExtensionRegistry.getState();

  commandPaletteContributions.forEach((c) => register('command-palette.items', c));
  sidebarFooterContributions.forEach((c) => register('sidebar.footer', c));
  // ...
}
```

In `main.tsx`:

```typescript
registerBuiltInContributions();
// Then render the app
```

- Pro: Explicit, inspectable, readable call site
- Pro: Easy to test — mock `registerBuiltInContributions` or test the function itself
- Pro: Fits the `shared` ← `features` import direction (contributions are data exported from features; the registration function in `shared` or `app` imports and wires them)
- Con: The `register-built-ins.ts` file still needs to import from all relevant features, which means it grows as features are added

**This is the cleanest option for DorkOS's FSD architecture.**

### Option C: React Context / Provider

```typescript
// In layers/shared/providers/ExtensionRegistryProvider.tsx
function ExtensionRegistryProvider({ children }: { children: React.ReactNode }) {
  const register = useExtensionRegistry(s => s.register);

  useEffect(() => {
    const cleanups = [
      register('command-palette.items', { ... }),
      register('sidebar.footer', { ... }),
    ];
    return () => cleanups.forEach(fn => fn());
  }, []);

  return <>{children}</>;
}
```

- Pro: Cleanup on unmount built in via useEffect return
- Pro: Can use React lifecycle for conditional registration
- Con: Registration happens after the first render, causing a brief flash where slots are empty
- Con: `useEffect` runs after paint — contributions would not be available on first render
- Con: More complex than a synchronous initialization call

The Provider approach works for plugin-loaded-later scenarios (third-party plugins loaded async), but for **built-in features that should always be present from frame one**, synchronous initialization before React renders is the right choice.

### Option D: Zustand Store Initializer

```typescript
// In extension-registry.ts
const useExtensionRegistry = create<RegistryState>((set, get) => ({
  contributions: createEmptyContributions(),

  // Register built-ins inline during store creation
  // ... (this is effectively a module-level side effect)
}));
```

This couples built-in feature knowledge to the shared registry store, violating FSD's layer rules (shared cannot import from features).

### Recommended Initialization Pattern

**Option B (explicit initialization function) called from `main.tsx`.**

Concretely:

```
apps/client/src/
├── main.tsx                          # Calls initializeExtensions() before render
└── app/                              # App layer (can import from all layers)
    └── init-extensions.ts            # Gathers built-in contributions, calls registry
```

```typescript
// apps/client/src/app/init-extensions.ts
// This file lives in the app layer which is allowed to import from all FSD layers

import { useExtensionRegistry } from '@/layers/shared/model/extension-registry';
import { getCommandPaletteContributions } from '@/layers/features/command-palette';
import { getSidebarFooterContributions } from '@/layers/features/session-list';
import { getDashboardSectionContributions } from '@/layers/widgets/dashboard';

export function initializeExtensions(): void {
  const { register } = useExtensionRegistry.getState();

  getCommandPaletteContributions().forEach((c) => register('command-palette.items', c));
  getSidebarFooterContributions().forEach((c) => register('sidebar.footer', c));
  getDashboardSectionContributions().forEach((c) => register('dashboard.sections', c));
  // ... etc
}
```

```typescript
// apps/client/src/main.tsx
import { initializeExtensions } from './app/init-extensions';

// Run before React renders
initializeExtensions();

// Then render
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RouterProvider router={router} />
      </TransportProvider>
    </QueryClientProvider>
  </StrictMode>
);
```

**Why this works with FSD:**

- `main.tsx` is outside the FSD layers (it's the app entry point, above all layers)
- `app/init-extensions.ts` is in the app layer, which FSD explicitly allows to import from all lower layers
- Features export their contribution data via their barrel `index.ts` — they don't know about the registry
- The registry (`shared/model/extension-registry.ts`) knows nothing about features — it's a dumb data store
- The wiring happens entirely in the `app` layer, which is the correct seam

---

## 8. Overall Recommendation

### Summary Answer to All 6 Questions

**Q1: API Shape**
Use a **single generic `register<K extends SlotId>(slotId, contribution)` method** backed by a `SlotContributionMap` interface. This achieves per-slot type safety without method proliferation. The `SlotContributionMap` interface is exported from `@/layers/shared/model/extension-registry` so it can be augmented by future third-party plugin packages via `declare module`.

**Q2: TypeScript Typing**
Use a **mapped type `SlotContributionMap`** where each slot ID keys to its specific contribution interface. The `register` function is generic-constrained to this map: `register<K extends keyof SlotContributionMap>(slotId: K, contribution: SlotContributionMap[K])`. TypeScript infers `K` from the `slotId` argument and enforces the correct contribution shape automatically. Do NOT use discriminated unions for the registry — they degrade TypeScript performance and require centralizing all contribution variants.

**Q3: Empty State Handling**
**Slot components own their empty state.** The registry returns `[]` for slots with no contributions. Built-in features are NOT registered via the registry — they exist directly in their slot components. The registry is purely additive. Slot components can choose to render nothing (most slots), a fallback placeholder, or simply ignore zero-contribution cases because built-ins always provide baseline content.

**Q4: Testing**
**Test the Zustand store directly without React rendering** using `useExtensionRegistry.getState()`. Reset state in `beforeEach` using `setState(getInitialState(), true)`. Write behavioral tests for: register-and-retrieve, unregister-removes-item, ordering-by-priority, cross-slot-isolation, empty-array-for-empty-slot. Write integration tests separately for slot components that use `render()` to verify contributions appear in the DOM.

**Q5: Priority/Ordering**
**Numeric priority, lower = higher priority, default = 50.** No groups, no before/after anchoring for v1. Sort in slot components at render time (not at registration time). Use stable sort with insertion order as tie-breaker. Preserve an implicit priority range convention in documentation (1-10 core, 50 default, 90-100 tail).

**Q6: Initialization**
**Explicit `initializeExtensions()` function in `apps/client/src/app/init-extensions.ts`, called synchronously from `main.tsx` before `createRoot().render()`**. This is the only approach compatible with FSD's import direction rules (app layer imports from features/widgets/shared, not the reverse). Features export their contribution data via their barrels; `init-extensions.ts` wires them to the registry. Plugin-loaded-later scenarios can use the `register()` function directly when the plugin activates.

### Canonical Store Shape

```typescript
// apps/client/src/layers/shared/model/extension-registry.ts

import { create } from 'zustand';

// Contribution interfaces per slot
export interface SidebarFooterContribution {
  id: string;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  onClick: () => void;
  priority?: number;
}

// ... (other contribution interfaces)

// The slot map — single source of truth
export interface SlotContributionMap {
  'sidebar.footer': SidebarFooterContribution;
  'sidebar.tabs': SidebarTabContribution;
  'dashboard.sections': DashboardSectionContribution;
  'header.actions': HeaderActionContribution;
  'command-palette.items': CommandPaletteContribution;
  dialog: DialogContribution;
  'settings.tabs': SettingsTabContribution;
}

export type SlotId = keyof SlotContributionMap;

type RegistryState = {
  contributions: { [K in SlotId]: SlotContributionMap[K][] };
  register: <K extends SlotId>(slotId: K, contribution: SlotContributionMap[K]) => () => void;
  getContributions: <K extends SlotId>(slotId: K) => SlotContributionMap[K][];
};

function createEmptyContributions(): { [K in SlotId]: [] } {
  return {
    'sidebar.footer': [],
    'sidebar.tabs': [],
    'dashboard.sections': [],
    'header.actions': [],
    'command-palette.items': [],
    dialog: [],
    'settings.tabs': [],
  };
}

export const useExtensionRegistry = create<RegistryState>((set, get) => ({
  contributions: createEmptyContributions(),

  register: (slotId, contribution) => {
    set((state) => ({
      contributions: {
        ...state.contributions,
        [slotId]: [...state.contributions[slotId], contribution],
      },
    }));

    // Return unsubscribe function
    return () => {
      set((state) => ({
        contributions: {
          ...state.contributions,
          [slotId]: state.contributions[slotId].filter(
            (c) => c.id !== (contribution as { id: string }).id
          ),
        },
      }));
    };
  },

  getContributions: (slotId) => {
    const items = get().contributions[slotId];
    return items.slice().sort((a, b) => {
      const pa = (a as { priority?: number }).priority ?? 50;
      const pb = (b as { priority?: number }).priority ?? 50;
      return pa - pb;
    }) as typeof items;
  },
}));
```

### Deviations from the Spec's Proposed API

The spec ideation proposed `registerComponent(slot, id, component, meta)` as the primary method. The research recommends changing this to `register(slotId, contribution)` where the contribution object bundles `id`, component, and all meta. Reasons:

1. Separating `id` and `component` as positional arguments is inconsistent with how `registerCommand` works (where the command object carries its own `id`)
2. The contribution object is cleaner — slot consumers destructure what they need from the object
3. The generic-constrained single method is more extensible than a method-per-category approach

The `registerCommand`, `registerDialog`, `registerSettingsTab` convenience methods from the spec can remain as thin wrappers calling the underlying `register` primitive.

---

## Key Findings

1. **Typed slot registry via `SlotContributionMap`**: A mapped type interface where each slot ID keys to its specific contribution shape is the TypeScript-correct approach. The generic `register<K extends SlotId>` function infers `K` from the `slotId` argument, giving per-slot type enforcement with a single method.

2. **Module augmentation is the extensibility path**: Exporting `SlotContributionMap` as an interface (not a type alias) enables future third-party plugins to augment it via `declare module '@dorkos/plugin-api'`. Plan for this in the interface location from day one.

3. **Slot components own empty state, built-ins live in components**: The registry is additive only. Slots should never be completely empty because built-in content is baked into the slot component itself. This eliminates "flash of no content" and initialization-order issues.

4. **Test Zustand registry stores without React**: `useExtensionRegistry.getState().register(...)` and `.getContributions(...)` can be tested as pure data transformations. Reset with `setState(getInitialState(), true)` in `beforeEach`.

5. **Numeric priority (default 50, lower = first)**: Simpler than VSCode's group@N system, adequate for DorkOS's slot complexity. Stable sort with insertion-order tie-breaking prevents non-deterministic rendering.

6. **App layer initialization**: `apps/client/src/app/init-extensions.ts` called from `main.tsx` before `createRoot().render()` is the FSD-compliant initialization pattern. Features export contribution data; the app layer wires them to the registry.

---

## Sources & Evidence

- [VSCode Contribution Points](https://code.visualstudio.com/api/references/contribution-points) — Group ordering via `"group": "navigation@1"` syntax
- [VSCode Sorting of menu groups issue](https://github.com/Microsoft/vscode/issues/43045) — Group sort order behavior
- [Backstage Backend Extension Points](https://backstage.io/docs/backend-system/architecture/extension-points/) — `createExtensionPoint<T>({ id })` typed factory pattern
- [Backstage Building Frontend Apps](https://backstage.io/docs/frontend-system/building-apps/index/) — `createApp({ features: [...] })` initialization pattern
- [grlt-hub/react-slots GitHub](https://github.com/grlt-hub/react-slots) — `order` numeric field, empty slot = no DOM output
- [effector-react-slots](https://github.com/space307/effector-react-slots) — Fallback content pattern for empty slots
- [react-extension-point](https://github.com/pke/react-extension-point) — String-based extension point names, `addExtension(name, Component)`
- [Type Registry Pattern (Frontend Masters)](https://frontendmasters.com/courses/typescript-v4/type-registry-pattern/) — Module augmentation for open extensibility
- [Scaling 1M lines of TypeScript: Registries](https://puzzles.slash.com/blog/scaling-1m-lines-of-typescript-registries) — Prefer base types over large union types for performance
- [Zustand Testing Guide](https://zustand.docs.pmnd.rs/guides/testing) — `getInitialState()`, reset patterns for Vitest
- [Zustand Testing (Peslo Blog)](https://blog.peslostudios.com/blog/zustand-writing-tests-for-your-data-store/) — `beforeEach` reset, `renderHook` with `act()`
- [Feature-Sliced Design Layers](https://feature-sliced.design/docs/reference/layers) — App layer as the only layer allowed to import from all layers
- [TypeScript Declaration Merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html) — Interface merging for extensibility
- [TypeScript Mapped Types](https://www.typescriptlang.org/docs/handbook/2/mapped-types.html) — `{ [K in keyof T]: ... }` mapped type syntax
- From cached research: `research/20260323_plugin_extension_ui_architecture_patterns.md` — VSCode/Obsidian/Grafana/Backstage patterns

---

## Research Gaps & Limitations

- **Zustand v5 API changes**: Zustand v5 was released in late 2024 and changed some APIs. The testing patterns described above are for Zustand v4. If DorkOS is on v5, verify `getInitialState()` is still available and `setState(state, true)` still replaces rather than merges.
- **TypeScript 5.x performance with mapped types**: No benchmarks found comparing mapped-type-keyed registries against discriminated unions at scale relevant to DorkOS's slot count (7 slots). At this scale, either approach is fine — the performance concern only arises at hundreds of union members.
- **Zustand `subscribeWithSelector` middleware**: If contributions need fine-grained subscription (e.g., a slot only re-renders when its specific slot changes, not when any slot changes), the `subscribeWithSelector` middleware should be considered. Not researched in depth here.

---

## Contradictions & Disputes

None significant. All sources converge on the same patterns:

- Generic mapped types for per-slot type safety
- Numeric priority for ordering
- App-layer initialization for FSD compliance
- Direct `getState()` testing for Zustand stores

---

## Search Methodology

- Searches performed: 12
- Most productive terms: "Backstage extension points architecture", "grlt-hub/react-slots", "Type Registry Pattern Frontend Masters", "Zustand testing getState vitest reset beforeEach", "VSCode menu group ordering sort"
- Primary source types: Official documentation (Backstage, VSCode), GitHub library source, Frontend Masters course materials, Zustand docs
