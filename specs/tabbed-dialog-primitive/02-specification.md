---
slug: tabbed-dialog-primitive
number: 218
created: 2026-04-06
status: specified
---

# Tabbed Dialog Primitive

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-04-06

---

## 1. Overview

Extract a `TabbedDialog` widget primitive into `shared/ui/` that owns the chrome currently duplicated across `SettingsDialog` and `AgentDialog` — the only two production consumers of the `NavigationLayout` family. Both dialogs become thin declarative consumers of a tab-config array. Ship three supporting primitives at the same time: `useDialogTabState` (deep-link sync hook), `SettingsPanel` (panel-header shorthand), and `SwitchSettingRow` (toggle-row shorthand). Add `⌘1`-`⌘9` keyboard shortcuts to switch between tabs by index.

After this spec:

- `SettingsDialog.tsx` shrinks from ~140 lines (post-`settings-dialog-file-splits`) to ~50 lines
- `AgentDialog.tsx` shrinks from 177 lines to ~60 lines
- ~150 lines of duplicated chrome are deleted
- ~17 instances of `<SettingRow>+<Switch>` boilerplate collapse to `<SwitchSettingRow>` (~70 lines saved)
- The two dialogs converge on a single deep-link sync pattern (the React-recommended "adjust state during render" approach)
- Future tabbed dialogs inherit the responsive sidebar/drill-in/keyboard-shortcut behavior for free

## 2. Background / Problem Statement

DorkOS has a single shared `NavigationLayout` primitive in `shared/ui/navigation-layout.tsx` (589 lines) that implements the "responsive sidebar with mobile drill-in" pattern used by every tabbed dialog in the app. Today exactly two production dialogs consume it: `SettingsDialog` and `AgentDialog`. They are visually and structurally identical above the tab content — same chrome, same animations, same accessibility, same responsive behavior — but the chrome itself is **copy-pasted between the two files**.

Specific duplication, line-for-line:

| Pattern                                                                                                      | `SettingsDialog.tsx`                 | `AgentDialog.tsx`                                                   |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------- |
| `ResponsiveDialog` wrapper with `max-h-[85vh] max-w-2xl gap-0 p-0`                                           | yes                                  | yes                                                                 |
| `ResponsiveDialogFullscreenToggle` placement                                                                 | yes                                  | yes                                                                 |
| `NavigationLayout` root + value/onValueChange wiring                                                         | yes                                  | yes                                                                 |
| `NavigationLayoutDialogHeader` with sr-only description                                                      | yes                                  | yes                                                                 |
| `NavigationLayoutBody` + `Sidebar` + `Content` skeleton                                                      | yes                                  | yes                                                                 |
| `NavigationLayoutContent` with `min-h-[280px] p-4`                                                           | yes                                  | yes                                                                 |
| Per-panel `<div className="space-y-4"><NavigationLayoutPanelHeader>X</NavigationLayoutPanelHeader>...</div>` | 8 instances                          | 4 instances                                                         |
| `useState(initialTab ?? defaultTab)` activeTab pattern                                                       | yes                                  | yes                                                                 |
| Deep-link sync from prop/store to local state                                                                | yes (via `useEffect`, lines 120-124) | yes (via "adjust state during render" with `prevOpen`, lines 53-59) |

The deep-link sync inconsistency is the most damaging: **two dialogs that do the exact same thing use two different patterns**. The `SettingsDialog` `useEffect` approach is the older one and is technically incorrect (it triggers a useless effect on every open and is the kind of thing the React team warns against in the new docs). The `AgentDialog` "track prevOpen and adjust state during render" is the React-team-recommended approach. Convergence on the latter via a shared hook eliminates the divergence and makes the right thing easy.

A second class of duplication exists at the row level: `<SettingRow>` paired with `<Switch>` is the most common pattern in the entire settings system, appearing 17+ times across `PreferencesTab`, `AdvancedTab`, `AgentsTab`, `agent-settings/CapabilitiesTab`, etc. Every instance is the same 5 lines:

```tsx
<SettingRow label="..." description="...">
  <Switch checked={x} onCheckedChange={setX} />
</SettingRow>
```

This isn't a critical problem, but it does mean:

- ~90 lines of boilerplate exist purely to wrap a Switch
- Many instances skip `aria-label` (the `Switch` inherits no accessible name from the surrounding `<SettingRow>`)
- Variations creep in (some pass `aria-label`, some don't; some use `disabled`, some use `disabled={!available}`, etc.)

A `<SwitchSettingRow>` shorthand fixes both the boilerplate and the consistency.

## 3. Goals

- Extract `TabbedDialog` widget to `shared/ui/tabbed-dialog.tsx` with comprehensive tests
- Extract `useDialogTabState` hook to `shared/model/use-dialog-tab-state.ts`
- Extract `SettingsPanel` shorthand component (panel + header + spacing) to `shared/ui/`
- Extract `SwitchSettingRow` shorthand to `shared/ui/setting-row.tsx` (alongside the existing `SettingRow`)
- Refactor `SettingsDialog` to consume `TabbedDialog` (target ~50 lines)
- Refactor `AgentDialog` to consume `TabbedDialog` (target ~60 lines)
- Both dialogs converge on `useDialogTabState` for deep-link sync (eliminate the `useEffect` pattern in `SettingsDialog`)
- Convert all 17+ `SettingRow + Switch` instances to `SwitchSettingRow`
- Add `⌘1`-`⌘9` keyboard shortcuts to switch tabs by index in `TabbedDialog`
- Existing tests pass with at most import-path updates
- New unit tests cover `TabbedDialog`, `useDialogTabState`, `SwitchSettingRow`, and `SettingsPanel`

## 4. Non-Goals

- **No URL-based deep linking** — that belongs in spec `dialog-url-deeplinks`
- **No dev playground additions** — that belongs in spec `dev-playground-settings-page`
- **No migration of `TasksDialog`/`RelayDialog`/`MeshDialog`/other dialogs** to `TabbedDialog` — those don't currently use `NavigationLayout`. They have different shapes (tasks list, message bus inspector, topology graph) and adopting `TabbedDialog` for them is a separate decision.
- **No search inside settings** — planned but separate
- **No tab-content lazy loading** beyond what already exists for extension tabs (which use `React.lazy` via the extension registry)
- **No form library adoption** (TanStack Form etc.) — see ADR 0142
- **No unsaved-changes / dirty-state warnings** — separate concern
- **No new accessibility features** beyond what `NavigationLayout` already provides — though the hook will _enforce_ `aria-label` on `SwitchSettingRow` (currently optional)
- **No changes to `NavigationLayout` itself** — `TabbedDialog` is built **on top of** the existing primitive, not as a replacement
- **No promotion of `useCopyFeedback` or `CopyButton`** — those are handled by `settings-dialog-file-splits`
- **No changes to the contribution registry** (`extension-registry.ts`) — `TabbedDialog` consumes `useSlotContributions` as it exists today

## 5. Technical Dependencies

| Dependency                         | Version   | Notes                                                         |
| ---------------------------------- | --------- | ------------------------------------------------------------- |
| React                              | ^19       | Using ref-as-prop pattern; no `forwardRef` for new components |
| TypeScript                         | ^5.9      | Generic `<T extends string>` for type-safe tab IDs            |
| `motion`                           | ^11+      | Already used by `NavigationLayout`'s active-pill animation    |
| `lucide-react`                     | latest    | `LucideIcon` type for tab icons                               |
| Vitest + `@testing-library/react`  | ^3 / ^16  | For new unit tests                                            |
| Existing `NavigationLayout` family | (in repo) | The primitive `TabbedDialog` wraps                            |
| Existing `ResponsiveDialog` family | (in repo) | The dialog primitive `TabbedDialog` wraps                     |
| Existing `useSlotContributions`    | (in repo) | For extension-tab merging                                     |

No new runtime dependencies. No version bumps. No new dev dependencies.

## 6. Detailed Design

### 6.1 Architecture

```
┌──────────────────────────────────────────────────────────┐
│  shared/ui/ (NEW)                                        │
│                                                          │
│  TabbedDialog<T extends string>                          │
│    ├── ResponsiveDialog                                  │
│    │     └── ResponsiveDialogContent                     │
│    │           ├── ResponsiveDialogFullscreenToggle      │
│    │           └── NavigationLayout (existing)           │
│    │                 ├── NavigationLayoutDialogHeader    │
│    │                 │     ├── title (ReactNode)         │
│    │                 │     └── headerSlot (ReactNode)    │
│    │                 └── NavigationLayoutBody            │
│    │                       ├── NavigationLayoutSidebar   │
│    │                       │     ├── tabs[].map → Item   │
│    │                       │     └── sidebarExtras       │
│    │                       └── NavigationLayoutContent   │
│    │                             ├── tabs[].map → Panel  │
│    │                             └── extensionTabs       │
│    └── (ref to keyboard shortcut handler)                │
│                                                          │
│  SettingsPanel ← thin wrapper around                     │
│    NavigationLayoutPanel + space-y-4 + PanelHeader       │
│                                                          │
│  SwitchSettingRow ← thin wrapper around                  │
│    SettingRow + Switch                                   │
│                                                          │
│  shared/model/                                           │
│  useDialogTabState<T>({ open, initialTab, defaultTab })  │
│    ← React-recommended adjust-state-during-render        │
└──────────────────────────────────────────────────────────┘
                          ▲                ▲
                          │                │
              ┌───────────┴────┐   ┌──────┴────────┐
              │ SettingsDialog │   │  AgentDialog  │
              │   (~50 lines)  │   │  (~60 lines)  │
              └────────────────┘   └───────────────┘
```

### 6.2 `TabbedDialog` API

**File:** `apps/client/src/layers/shared/ui/tabbed-dialog.tsx`

```tsx
import { Suspense, type ComponentType, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFullscreenToggle,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  NavigationLayout,
  NavigationLayoutDialogHeader,
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
} from '@/layers/shared/ui';
import { useSlotContributions, useDialogTabState, type SlotId } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';

/** A single tab definition for `TabbedDialog`. */
export interface TabbedDialogTab<T extends string> {
  /** Stable tab ID — used for active-tab matching and deep-link target. */
  id: T;
  /** Sidebar label. */
  label: string;
  /** Sidebar icon. */
  icon: LucideIcon;
  /** Panel content component (parameterless — reads its own state via context/store/queries). */
  component: ComponentType;
  /** Optional per-tab header actions (e.g., a "Reset to defaults" button). */
  actions?: ReactNode;
}

export interface TabbedDialogProps<T extends string> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Title in the dialog header. ReactNode so it can include badges, breadcrumbs, etc. */
  title: ReactNode;
  /** Optional dialog description. Defaults to `sr-only`. */
  description?: string;
  /** Optional visible header content rendered below the title (e.g., breadcrumb). */
  headerSlot?: ReactNode;
  /** Default active tab when no `initialTab` is set. */
  defaultTab: T;
  /** Pre-navigate to this tab when the dialog opens. Honored on each open. */
  initialTab?: T | null;
  /** Built-in tabs. */
  tabs: TabbedDialogTab<T>[];
  /** Optional non-tab sidebar items (e.g., a button that opens a sub-dialog). */
  sidebarExtras?: ReactNode;
  /**
   * Optional extension slot ID. When set, contributions from the registry are merged
   * into the tab list (built-ins first, extensions appended).
   */
  extensionSlot?: Extract<SlotId, 'settings.tabs'>;
  /** Override max-width. Defaults to `max-w-2xl`. */
  maxWidth?: string;
  /** Override min content height. Defaults to `min-h-[280px]`. */
  minHeight?: string;
  /** data-testid for browser tests. */
  testId?: string;
}

/**
 * Tabbed dialog primitive — responsive sidebar navigation over a `ResponsiveDialog`,
 * with mobile drill-in, animated active-tab pill, keyboard shortcuts (⌘1–⌘9),
 * extension-slot support, and deep-link sync via `useDialogTabState`.
 *
 * Used by SettingsDialog and AgentDialog. Built on top of `NavigationLayout`.
 */
export function TabbedDialog<T extends string>({
  open,
  onOpenChange,
  title,
  description,
  headerSlot,
  defaultTab,
  initialTab,
  tabs,
  sidebarExtras,
  extensionSlot,
  maxWidth = 'max-w-2xl',
  minHeight = 'min-h-[280px]',
  testId,
}: TabbedDialogProps<T>) {
  const [activeTab, setActiveTab] = useDialogTabState<T>({
    open,
    initialTab: initialTab ?? null,
    defaultTab,
  });
  const extensionTabs = useSlotContributions(extensionSlot ?? 'settings.tabs');
  const allTabs = extensionSlot ? [...tabs, ...extensionTabs.map(toTabbedDialogTab)] : tabs;

  // ⌘1–⌘9 keyboard shortcuts to switch tabs by index
  useTabKeyboardShortcuts({ enabled: open, tabs: allTabs, setActiveTab });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid={testId}
        className={cn('max-h-[85vh] gap-0 p-0', maxWidth)}
      >
        <NavigationLayout value={activeTab} onValueChange={(v) => setActiveTab(v as T)}>
          <ResponsiveDialogFullscreenToggle />
          <NavigationLayoutDialogHeader>
            <ResponsiveDialogTitle className="text-sm font-medium">{title}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription
              className={description ? 'text-muted-foreground text-xs' : 'sr-only'}
            >
              {description ?? 'Dialog'}
            </ResponsiveDialogDescription>
            {headerSlot}
          </NavigationLayoutDialogHeader>

          <NavigationLayoutBody>
            <NavigationLayoutSidebar>
              {allTabs.map((tab) => (
                <NavigationLayoutItem key={tab.id} value={tab.id} icon={tab.icon}>
                  {tab.label}
                </NavigationLayoutItem>
              ))}
              {sidebarExtras}
            </NavigationLayoutSidebar>

            <NavigationLayoutContent className={cn(minHeight, 'p-4')}>
              {allTabs.map((tab) => {
                const TabComponent = tab.component;
                return (
                  <NavigationLayoutPanel key={tab.id} value={tab.id}>
                    <div className="space-y-4">
                      <NavigationLayoutPanelHeader actions={tab.actions}>
                        {tab.label}
                      </NavigationLayoutPanelHeader>
                      <Suspense fallback={<TabSuspenseFallback />}>
                        <TabComponent />
                      </Suspense>
                    </div>
                  </NavigationLayoutPanel>
                );
              })}
            </NavigationLayoutContent>
          </NavigationLayoutBody>
        </NavigationLayout>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function TabSuspenseFallback() {
  return <div className="text-muted-foreground py-8 text-center text-sm">Loading…</div>;
}

/** Convert a `SettingsTabContribution` from the registry into a `TabbedDialogTab`. */
function toTabbedDialogTab<T extends string>(contribution: {
  id: string;
  label: string;
  icon: LucideIcon;
  component: ComponentType;
}): TabbedDialogTab<T> {
  return {
    id: contribution.id as T,
    label: contribution.label,
    icon: contribution.icon,
    component: contribution.component,
  };
}
```

Notes:

- `TabbedDialog` is **always** wrapped in `Suspense` per panel, even for non-lazy tabs. Suspense with a non-lazy component is a no-op (just renders children immediately), so this is harmless and lets the same code path serve extension tabs (which _are_ lazy).
- The `extensionSlot` type is currently restricted to `'settings.tabs'` because that's the only registered slot today. The type can be widened in a follow-up when `'agent-dialog.tabs'` is added.
- The widget intentionally **does not** own the title styling — `<ResponsiveDialogTitle>` is rendered with the same `text-sm font-medium` it has today. If a consumer needs to customize that, they can pass a styled `ReactNode` as `title`.
- `sidebarExtras` is rendered **after** the tab list (matching the current `SettingsDialog` placement of `RemoteAccessAction`).

### 6.3 `useDialogTabState` hook

**File:** `apps/client/src/layers/shared/model/use-dialog-tab-state.ts`

```ts
import { useState } from 'react';

interface UseDialogTabStateOptions<T extends string> {
  /** Whether the dialog is currently open. Used to detect open transitions. */
  open: boolean;
  /** Optional pre-targeted tab. Honored each time the dialog opens. */
  initialTab: T | null;
  /** Fallback tab when no `initialTab` is set. */
  defaultTab: T;
}

/**
 * Tab state for tabbed dialogs with deep-link support.
 *
 * Uses the React-recommended "adjust state during render" pattern (not `useEffect`)
 * to sync `initialTab` into local state when the dialog opens. This avoids the
 * unnecessary re-render of the `useEffect` approach and matches the pattern
 * recommended in the React 19 docs for "deriving state from props."
 *
 * @param options.open - Whether the dialog is open
 * @param options.initialTab - Pre-targeted tab from deep link or store
 * @param options.defaultTab - Fallback tab
 * @returns `[activeTab, setActiveTab]` tuple, like `useState`
 */
export function useDialogTabState<T extends string>({
  open,
  initialTab,
  defaultTab,
}: UseDialogTabStateOptions<T>): [T, (tab: T) => void] {
  const [activeTab, setActiveTab] = useState<T>(initialTab ?? defaultTab);
  const [prevOpen, setPrevOpen] = useState(open);

  // Adjust state during render (React 19 recommended pattern)
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
  }

  return [activeTab, setActiveTab];
}
```

This hook is **the** convergence point. After this spec, both `SettingsDialog` and `AgentDialog` use it identically. Future tabbed dialogs get correct deep-link semantics for free.

### 6.4 `SettingsPanel` shorthand

**Decision: don't ship a separate `SettingsPanel` component.** When `TabbedDialog` is doing the panel rendering itself (via the `tabs[].component` loop), no consumer needs to write `<NavigationLayoutPanel>` boilerplate anymore. The original motivation for `SettingsPanel` (eliminating ~13 instances of the `<div className="space-y-4"><PanelHeader>X</PanelHeader>...</div>` wrapper) is fully addressed by `TabbedDialog` rendering that wrapper internally.

We **do** keep `SettingsPanel` as a planned export for cases where someone uses `NavigationLayout` directly without `TabbedDialog`. The dev playground's `NavigationShowcases.tsx` is one such consumer. But the implementation is simply:

```tsx
// shared/ui/settings-panel.tsx
import type { ReactNode } from 'react';
import { NavigationLayoutPanel, NavigationLayoutPanelHeader } from './navigation-layout';

interface SettingsPanelProps {
  /** Tab ID matching a `NavigationLayoutItem` value. */
  value: string;
  /** Panel title shown in the header. */
  title: string;
  /** Optional header actions (e.g., a "Reset" button). */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Settings panel shorthand — wraps `NavigationLayoutPanel` with the
 * standard `space-y-4` + `NavigationLayoutPanelHeader` boilerplate.
 *
 * Use inside a bare `NavigationLayout` (without `TabbedDialog`).
 * `TabbedDialog` already renders this wrapper internally — you don't
 * need to use this when using `TabbedDialog`.
 */
export function SettingsPanel({ value, title, actions, children }: SettingsPanelProps) {
  return (
    <NavigationLayoutPanel value={value}>
      <div className="space-y-4">
        <NavigationLayoutPanelHeader actions={actions}>{title}</NavigationLayoutPanelHeader>
        {children}
      </div>
    </NavigationLayoutPanel>
  );
}
```

### 6.5 `SwitchSettingRow` shorthand

**File:** add to existing `apps/client/src/layers/shared/ui/setting-row.tsx`

```tsx
import { SettingRow } from './setting-row'; // existing
import { Switch } from './switch';

interface SwitchSettingRowProps {
  /** Label text. */
  label: string;
  /** Description text below the label. */
  description: string;
  /** Switch checked state. */
  checked: boolean;
  /** Switch onCheckedChange handler. */
  onCheckedChange: (checked: boolean) => void;
  /** Optional aria-label override. Defaults to the label. */
  ariaLabel?: string;
  /** Optional className for the row. */
  className?: string;
  /** Optional disabled state. */
  disabled?: boolean;
}

/**
 * Switch + label row shorthand — the most common settings pattern.
 *
 * Wraps a `Switch` inside a `SettingRow` with consistent `aria-label`
 * defaulting and disabled state forwarding.
 */
export function SwitchSettingRow({
  label,
  description,
  checked,
  onCheckedChange,
  ariaLabel,
  className,
  disabled,
}: SwitchSettingRowProps) {
  return (
    <SettingRow label={label} description={description} className={className}>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
      />
    </SettingRow>
  );
}
```

Add to `shared/ui/index.ts` barrel.

### 6.6 ⌘1-⌘9 keyboard shortcuts

`NavigationLayout` already manages a `role="tablist"` with arrow-key navigation (Up/Down/Home/End). Adding number-key shortcuts is a small extension. Implementation lives **inside** `TabbedDialog` (not `NavigationLayout`) so that the existing primitive stays focused on the layout/animation concern.

```tsx
// inside tabbed-dialog.tsx
function useTabKeyboardShortcuts<T extends string>({
  enabled,
  tabs,
  setActiveTab,
}: {
  enabled: boolean;
  tabs: TabbedDialogTab<T>[];
  setActiveTab: (tab: T) => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      const num = parseInt(e.key, 10);
      if (Number.isNaN(num) || num < 1 || num > 9) return;
      const tab = tabs[num - 1];
      if (!tab) return;
      e.preventDefault();
      setActiveTab(tab.id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, tabs, setActiveTab]);
}
```

Caveats documented in the TSDoc:

- Shortcuts only fire when the dialog is open (`enabled` from `open` prop)
- Limited to 9 tabs (⌘1-⌘9). Tabs beyond index 9 have no shortcut.
- ⌘1 maps to the _first_ tab including extension tabs in the merged list (because they're appended last, this means built-ins always have shortcuts and extensions get them only if there's room)
- Conflicts with browser tab-switching shortcuts (⌘1-⌘9 in Chrome) are real but acceptable inside a focused dialog. The dialog has focus, so the browser doesn't see the shortcut. Verified manually before merging.

### 6.7 Refactoring `SettingsDialog`

**Pre-condition:** `settings-dialog-file-splits` has landed. `AppearanceTab`, `PreferencesTab`, `StatusBarTab`, and `RemoteAccessAction` all exist as standalone components.

**Issue: `ServerTab` and `AdvancedTab` don't fit the parameterless pattern.**

| Tab           | Today's signature                                               | Why it's parametric                                                      |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ServerTab`   | `<ServerTab config={config} isLoading={isLoading} />`           | Reads `config` from a parent `useQuery` to avoid duplicate network calls |
| `AdvancedTab` | `<AdvancedTab onResetComplete={...} onRestartComplete={...} />` | Calls back to parent to open `ServerRestartOverlay`                      |

**Resolution.** Convert both to parameterless self-contained components in this spec:

1. **`ServerTab`** — move its `useQuery(['config'])` _inside_ the component. This duplicates the query call between `ServerTab` and any other tab that also reads config (`ToolsTab`, `AdvancedTab`, `ExternalMcpCard`). TanStack Query handles this with **request deduplication** — multiple components calling `useQuery` with the same key share a single network request and cache entry. No actual duplicate requests fire. The duplication is purely a code-organization concern, and centralizing it in tabs means each tab is independently usable in the playground (spec 4) and in tests.

2. **`AdvancedTab`** — lift `restartOverlayOpen` state into the app store's `panels` slice. New fields: `restartOverlayOpen: boolean` and `setRestartOverlayOpen: (open: boolean) => void`. `AdvancedTab` calls `setRestartOverlayOpen(true)` directly when reset/restart completes. The `ServerRestartOverlay` becomes a top-level dialog contribution registered in `DIALOG_CONTRIBUTIONS` (matching the existing pattern for `settings`, `tasks`, `relay`, etc.).

After both conversions:

```tsx
// SettingsDialog.tsx (~50 lines)
import { TabbedDialog, type TabbedDialogTab } from '@/layers/shared/ui';
import { useState } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { Palette, Settings2, LayoutList, Server, Wrench, Radio, Bot, Cog } from 'lucide-react';
import type { SettingsTab } from '@/layers/shared/model';
import { AppearanceTab } from './tabs/AppearanceTab';
import { PreferencesTab } from './tabs/PreferencesTab';
import { StatusBarTab } from './tabs/StatusBarTab';
import { ServerTab } from './ServerTab';
import { ToolsTab } from './ToolsTab';
import { ChannelsTab } from './ChannelsTab';
import { AgentsTab } from './AgentsTab';
import { AdvancedTab } from './AdvancedTab';
import { RemoteAccessAction } from './RemoteAccessAction';
import { TunnelDialog } from './TunnelDialog';

const SETTINGS_TABS: TabbedDialogTab<SettingsTab>[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette, component: AppearanceTab },
  { id: 'preferences', label: 'Preferences', icon: Settings2, component: PreferencesTab },
  { id: 'statusBar', label: 'Status Bar', icon: LayoutList, component: StatusBarTab },
  { id: 'server', label: 'Server', icon: Server, component: ServerTab },
  { id: 'tools', label: 'Tools', icon: Wrench, component: ToolsTab },
  { id: 'channels', label: 'Channels', icon: Radio, component: ChannelsTab },
  { id: 'agents', label: 'Agents', icon: Bot, component: AgentsTab },
  { id: 'advanced', label: 'Advanced', icon: Cog, component: AdvancedTab },
];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Tabbed Settings dialog (consumer of TabbedDialog primitive). */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const settingsInitialTab = useAppStore((s) => s.settingsInitialTab);
  const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false);

  return (
    <>
      <TabbedDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Settings"
        description="Application settings"
        defaultTab="appearance"
        initialTab={settingsInitialTab}
        tabs={SETTINGS_TABS}
        sidebarExtras={<RemoteAccessAction onClick={() => setTunnelDialogOpen(true)} />}
        extensionSlot="settings.tabs"
        testId="settings-dialog"
      />
      <TunnelDialog open={tunnelDialogOpen} onOpenChange={setTunnelDialogOpen} />
    </>
  );
}
```

Note: `ServerRestartOverlay` is no longer a sibling of `SettingsDialog` — it lives in `DialogHost` as a registered contribution. AdvancedTab dispatches its open state to the store directly.

### 6.8 Refactoring `AgentDialog`

`AgentDialog` is more complex because its tabs **need shared state** — the loaded `agent` and the `handleUpdate` callback. Today these are passed as props directly to each tab. With the parameterless `TabbedDialogTab.component` shape, we need a different way to plumb data into tabs.

**Approach: React Context.** Create an `AgentDialogContext` that holds `{ agent, projectPath, onUpdate, onPersonalityUpdate }`. Each tab is wrapped in a thin "Consumer" component that reads context and forwards props to the existing `IdentityTab`/`PersonalityTab`/`ToolsTab`/`ChannelsTab` (which keep their current parameterized signatures so they remain testable in isolation).

```tsx
// agent-settings/model/agent-dialog-context.tsx
import { createContext, useContext, type ReactNode } from 'react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

interface AgentDialogContextValue {
  agent: AgentManifest;
  projectPath: string;
  onUpdate: (updates: Partial<AgentManifest>) => void;
  onPersonalityUpdate: (
    updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }
  ) => void;
}

const AgentDialogContext = createContext<AgentDialogContextValue | undefined>(undefined);

export function AgentDialogProvider({
  value,
  children,
}: {
  value: AgentDialogContextValue;
  children: ReactNode;
}) {
  return <AgentDialogContext.Provider value={value}>{children}</AgentDialogContext.Provider>;
}

export function useAgentDialog(): AgentDialogContextValue {
  const ctx = useContext(AgentDialogContext);
  if (!ctx) throw new Error('useAgentDialog must be used within an AgentDialogProvider');
  return ctx;
}
```

Then each tab gets a tiny consumer wrapper:

```tsx
// agent-settings/ui/IdentityTabConsumer.tsx
import { useAgentDialog } from '../model/agent-dialog-context';
import { IdentityTab } from './IdentityTab';

export function IdentityTabConsumer() {
  const { agent, onUpdate } = useAgentDialog();
  return <IdentityTab agent={agent} onUpdate={onUpdate} />;
}
```

Four such consumer wrappers (one per tab). The original `IdentityTab`/`PersonalityTab`/`ToolsTab`/`ChannelsTab` files don't change — they keep their explicit prop signatures, which means existing tests for them keep passing without modification.

`AgentDialog.tsx` becomes:

```tsx
// AgentDialog.tsx (~60 lines)
import { useCallback } from 'react';
import { FolderOpen, User, Sparkles, Wrench, Radio } from 'lucide-react';
import { useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import { TabbedDialog, type TabbedDialogTab, PathBreadcrumb } from '@/layers/shared/ui';
import type { AgentDialogTab } from '@/layers/shared/model';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { AgentDialogProvider } from '../model/agent-dialog-context';
import { IdentityTabConsumer } from './IdentityTabConsumer';
import { PersonalityTabConsumer } from './PersonalityTabConsumer';
import { ToolsTabConsumer } from './ToolsTabConsumer';
import { ChannelsTabConsumer } from './ChannelsTabConsumer';
import { NoAgentFallback } from './NoAgentFallback';

const AGENT_TABS: TabbedDialogTab<AgentDialogTab>[] = [
  { id: 'identity', label: 'Identity', icon: User, component: IdentityTabConsumer },
  { id: 'personality', label: 'Personality', icon: Sparkles, component: PersonalityTabConsumer },
  { id: 'tools', label: 'Tools', icon: Wrench, component: ToolsTabConsumer },
  { id: 'channels', label: 'Channels', icon: Radio, component: ChannelsTabConsumer },
];

interface AgentDialogProps {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: AgentDialogTab;
}

/** Tabbed Agent configuration dialog (consumer of TabbedDialog primitive). */
export function AgentDialog({ projectPath, open, onOpenChange, initialTab }: AgentDialogProps) {
  const { data: agent } = useCurrentAgent(projectPath);
  const updateAgent = useUpdateAgent();

  const handleUpdate = useCallback(
    (updates: Partial<AgentManifest>) => updateAgent.mutate({ path: projectPath, updates }),
    [projectPath, updateAgent]
  );

  const handlePersonalityUpdate = useCallback(
    (updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }) =>
      updateAgent.mutate({ path: projectPath, updates }),
    [projectPath, updateAgent]
  );

  if (!agent)
    return <NoAgentFallback projectPath={projectPath} open={open} onOpenChange={onOpenChange} />;

  return (
    <AgentDialogProvider
      value={{
        agent,
        projectPath,
        onUpdate: handleUpdate,
        onPersonalityUpdate: handlePersonalityUpdate,
      }}
    >
      <TabbedDialog
        open={open}
        onOpenChange={onOpenChange}
        title={agent.name}
        description="Agent configuration"
        headerSlot={
          <div className="text-muted-foreground/60 flex items-center gap-1.5 pt-1">
            <FolderOpen className="size-3 flex-shrink-0" />
            <PathBreadcrumb path={projectPath} maxSegments={3} size="sm" />
          </div>
        }
        defaultTab="identity"
        initialTab={initialTab ?? null}
        tabs={AGENT_TABS}
        testId="agent-dialog"
      />
    </AgentDialogProvider>
  );
}
```

`NoAgentFallback` is the existing "agent not found" branch extracted into a small file for cleanliness.

### 6.9 `SwitchSettingRow` migrations

| File                                                                    |                                                    Instances |
| ----------------------------------------------------------------------- | -----------------------------------------------------------: |
| `apps/client/src/layers/features/settings/ui/tabs/PreferencesTab.tsx`   |                                                            8 |
| `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`           |                                                            2 |
| `apps/client/src/layers/features/settings/ui/AgentsTab.tsx`             |                                                 0–1 (verify) |
| `apps/client/src/layers/features/agent-settings/ui/CapabilitiesTab.tsx` |                                                  TBD (audit) |
| `apps/client/src/layers/features/settings/ui/ExternalMcpCard.tsx`       |                                        1 (rate-limit toggle) |
| `apps/client/src/layers/features/settings/ui/StatusBarTab.tsx`          |                                                dynamic count |
| `apps/client/src/layers/features/settings/ui/tools/ToolGroupRow.tsx`    | 0 (the switch lives next to other controls; not a clean fit) |
| **Total**                                                               |                                                      **17+** |

Each migration is a 5-line → 1-line collapse:

```tsx
// Before
<SettingRow label="Show timestamps" description="Display message timestamps in chat">
  <Switch checked={showTimestamps} onCheckedChange={setShowTimestamps} />
</SettingRow>

// After
<SwitchSettingRow
  label="Show timestamps"
  description="Display message timestamps in chat"
  checked={showTimestamps}
  onCheckedChange={setShowTimestamps}
/>
```

Audit `agent-settings/CapabilitiesTab.tsx` and convert any matches. Skip `ToolGroupRow.tsx` because the switch is one of multiple controls in a complex row layout — `SwitchSettingRow` doesn't fit and the row is already encapsulated.

### 6.10 Files modified

**New files:**

| File                                                                            | Purpose                                                   |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/client/src/layers/shared/ui/tabbed-dialog.tsx`                            | Main widget                                               |
| `apps/client/src/layers/shared/ui/settings-panel.tsx`                           | Standalone panel shorthand (for non-`TabbedDialog` users) |
| `apps/client/src/layers/shared/ui/__tests__/tabbed-dialog.test.tsx`             | New tests                                                 |
| `apps/client/src/layers/shared/ui/__tests__/settings-panel.test.tsx`            | New tests                                                 |
| `apps/client/src/layers/shared/ui/__tests__/switch-setting-row.test.tsx`        | New tests                                                 |
| `apps/client/src/layers/shared/model/use-dialog-tab-state.ts`                   | Hook                                                      |
| `apps/client/src/layers/shared/model/__tests__/use-dialog-tab-state.test.ts`    | New tests                                                 |
| `apps/client/src/layers/features/agent-settings/model/agent-dialog-context.tsx` | Context provider                                          |
| `apps/client/src/layers/features/agent-settings/ui/IdentityTabConsumer.tsx`     | Context consumer wrapper                                  |
| `apps/client/src/layers/features/agent-settings/ui/PersonalityTabConsumer.tsx`  | Context consumer wrapper                                  |
| `apps/client/src/layers/features/agent-settings/ui/ToolsTabConsumer.tsx`        | Context consumer wrapper                                  |
| `apps/client/src/layers/features/agent-settings/ui/ChannelsTabConsumer.tsx`     | Context consumer wrapper                                  |
| `apps/client/src/layers/features/agent-settings/ui/NoAgentFallback.tsx`         | Extracted "no agent" branch                               |

**Modified files:**

| File                                                                                       | Change                                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `apps/client/src/layers/shared/ui/setting-row.tsx`                                         | Add `SwitchSettingRow` export                                                                               |
| `apps/client/src/layers/shared/ui/index.ts`                                                | Export `TabbedDialog`, `TabbedDialogTab`, `TabbedDialogProps`, `SettingsPanel`, `SwitchSettingRow`          |
| `apps/client/src/layers/shared/model/index.ts`                                             | Export `useDialogTabState`                                                                                  |
| `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`                           | ~140 → ~50 lines, consume `TabbedDialog`                                                                    |
| `apps/client/src/layers/features/settings/ui/ServerTab.tsx`                                | Move `useQuery(['config'])` inside; drop `config`/`isLoading` props                                         |
| `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`                              | Drop `onResetComplete`/`onRestartComplete` props; dispatch to store directly; convert to `SwitchSettingRow` |
| `apps/client/src/layers/features/settings/ui/tabs/PreferencesTab.tsx`                      | Convert 8 rows to `SwitchSettingRow`                                                                        |
| `apps/client/src/layers/features/settings/ui/tabs/StatusBarTab.tsx`                        | Convert internal `StatusBarSettingRow` to `SwitchSettingRow`                                                |
| `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`                        | 177 → ~60 lines, consume `TabbedDialog`                                                                     |
| `apps/client/src/layers/shared/model/app-store/app-store-panels.ts`                        | Add `restartOverlayOpen` + `setRestartOverlayOpen` to panels slice                                          |
| `apps/client/src/layers/widgets/app-layout/model/dialog-contributions.ts`                  | Register `ServerRestartOverlay` as a dialog contribution                                                    |
| `apps/client/src/layers/widgets/app-layout/model/wrappers/ServerRestartOverlayWrapper.tsx` | New thin wrapper matching `DialogContribution` signature                                                    |

**Test files updated for import paths only:**

- `apps/client/src/layers/features/settings/__tests__/SettingsDialog.test.tsx`
- `apps/client/src/layers/features/agent-settings/__tests__/AgentDialog.test.tsx`
- Existing tests for `AdvancedTab`, `PreferencesTab` (if any), `IdentityTab`, etc. — no source changes, just verify they still pass

## 7. User Experience

**Functionally invisible to users**, with one new feature:

| Change                             | User-visible?                                            |
| ---------------------------------- | -------------------------------------------------------- |
| `TabbedDialog` extraction          | No — same chrome, same animations                        |
| `useDialogTabState` convergence    | No — both dialogs already deep-link correctly            |
| `SwitchSettingRow` migrations      | No — same UI, slightly improved `aria-label` consistency |
| `ServerTab` self-fetching          | No — TanStack Query dedupes                              |
| `AdvancedTab` store dispatch       | No — same overlay opens at the same moment               |
| **`⌘1`-`⌘9` keyboard shortcuts**   | **Yes — new**                                            |
| Improved `aria-label`s on Switches | Marginal — affects screen reader users                   |

The keyboard shortcut is the only new affordance. Power users (who match the **Kai Nakamura** persona — see `meta/personas/the-autonomous-builder.md`) will discover it via the existing keyboard shortcuts panel (`shortcuts-panel`) once we register the shortcuts there in a follow-up.

## 8. Testing Strategy

### 8.1 New tests

**`tabbed-dialog.test.tsx`** — covers:

```ts
describe('TabbedDialog', () => {
  it('renders all built-in tabs in the sidebar');
  it('renders the active panel content');
  it('switches active tab on sidebar click');
  it('honors initialTab on first open');
  it('honors initialTab when re-opened with a different value');
  it('falls back to defaultTab when initialTab is null');
  it('renders sidebarExtras after the tab list');
  it('merges extension contributions when extensionSlot is set');
  it('does not merge extension contributions when extensionSlot is undefined');
  it('renders the title and description');
  it('renders headerSlot under the title');
  it('switches tabs via ⌘1, ⌘2, ⌘3 keyboard shortcuts');
  it('ignores number key presses without modifier');
  it('does not respond to keyboard shortcuts when closed');
  it('caps shortcuts at ⌘9 (does not handle ⌘0)');
  it('passes maxWidth and minHeight overrides to the dialog');
  it('wraps panels in Suspense for lazy components');
  it('uses the testId prop for the dialog element');
});
```

**`use-dialog-tab-state.test.ts`** — covers:

```ts
describe('useDialogTabState', () => {
  it('returns defaultTab when initialTab is null');
  it('returns initialTab when set on initial render');
  it('updates activeTab when setActiveTab is called');
  it('re-syncs to initialTab when dialog re-opens with a new initialTab');
  it('does NOT re-sync when only setActiveTab is called (no open transition)');
  it('preserves activeTab across re-renders when open is stable');
});
```

**`switch-setting-row.test.tsx`** — covers:

```ts
describe('SwitchSettingRow', () => {
  it('renders label and description');
  it('forwards checked state to the Switch');
  it('calls onCheckedChange when toggled');
  it('uses label as default aria-label');
  it('honors custom ariaLabel override');
  it('forwards disabled state to the Switch');
});
```

**`settings-panel.test.tsx`** — covers:

```ts
describe('SettingsPanel', () => {
  it('renders title in the panel header');
  it('renders actions slot when provided');
  it('renders children inside a space-y-4 wrapper');
  it('renders nothing when value does not match the parent NavigationLayout active tab');
});
```

### 8.2 Existing tests

| Test                                     | Action                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SettingsDialog.test.tsx`                | Run as-is. If it asserts on inline panel structure, update to assert on `TabbedDialog` shell + tab IDs.                  |
| `AgentDialog.test.tsx`                   | Same.                                                                                                                    |
| `AdvancedTab.test.tsx`                   | Update for the prop signature change (no more `onResetComplete`/`onRestartComplete`); add a test for the store dispatch. |
| `ServerTab.test.tsx` (if exists)         | Update for the prop removal; mock the transport for the inline `useQuery`.                                               |
| Tab tests (`IdentityTab.test.tsx`, etc.) | Unchanged — these test the parameterized inner components, not the consumer wrappers.                                    |

### 8.3 E2E tests

Add one Playwright test that exercises the keyboard shortcut path:

```ts
test('⌘1 switches to the first tab in Settings dialog', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForSelector('[data-testid="settings-dialog"]');
  // Switch to a non-first tab first
  await page.getByRole('tab', { name: 'Tools' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Tools');
  // ⌘1 should jump back to Appearance
  await page.keyboard.press('Meta+1');
  await expect(page.getByRole('tabpanel')).toContainText('Theme');
});
```

Place under `apps/e2e/tests/settings/`.

## 9. Performance Considerations

**Negligible.**

- `TabbedDialog` adds one wrapper component layer between `SettingsDialog` and `NavigationLayout`. React's reconciler handles this in O(1).
- The `tabs.map` loop is identical to today's hand-written panel JSX — same number of `NavigationLayoutPanel` instances, same conditional rendering inside each.
- `useDialogTabState` does **less work** than the existing `useEffect` approach: no extra effect runs on each open, no extra re-render.
- TanStack Query dedupes the `ServerTab` `useQuery(['config'])` move — no extra network calls.
- The `⌘1`-`⌘9` keyboard handler attaches/detaches one `keydown` listener per dialog open. Negligible.
- `SwitchSettingRow` has identical render output to the inlined version (one extra function call).
- Bundle size: marginal increase (~2KB pre-gzip) for the new shared primitives, offset by ~150 lines of deleted duplication. Net: negligible.

## 10. Security Considerations

None.

- No new auth flows
- No new network calls
- No new state stored in localStorage or cookies
- The store-based `restartOverlayOpen` follows the same pattern as every other panel in the `panels` slice (see `app-store-panels.ts`)
- Keyboard shortcut handler scoped to the dialog being open — no global side effects

## 11. Documentation

- TSDoc on every export in `tabbed-dialog.tsx`, `use-dialog-tab-state.ts`, `setting-row.tsx` (new export), `settings-panel.tsx`, and the agent-dialog context
- Update `contributing/architecture.md` with a new section on "Tabbed dialog primitive" describing when to reach for `TabbedDialog` vs. `NavigationLayout` directly
- Update `contributing/state-management.md` with `useDialogTabState` as the canonical pattern for dialog deep-link sync
- No user-facing docs change
- Add a brief entry to the next changelog: "Settings: ⌘1-⌘9 keyboard shortcuts to switch between tabs"

## 12. Implementation Phases

**Phase 1 — Shared primitives** (no consumer changes yet)

1. Create `shared/model/use-dialog-tab-state.ts` + tests
2. Add `SwitchSettingRow` export to `shared/ui/setting-row.tsx` + tests
3. Create `shared/ui/settings-panel.tsx` + tests
4. Create `shared/ui/tabbed-dialog.tsx` + tests (including keyboard shortcuts)
5. Update `shared/ui/index.ts` and `shared/model/index.ts` barrels
6. Run `pnpm typecheck && pnpm vitest run apps/client/src/layers/shared`
7. Commit: `feat(shared): add TabbedDialog primitive and supporting hooks`

**Phase 2 — `SwitchSettingRow` migrations**

1. Audit all `<SettingRow>+<Switch>` instances with grep
2. Convert each to `<SwitchSettingRow>` (PreferencesTab, AdvancedTab, AgentsTab, CapabilitiesTab, ExternalMcpCard, StatusBarTab)
3. Run `pnpm typecheck && pnpm test -- --run`
4. Visual smoke: every converted row toggles correctly
5. Commit: `refactor(settings): use SwitchSettingRow shorthand for toggle rows`

**Phase 3 — `ServerTab` and `AdvancedTab` self-contained refactor**

1. Move `ServerTab`'s `useQuery(['config'])` inside the component; remove `config`/`isLoading` props
2. Add `restartOverlayOpen`/`setRestartOverlayOpen` to `app-store-panels.ts`
3. Refactor `AdvancedTab` to dispatch to store; remove callback props
4. Register `ServerRestartOverlay` as a dialog contribution (`DIALOG_CONTRIBUTIONS`); create `ServerRestartOverlayWrapper.tsx`
5. Remove the `ServerRestartOverlay` sibling from `SettingsDialog.tsx`
6. Run typecheck + tests + visual smoke (open Settings → Advanced → Reset → verify overlay still appears via DialogHost)
7. Commit: `refactor(settings): make ServerTab and AdvancedTab self-contained`

**Phase 4 — `SettingsDialog` consumes `TabbedDialog`**

1. Define `SETTINGS_TABS` array
2. Replace inline JSX with `<TabbedDialog>`
3. Verify `RemoteAccessAction` still appears via `sidebarExtras`
4. Verify extension tabs still appear via `extensionSlot="settings.tabs"`
5. Run typecheck + tests + visual smoke (every tab, deep-link via `openSettingsToTab`)
6. Commit: `refactor(settings): consume TabbedDialog primitive`

**Phase 5 — `AgentDialog` consumes `TabbedDialog`**

1. Create `agent-settings/model/agent-dialog-context.tsx`
2. Create the four `XxxTabConsumer.tsx` wrappers
3. Extract `NoAgentFallback.tsx` from `AgentDialog`
4. Refactor `AgentDialog` to consume `TabbedDialog` + provide context
5. Run typecheck + tests + visual smoke (open agent dialog, switch tabs, save changes)
6. Commit: `refactor(agent-settings): consume TabbedDialog primitive`

**Phase 6 — Verification gate**

1. `pnpm typecheck` — green
2. `pnpm test -- --run` — green
3. `pnpm lint` — green
4. `wc -l SettingsDialog.tsx AgentDialog.tsx` — both < 100
5. Manual smoke test of ⌘1-⌘9 in both dialogs
6. Manual smoke test of every tab in both dialogs
7. Manual smoke test of deep-link from store (`openSettingsToTab('tools')`, `openAgentDialogToTab('personality')`)
8. Run `pnpm vitest run apps/client/src/layers/shared/ui/__tests__/tabbed-dialog.test.tsx` for new test coverage
9. Optional: run the new Playwright keyboard shortcut test

## 13. Open Questions

**Q1. Should `TabbedDialog` accept a `keyboardShortcuts` prop to opt out of `⌘1`-`⌘9`?**

Default: shortcuts always on for `TabbedDialog`. **Open** — decide during implementation if any consumer needs to disable them. If yes, add `keyboardShortcuts?: boolean` defaulting to `true`. The Agent dialog and Settings dialog both want them, so the default is correct.

**Q2. Should the extension slot type widen to `'settings.tabs' | 'agent-dialog.tabs'` in this spec?**

**No** — only `settings.tabs` exists today. Adding `agent-dialog.tabs` to the registry is a separate spec (extension authoring for agent settings). Restrict this spec to what's actually used.

**Q3. Should the inner `XxxTabConsumer` files for `AgentDialog` live in a `consumers/` subdirectory?**

**Recommendation: yes**, place them under `apps/client/src/layers/features/agent-settings/ui/consumers/` to keep the directory clean. Decision deferrable until implementation — may also be acceptable to leave them at the top level if there are only four.

**Q4. Should `ServerRestartOverlay` continue to be a fullscreen overlay or move into the standard `DialogContribution` flow?**

**Move it.** `ServerRestartOverlay` is already a sibling of `SettingsDialog` today, and registering it as a `DialogContribution` in `DIALOG_CONTRIBUTIONS` gives us the same outcome with less code. The overlay component itself doesn't change — only how it's mounted.

**Q5. Should `SwitchSettingRow` enforce `aria-label`?**

Currently the Switch component accepts `aria-label` as optional. The `SwitchSettingRow` defaults `aria-label` to `label`, which is _almost always_ the right choice. **Decision: default to `label`, allow override via `ariaLabel` prop**, do not enforce. (Enforcement at the type level would require a second prop for the override, complicating the API.)

**Q6. Should `useDialogTabState` accept a callback for deep-link clearing?**

Today `setSettingsOpen(false)` in the panels slice clears `settingsInitialTab`. If we use `useDialogTabState`, the hook doesn't know about the store. **Resolution:** the hook is purely UI-state; the store-clear-on-close lives in the store action. They're orthogonal. No callback needed.

**Q7. Does the React Context approach for `AgentDialog` create test friction?**

Today `IdentityTab.test.tsx` (if it exists) renders `<IdentityTab agent={mockAgent} onUpdate={vi.fn()} />`. After this spec, the consumer wrapper `IdentityTabConsumer` requires the context provider. **Resolution:** existing tests on `IdentityTab` _don't change_ — they still test the parameterized inner component. New tests for `IdentityTabConsumer` (if desired) wrap in `<AgentDialogProvider>`. The split keeps both surfaces independently testable.

## 14. Related ADRs

- **ADR 0002 — Adopt Feature-Sliced Design** (`decisions/0002-adopt-feature-sliced-design.md`) — `TabbedDialog` placement in `shared/ui/` follows the layer rules (no feature imports). The agent-settings context provider stays in `features/agent-settings/model/`.
- **ADR 0008 — Promote shared components for cross-feature reuse** (`decisions/0008-promote-shared-components-for-cross-feature-reuse.md`) — Justifies extracting `TabbedDialog`, `SettingsPanel`, `SwitchSettingRow`, and `useDialogTabState` to `shared/`. Two production consumers is sufficient justification per the ADR's "rule of two."
- **ADR 0142 — Defer form library adoption** (`decisions/0142-defer-form-library-adoption.md`) — Reinforces that `SwitchSettingRow` is a styling shorthand, not a form library. We're not adopting react-hook-form or TanStack Form here.
- **ADR 0116 — Entity layer Zustand store for cross-feature coordination** (`decisions/0116-entity-layer-zustand-store-for-cross-feature-coordination.md`) — Pattern reference for the `restartOverlayOpen` store dispatch.
- **ADR 0005 — Zustand for UI state, TanStack Query for server state** (`decisions/0005-zustand-ui-state-tanstack-query-server-state.md`) — Justifies the `restartOverlayOpen` placement (UI state → Zustand panels slice).

## 15. References

### Internal

- `specs/settings-dialog-file-splits/` — **Prerequisite spec.** Must land first.
- `specs/dialog-url-deeplinks/` (planned) — Builds on this spec by adding URL search-param deep linking
- `specs/dev-playground-settings-page/` (planned) — Builds on this spec by playgrounding tabs in isolation
- `apps/client/src/layers/shared/ui/navigation-layout.tsx` — Underlying primitive that `TabbedDialog` wraps
- `apps/client/src/layers/shared/ui/responsive-dialog.tsx` — Dialog primitive with mobile drawer fallback
- `apps/client/src/layers/shared/model/extension-registry.ts` — `useSlotContributions` for extension tabs
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — Consumer A
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` — Consumer B
- `.claude/rules/fsd-layers.md` — Layer rules
- `.claude/rules/components.md` — Component patterns
- `.claude/rules/file-size.md` — Size targets
- `meta/personas/the-autonomous-builder.md` — Kai Nakamura persona (keyboard shortcut user)

### External

- React 19 docs — "You might not need an effect" (https://react.dev/learn/you-might-not-need-an-effect) — Justifies the adjust-state-during-render pattern in `useDialogTabState`
- React 19 ref-as-prop pattern — used by `TabbedDialog`'s internal components

### Pattern reference

- `specs/form-field-standardization/` — Pattern for promoting a row primitive to `shared/ui` (similar shape: extract `SettingRow` from inline duplication)
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx:53-59` — The "adjust state during render" pattern used as the seed for `useDialogTabState`
