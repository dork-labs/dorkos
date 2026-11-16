---
slug: shell-level-right-panel
number: 237
created: 2026-04-12
status: draft
---

# Shell-Level Right Panel Infrastructure

**Status:** Draft
**Authors:** Claude Code, 2026-04-12
**Ideation:** `specs/settings-ui-ux-disambiguation/01-ideation.md`

---

## Overview

Add a shell-level right panel to AppShell that wraps the `<Outlet />` in a horizontal `PanelGroup`. The right panel is a multi-occupancy container driven by the extension registry: any feature can register a tab via the new `rightpanel` contribution slot. The existing canvas feature becomes the first right-panel tab, migrated from its current page-level `PanelGroup` in SessionPage.

This spec covers only the infrastructure layer -- the PanelGroup, contribution slot, container component, toggle button, keyboard shortcut, state management, canvas migration, and SessionPage simplification. The Agent Hub component that will occupy the second tab is covered by Spec 238.

## Background / Problem Statement

The extension registry (Spec 182) documents a known gap: "no extensible slot for persistent right-side UI." Today, the only right-panel content is the AgentCanvas, which is tightly coupled to SessionPage via an internal `PanelGroup`. This creates three problems:

1. **No right panel on non-session routes.** The canvas only exists on `/session`. Future right-panel content (Agent Hub, extension panels) would need to be re-implemented per-page.
2. **No multi-occupancy.** The canvas owns the entire right area. Adding a second panel requires either replacing the canvas or nesting another `PanelGroup`.
3. **No extension point.** Third-party extensions and built-in features have no way to contribute persistent right-side UI alongside the canvas.

Every major extensible editor (VS Code, Obsidian, JetBrains) solves this by placing the right panel at the shell level with a contribution-based tab system. This spec applies the same pattern using the existing extension registry infrastructure.

## Goals

- Add a horizontal `PanelGroup` to AppShell wrapping the `<Outlet />` and a conditional right panel
- Define a new `rightpanel` contribution slot in the extension registry with typed `RightPanelContribution` interface
- Build a `RightPanelContainer` component that renders the active tab's component with a minimal icon tab bar
- Place a toggle button in the header (top-right, symmetric with `SidebarTrigger` on the left)
- Register a keyboard shortcut for toggling the right panel
- Migrate AgentCanvas from SessionPage's internal `PanelGroup` to become a right-panel contribution
- Simplify SessionPage to render only `ChatPanel` (no `PanelGroup`)
- Add a Zustand state slice for right panel open/closed state and active tab
- Persist panel state to localStorage following established canvas persistence patterns
- Collapse the right panel to a Sheet on mobile (768px breakpoint)

## Non-Goals

- **Agent Hub component** -- its design, internal layout, entry points, and context menu changes are Spec 238
- **Third-party extension loading** -- the `rightpanel` slot uses the same registration API as all 8 existing slots; Phase 3 extension loading is out of scope
- **Global settings dialog changes** -- the "App Settings" rename and tooltip changes are Spec 238
- **Context menu simplification** -- collapsing "Manage agent" / "Edit settings" into "Agent profile" is Spec 238
- **Server-side changes** -- this is a pure client-side spec
- **Left sidebar modifications** -- the left sidebar remains unchanged
- **New routes or URL parameters** -- the right panel is controlled by Zustand state, not URL params

## Technical Dependencies

| Dependency               | Version  | Purpose                                                                |
| ------------------------ | -------- | ---------------------------------------------------------------------- |
| `react-resizable-panels` | existing | Shell-level horizontal PanelGroup                                      |
| `zustand`                | `^5.0.0` | Right panel state slice (matches existing app-store pattern)           |
| `lucide-react`           | existing | `PanelRight` / `PanelRightClose` icons for toggle button               |
| `motion/react`           | existing | Toggle button micro-interaction (spring scale, matching canvas toggle) |
| `@tanstack/react-router` | existing | `useRouterState` for route-aware `visibleWhen` evaluation              |

No new dependencies required.

## Detailed Design

### 1. Component Hierarchy

```
AppShell
├── Sidebar (left, unchanged)
└── SidebarInset
    ├── header
    │   ├── SidebarTrigger (left)
    │   ├── Separator
    │   ├── [route-specific header content]  ← animated via useHeaderSlot
    │   └── RightPanelToggle (right)         ← NEW, always rendered
    └── main
        └── PanelGroup (horizontal)          ← NEW, wraps Outlet
            ├── Panel (id="main-content", order=1)
            │   └── Outlet                   ← route pages render here
            │       ├── SessionPage (just ChatPanel, no PanelGroup)
            │       ├── DashboardPage (unchanged)
            │       ├── AgentsPage (unchanged)
            │       └── ...
            ├── PanelResizeHandle            ← only when right panel open
            └── Panel (id="right-panel", order=2)  ← only when right panel open
                └── RightPanelContainer
                    ├── Tab bar (icons, hidden when single tab)
                    └── Active tab component
                        ├── AgentCanvas (when on /session)
                        └── [Future: Agent Hub, extension panels]
```

### 2. New and Modified Files

#### New Files

| File                                                               | Layer    | Description                                              |
| ------------------------------------------------------------------ | -------- | -------------------------------------------------------- |
| `layers/features/right-panel/ui/RightPanelContainer.tsx`           | features | Container that renders tab bar + active tab component    |
| `layers/features/right-panel/ui/RightPanelToggle.tsx`              | features | Toggle button for header (symmetric with SidebarTrigger) |
| `layers/features/right-panel/ui/RightPanelTabBar.tsx`              | features | Minimal icon tab bar, hidden when single contribution    |
| `layers/features/right-panel/model/use-right-panel-shortcut.ts`    | features | Keyboard shortcut handler (`Cmd+.` / `Ctrl+.`)           |
| `layers/features/right-panel/model/use-right-panel-persistence.ts` | features | localStorage hydration hook for panel state              |
| `layers/features/right-panel/index.ts`                             | features | Barrel exports                                           |
| `layers/shared/model/app-store/app-store-right-panel.ts`           | shared   | Zustand slice for right panel state                      |

#### Modified Files

| File                                                  | Change                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `AppShell.tsx`                                        | Wrap `<Outlet />` in `PanelGroup`, add `RightPanelToggle` to header, add `useRightPanelShortcut()` call |
| `layers/shared/model/extension-registry.ts`           | Add `RIGHT_PANEL` to `SLOT_IDS`, add `RightPanelContribution` interface, extend `SlotContributionMap`   |
| `layers/shared/model/app-store/app-store-types.ts`    | Add `RightPanelSlice` to `AppState` intersection                                                        |
| `layers/shared/model/app-store/app-store-helpers.ts`  | Add `readRightPanelState` / `writeRightPanelState` helpers and `BOOL_KEYS.rightPanelOpen`               |
| `layers/shared/lib/constants.ts`                      | Add `STORAGE_KEYS.RIGHT_PANEL_STATE`                                                                    |
| `apps/client/src/app/init-extensions.ts`              | Register canvas as a right-panel contribution                                                           |
| `layers/widgets/session/ui/SessionPage.tsx`           | Remove `PanelGroup`, render only `ChatPanel`                                                            |
| `layers/features/canvas/ui/AgentCanvas.tsx`           | Remove `Panel`/`PanelResizeHandle` wrapper, export `CanvasBody` as the contribution component           |
| `layers/features/canvas/index.ts`                     | Export `CanvasContent` (the contribution component)                                                     |
| `layers/features/top-nav/ui/SessionHeader.tsx`        | Remove `CanvasToggle` import (toggle moves to AppShell header)                                          |
| `layers/features/canvas/model/use-canvas-shortcut.ts` | Repurpose as right-panel toggle (or remove if shortcut is unified)                                      |

### 3. Extension Registry Changes

Add the new slot to `extension-registry.ts`:

```typescript
export const SLOT_IDS = {
  // ... existing 8 slots
  RIGHT_PANEL: 'right-panel',
} as const;
```

New contribution interface:

```typescript
export interface RightPanelContribution extends BaseContribution {
  /** Human-readable tab title (used in tooltip). */
  title: string;
  /** Lucide icon component for the tab bar button. */
  icon: LucideIcon;
  /** React component to render when this tab is active. */
  component: ComponentType;
  /**
   * Return false to hide this tab from the panel.
   * Evaluated reactively by RightPanelContainer on every route change.
   * The container passes the current pathname (from useRouterState) so
   * predicates stay router-aware without calling hooks directly.
   * Example: canvas returns false when not on the /session route.
   */
  visibleWhen?: (ctx: { pathname: string }) => boolean;
}
```

Extend the `SlotContributionMap` interface:

```typescript
export interface SlotContributionMap {
  // ... existing 8 entries
  'right-panel': RightPanelContribution;
}
```

### 4. Canvas Registration in `initializeExtensions()`

The canvas becomes a right-panel contribution instead of being hardcoded into SessionPage:

```typescript
// In init-extensions.ts
import { lazy } from 'react';
import { PanelRight } from 'lucide-react';

register('right-panel', {
  id: 'canvas',
  title: 'Canvas',
  icon: PanelRight,
  component: lazy(() =>
    import('@/layers/features/canvas').then((m) => ({ default: m.CanvasContent }))
  ),
  visibleWhen: ({ pathname }) => {
    // Canvas tab only appears on /session route
    return pathname === '/session';
  },
  priority: 20,
});
```

The `visibleWhen` function is evaluated reactively by the `RightPanelContainer` -- when the user navigates away from `/session`, the canvas tab disappears. When it is the only tab and disappears, the tab bar hides entirely but the panel state (open/closed) is preserved so it reopens with visible tabs when the user returns.

### 5. Zustand State Slice

New file: `app-store-right-panel.ts`

```typescript
import type { StateCreator } from 'zustand';
import type { AppState } from './app-store-types';
import { readRightPanelState, writeRightPanelState } from './app-store-helpers';

export interface RightPanelSlice {
  /** Whether the right panel is open. */
  rightPanelOpen: boolean;
  /** Set right panel open/closed state. */
  setRightPanelOpen: (open: boolean) => void;
  /** Toggle right panel open/closed. */
  toggleRightPanel: () => void;
  /** ID of the active right panel tab. */
  activeRightPanelTab: string | null;
  /** Set the active right panel tab by contribution ID. */
  setActiveRightPanelTab: (tabId: string | null) => void;
  /** Load persisted right panel state from localStorage. */
  loadRightPanelState: () => void;
}

export const createRightPanelSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  RightPanelSlice
> = (set, get) => ({
  rightPanelOpen: false,
  setRightPanelOpen: (open) =>
    set((s) => {
      writeRightPanelState({ open, activeTab: s.activeRightPanelTab });
      return { rightPanelOpen: open };
    }),
  toggleRightPanel: () => {
    const current = get().rightPanelOpen;
    get().setRightPanelOpen(!current);
  },

  activeRightPanelTab: null,
  setActiveRightPanelTab: (tabId) =>
    set((s) => {
      writeRightPanelState({ open: s.rightPanelOpen, activeTab: tabId });
      return { activeRightPanelTab: tabId };
    }),

  loadRightPanelState: () => {
    const entry = readRightPanelState();
    if (entry) {
      set({ rightPanelOpen: entry.open, activeRightPanelTab: entry.activeTab });
    }
  },
});
```

The `AppState` type in `app-store-types.ts` becomes:

```typescript
export type AppState = CoreSlice & PanelsSlice & PreferencesSlice & CanvasSlice & RightPanelSlice;
```

### 6. State Persistence

Add to `constants.ts`:

```typescript
export const STORAGE_KEYS = {
  // ... existing keys
  RIGHT_PANEL_STATE: 'dorkos-right-panel-state',
} as const;
```

Add to `app-store-helpers.ts`:

```typescript
export interface RightPanelStateEntry {
  open: boolean;
  activeTab: string | null;
}

export function readRightPanelState(): RightPanelStateEntry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.RIGHT_PANEL_STATE);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeRightPanelState(entry: RightPanelStateEntry): void {
  try {
    localStorage.setItem(STORAGE_KEYS.RIGHT_PANEL_STATE, JSON.stringify(entry));
  } catch {}
}
```

The persistence hook `use-right-panel-persistence.ts` calls `loadRightPanelState()` once on mount:

```typescript
export function useRightPanelPersistence(): void {
  const loadRightPanelState = useAppStore((s) => s.loadRightPanelState);
  useEffect(() => {
    loadRightPanelState();
  }, [loadRightPanelState]);
}
```

Canvas persistence (`useCanvasPersistence`) continues unchanged -- it hydrates canvas content per-session. The right panel persistence is independent and covers only the panel's structural state (open/closed, active tab).

### 7. AppShell Modification

The key change to `AppShell.tsx` is wrapping `<Outlet />` in a `PanelGroup`:

```tsx
// Inside SidebarInset, replacing the current <main> content
<main className="flex-1 overflow-hidden">
  <PanelGroup direction="horizontal" autoSaveId="app-shell-right-panel">
    <Panel id="main-content" order={1} minSize={30} defaultSize={100}>
      <Outlet />
    </Panel>
    <RightPanelContainer />
  </PanelGroup>
</main>
```

The `autoSaveId` is a static string because the shell-level panel width should persist globally (not per-session or per-route). The `defaultSize={100}` ensures the main content fills all available space when the right panel is closed.

The header gains a `RightPanelToggle` at the far right:

```tsx
<header className="relative flex h-9 shrink-0 items-center gap-2 border-b px-2 ...">
  <SidebarTrigger className="-ml-0.5" />
  <Separator orientation="vertical" className="mr-1 h-4" />
  {/* Dynamic header content */}
  <AnimatePresence mode="wait" initial={false}>
    <motion.div key={headerSlot.key} ...>
      {headerSlot.content}
    </motion.div>
  </AnimatePresence>
  {/* Right panel toggle — always visible, symmetric with SidebarTrigger */}
  <RightPanelToggle />
</header>
```

The hook calls move from feature-specific to shell-level:

```diff
- useCanvasShortcut();
+ useRightPanelShortcut();
+ useRightPanelPersistence();
```

### 8. RightPanelContainer Component

```
layers/features/right-panel/ui/RightPanelContainer.tsx
```

This component renders inside the `PanelGroup` and returns `null` when the panel is closed (identical to how `AgentCanvas` works today). When open, it renders a `PanelResizeHandle` + `Panel` containing the tab bar and active tab content.

```tsx
export function RightPanelContainer() {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const activeTab = useAppStore((s) => s.activeRightPanelTab);
  const setActiveTab = useAppStore((s) => s.setActiveRightPanelTab);
  const isMobile = useIsMobile();

  // Subscribe to pathname so visibleWhen predicates re-evaluate on route changes
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Get all right-panel contributions, sorted by priority
  const allContributions = useSlotContributions('right-panel');

  // Filter to only visible contributions, passing router state to each predicate
  const visibleContributions = allContributions.filter(
    (c) => !c.visibleWhen || c.visibleWhen({ pathname })
  );

  // Auto-select first visible tab if active tab is not visible
  // (e.g., canvas tab disappears when navigating away from /session)
  useEffect(() => {
    if (visibleContributions.length > 0) {
      const activeIsVisible = visibleContributions.some((c) => c.id === activeTab);
      if (!activeIsVisible) {
        setActiveTab(visibleContributions[0].id);
      }
    }
  }, [visibleContributions, activeTab, setActiveTab]);

  if (!rightPanelOpen || visibleContributions.length === 0) return null;

  const ActiveComponent = visibleContributions.find((c) => c.id === activeTab)?.component;

  // Mobile: render as Sheet (matching existing canvas mobile pattern)
  if (isMobile) {
    return (
      <Sheet open onOpenChange={(open) => !open && setRightPanelOpen(false)}>
        <SheetContent side="right" showCloseButton={false} className="...">
          <SheetHeader className="sr-only">
            <SheetTitle>Panel</SheetTitle>
            <SheetDescription>Right panel content.</SheetDescription>
          </SheetHeader>
          {visibleContributions.length > 1 && (
            <RightPanelTabBar
              contributions={visibleContributions}
              activeTab={activeTab}
              onTabChange={setActiveTab}
            />
          )}
          {ActiveComponent && <ActiveComponent />}
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop: resizable panel with resize handle
  return (
    <>
      <PanelResizeHandle className="group relative flex w-2 items-center justify-center">
        <div className="bg-border group-hover:bg-ring h-full w-px transition-colors" />
      </PanelResizeHandle>
      <Panel
        id="right-panel"
        order={2}
        defaultSize={35}
        minSize={20}
        collapsible
        onCollapse={() => setRightPanelOpen(false)}
      >
        <div className="bg-sidebar text-sidebar-foreground flex h-full flex-col overflow-hidden rounded-lg border">
          {visibleContributions.length > 1 && (
            <RightPanelTabBar
              contributions={visibleContributions}
              activeTab={activeTab}
              onTabChange={setActiveTab}
            />
          )}
          <div className="flex-1 overflow-hidden">{ActiveComponent && <ActiveComponent />}</div>
        </div>
      </Panel>
    </>
  );
}
```

Key behaviors:

- **Tab bar visibility**: Hidden when only one contribution is visible. Appears as a row of icon buttons when 2+ are visible. Each button shows a tooltip with the contribution's `title`.
- **Auto-tab selection**: When the active tab becomes invisible (e.g., canvas disappears on route change), auto-selects the first visible tab. When no tabs are visible, the panel renders nothing (but stays structurally open to avoid layout thrash).
- **Collapse callback**: The `onCollapse` handler from `react-resizable-panels` syncs back to Zustand state, matching the existing canvas collapse pattern.

### 9. RightPanelTabBar Component

```tsx
interface RightPanelTabBarProps {
  contributions: RightPanelContribution[];
  activeTab: string | null;
  onTabChange: (tabId: string) => void;
}

export function RightPanelTabBar({ contributions, activeTab, onTabChange }: RightPanelTabBarProps) {
  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      {contributions.map((contribution) => {
        const Icon = contribution.icon;
        const isActive = contribution.id === activeTab;
        return (
          <Tooltip key={contribution.id}>
            <TooltipTrigger asChild>
              <button
                aria-label={contribution.title}
                aria-pressed={isActive}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => onTabChange(contribution.id)}
              >
                <Icon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{contribution.title}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
```

### 10. RightPanelToggle Component

Symmetric with `SidebarTrigger` (which uses `PanelLeftIcon` and sits at the header's left edge). The toggle sits at the header's right edge and is always visible regardless of panel state.

```tsx
export function RightPanelToggle() {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const isMac = /* from shared/lib */;

  const Icon = rightPanelOpen ? PanelRightClose : PanelRight;
  const ariaLabel = rightPanelOpen ? 'Close right panel' : 'Open right panel';
  const shortcutLabel = isMac ? '⌘.' : 'Ctrl+.';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          aria-label={ariaLabel}
          className="text-muted-foreground hover:text-foreground relative flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          onClick={toggleRightPanel}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.93 }}
          transition={{ type: 'spring', stiffness: 600, damping: 35 }}
        >
          <Icon className="size-4" />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent>
        <span>Toggle right panel</span>
        <Kbd>{shortcutLabel}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
```

This is intentionally similar to `CanvasToggle` -- the canvas toggle is being superseded by this shell-level toggle. The activity dot indicator (present on the current `CanvasToggle`) will be added in a follow-up once there is content-aware state to display.

### 11. Keyboard Shortcut

The right panel reuses `Cmd+.` / `Ctrl+.` -- the same shortcut currently assigned to the canvas toggle. Since the canvas is migrating into the right panel, this is a natural inheritance. The shortcut toggles the right panel open/closed, not individual tabs.

```typescript
// use-right-panel-shortcut.ts
export function useRightPanelShortcut(): void {
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        toggleRightPanel();
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleRightPanel]);
}
```

This replaces `useCanvasShortcut` in AppShell. The old shortcut hook is removed.

### 12. Canvas Migration

#### What Changes in AgentCanvas

The current `AgentCanvas` component handles both desktop (Panel + PanelResizeHandle) and mobile (Sheet) rendering. After migration:

- The Panel/PanelResizeHandle wrapper and mobile Sheet are removed from `AgentCanvas` -- those responsibilities move to `RightPanelContainer`.
- The `CanvasBody` internal component is extracted and exported as `CanvasContent` -- this is the component registered as the right-panel contribution.
- `CanvasContent` receives canvas state from Zustand (as it does today) and renders the canvas header + content area. It does not manage its own Panel or Sheet.

```typescript
// AgentCanvas.tsx → simplified to CanvasContent
export function CanvasContent() {
  const canvasContent = useAppStore((s) => s.canvasContent);
  const setCanvasOpen = useAppStore((s) => s.setCanvasOpen);
  const setCanvasContent = useAppStore((s) => s.setCanvasContent);

  const handleClose = () => setCanvasOpen(false);

  if (canvasContent) {
    return (
      <div className="flex h-full flex-col">
        <CanvasHeader
          title={canvasContent.title}
          contentType={canvasContent.type}
          onClose={handleClose}
        />
        <div className="flex-1 overflow-auto">
          {canvasContent.type === 'url' && <CanvasUrlContent content={canvasContent} />}
          {canvasContent.type === 'markdown' && <CanvasMarkdownContent content={canvasContent} />}
          {canvasContent.type === 'json' && <CanvasJsonContent content={canvasContent} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <CanvasHeader onClose={handleClose} />
      <div className="flex-1 overflow-auto">
        <CanvasSplash onAction={setCanvasContent} />
      </div>
    </div>
  );
}
```

The `onClose` handler in `CanvasContent` sets `canvasOpen: false` in the canvas slice. This does NOT close the right panel -- it only clears the canvas content state. The right panel toggle remains the way to open/close the panel itself.

#### Canvas Persistence Interaction

`useCanvasPersistence` continues to hydrate canvas content per-session. It is called from SessionPage (which still mounts on the `/session` route). The right panel persistence (`useRightPanelPersistence`) is independent -- it tracks whether the panel itself is open and which tab is active.

When a user on `/session` opens the right panel and has canvas content, both systems work together:

1. `useRightPanelPersistence` restores `rightPanelOpen: true, activeRightPanelTab: 'canvas'`
2. `useCanvasPersistence` restores `canvasContent` for the active session

### 13. SessionPage Simplification

The current `SessionPage` owns a `PanelGroup` with chat + canvas panels. After migration:

```typescript
export function SessionPage() {
  const [activeSessionId] = useSessionId();
  useCanvasPersistence(activeSessionId);

  return <ChatPanel sessionId={activeSessionId} />;
}
```

The `PanelGroup`, `Panel`, and `AgentCanvas` imports are removed. The `autoSaveId` per-session logic is removed (shell-level panel width is global). `useCanvasPersistence` remains because it hydrates canvas content for the session.

### 14. PanelGroup Configuration

| Property                  | Value                     | Rationale                                       |
| ------------------------- | ------------------------- | ----------------------------------------------- |
| `direction`               | `"horizontal"`            | Right panel beside main content                 |
| `autoSaveId`              | `"app-shell-right-panel"` | Global persistence for shell-level panel widths |
| Main panel `minSize`      | `30`                      | Prevents main content from being too narrow     |
| Main panel `defaultSize`  | `100`                     | Full width when right panel is closed           |
| Right panel `defaultSize` | `35`                      | Reasonable default for panel content            |
| Right panel `minSize`     | `20`                      | Minimum useful width for tab content            |
| Right panel `collapsible` | `true`                    | Drag-to-collapse syncs with store               |

The `autoSaveId` for the old per-session canvas layout (`agent-canvas-{uuid}`) becomes orphaned in localStorage. These entries are small (~50 bytes) and will not cause issues. A cleanup migration is not warranted.

### 15. Handling the `visibleWhen` Predicate

The `visibleWhen` function on `RightPanelContribution` must be evaluated reactively. `RightPanelContainer` subscribes to the router via `useRouterState` and passes the current pathname to each predicate as a context argument:

```typescript
const pathname = useRouterState({ select: (s) => s.location.pathname });
const visibleContributions = allContributions.filter(
  (c) => !c.visibleWhen || c.visibleWhen({ pathname })
);
```

This keeps predicates router-aware without requiring them to call hooks directly (they are plain functions, not React hooks). The `useRouterState` subscription is lightweight -- only the pathname string is selected, so re-renders happen only on actual route changes.

**Important constraint**: `visibleWhen` functions must be synchronous and cheap. They receive a `{ pathname }` context object and may also read from synchronous sources (Zustand stores). Async visibility checks are not supported.

## User Experience

### What Users See

From the user's perspective, the canvas works exactly as before on `/session` -- it opens and closes with the same keyboard shortcut (`Cmd+.`), appears on the right side, and is resizable. The visual differences are:

1. **Toggle button location**: The toggle button moves from inside the session header (next to the command palette trigger) to the app-level header (far right). It is visible on all routes where at least one contribution is active, not just `/session`.
2. **Toggle button on non-session routes**: On routes like `/agents` or `/tasks` where no contributions are visible (until Spec 238 adds the Agent Hub), the toggle button is hidden/disabled. Users never encounter an empty panel.
3. **Panel width**: The panel width is now global rather than per-session. If a user adjusts the canvas width on one session, the same width applies when they switch sessions or navigate to another route.

### Empty Panel Prevention

The right panel must never present an empty state to the user. The following rules apply:

- **No visible contributions**: When all `visibleWhen` predicates return false (e.g., on a non-session route before Spec 238 adds the Agent Hub), `RightPanelToggle` is **hidden** (rendered with `hidden` or not rendered at all). The keyboard shortcut (`Cmd+.`) becomes a no-op. This prevents users from opening an empty panel.
- **Single visible contribution**: When exactly one contribution is visible, the panel opens directly to that tab's content with **no tab bar**. This is already specified in the `RightPanelContainer` component (tab bar is hidden when `visibleContributions.length <= 1`).
- **Active tab disappears**: When the active tab's `visibleWhen` becomes false (e.g., navigating away from `/session` removes the canvas tab), the container auto-selects the next visible tab. If no tabs remain visible, the panel closes and the toggle hides.

The toggle visibility is derived from the same `visibleContributions` filter used by `RightPanelContainer`:

```tsx
// In RightPanelToggle — hide when no contributions are visible
const pathname = useRouterState({ select: (s) => s.location.pathname });
const allContributions = useSlotContributions('right-panel');
const hasVisibleContributions = allContributions.some(
  (c) => !c.visibleWhen || c.visibleWhen({ pathname })
);

if (!hasVisibleContributions) return null;
```

### Session Header Change

The `SessionHeader` loses the `CanvasToggle` component. The header becomes simpler:

```
[Agents > AgentName > Session]           [CommandPalette]
```

The `RightPanelToggle` is in the AppShell header, one level above, always present:

```
[SidebarTrigger] | [route-specific header content]    [RightPanelToggle]
```

## Testing Strategy

### Unit Tests

**Right panel state slice** (`app-store-right-panel.test.ts`):

- `setRightPanelOpen(true)` updates state and writes to localStorage
- `toggleRightPanel` flips the boolean
- `setActiveRightPanelTab` updates state and persists
- `loadRightPanelState` hydrates from localStorage
- `loadRightPanelState` defaults gracefully when localStorage is empty or corrupt

**Extension registry** (`extension-registry.test.ts`):

- New `right-panel` slot accepts `RightPanelContribution` shaped objects
- Contributions are sorted by priority
- Unsubscribe removes the contribution
- Idempotent re-registration (existing test pattern) works for the new slot

**RightPanelToggle** (`RightPanelToggle.test.tsx`):

- Renders with `PanelRight` icon when panel is closed
- Renders with `PanelRightClose` icon when panel is open
- Clicking toggles the store state
- Shows tooltip with shortcut label

**RightPanelTabBar** (`RightPanelTabBar.test.tsx`):

- Renders one button per contribution
- Active tab gets `aria-pressed="true"` and accent styling
- Clicking a tab calls `onTabChange` with the contribution ID
- Tooltips show contribution titles

**RightPanelContainer** (`RightPanelContainer.test.tsx`):

- Returns `null` when `rightPanelOpen` is false
- Returns `null` when no visible contributions exist
- Renders the active tab's component
- Hides tab bar when only one contribution is visible
- Shows tab bar when 2+ contributions are visible
- Auto-selects first visible tab when active tab disappears
- On mobile, renders Sheet instead of Panel

**SessionPage** (`SessionPage.test.tsx`):

- Updated: no longer renders a `PanelGroup`
- Renders `ChatPanel` directly
- Still calls `useCanvasPersistence`

### Integration Tests

**Keyboard shortcut** (`use-right-panel-shortcut.test.ts`):

- `Cmd+.` fires `toggleRightPanel`
- Does not fire when modifier is missing
- `e.preventDefault()` is called

**Canvas migration smoke test**:

- Register canvas contribution, open right panel on `/session` -- canvas content renders
- Navigate to `/agents` -- canvas tab disappears, panel auto-selects next tab or shows empty

## Performance Considerations

### PanelGroup Nesting Removal

Before this change, the `/session` route has nested layout: AppShell's flexbox > SessionPage's `PanelGroup` > ChatPanel + Canvas. After, there is a single `PanelGroup` at the shell level. This removes one layer of layout computation on the session route.

### Lazy Loading of Tab Components

Tab components registered via `initializeExtensions()` use `React.lazy()` for code-splitting. The canvas component bundle is only loaded when the right panel opens on the `/session` route. Future Agent Hub code will also be lazy-loaded.

### Inactive Tab Rendering

Only the active tab's component is mounted. Switching tabs unmounts the previous component and mounts the new one. This avoids rendering hidden tab content. If a tab needs to preserve state across switches (e.g., scroll position), it should manage that internally via Zustand or refs -- this is consistent with how sidebar tabs work today.

### visibleWhen Evaluation

The `visibleWhen` predicate runs on every render of `RightPanelContainer`. Since it is a synchronous function receiving the pathname from `useRouterState`, cost is negligible. The `useRouterState` subscription ensures re-renders happen only on actual route changes.

## Security Considerations

### Contribution Validation

The extension registry's `register()` method is synchronous and trusted -- it runs in the same JavaScript context as the app. In the current model (built-in features only), all contributions are authored by the DorkOS team and loaded via `initializeExtensions()`.

When Phase 3 introduces third-party extensions, the `component` field in `RightPanelContribution` will need sandboxing (iframe or React error boundary). This spec does not add sandboxing -- it is a Phase 3 concern. However, the `RightPanelContainer` should wrap the active component in a React error boundary to prevent a broken tab from crashing the entire shell:

```tsx
<ErrorBoundary fallback={<PanelErrorFallback tabId={activeTab} />}>
  {ActiveComponent && <ActiveComponent />}
</ErrorBoundary>
```

### localStorage Integrity

The `readRightPanelState` helper wraps JSON.parse in try/catch, matching the existing `readCanvasSession` pattern. Corrupt localStorage data results in default state (panel closed, no active tab) rather than a crash.

## Documentation

### Developer Guide Updates

- **`contributing/state-management.md`**: Document the right panel slice as an example of the app-store slice pattern. Note the parallel with `CanvasSlice` for persistence.
- **`contributing/extension-points.md`** (or create if not existing): Add `right-panel` to the slot reference table with its contribution interface, registration example, and `visibleWhen` usage.

### Extension API Reference

When Phase 3 exposes the public extension API, the `right-panel` slot should be documented with:

- Contribution interface fields and their purposes
- `visibleWhen` contract (synchronous, cheap, receives `{ pathname }` context, may read Zustand stores)
- Priority conventions (1-10 for built-in, 50 default, 90+ for low-priority extensions)
- Lazy loading recommendation for component field

## Implementation Phases

### Phase 1: Core Infrastructure

**Goal**: Shell-level PanelGroup renders beside all page content; state management works.

1. Create `RightPanelSlice` in `app-store-right-panel.ts`
2. Add slice to `AppState` in `app-store-types.ts`
3. Wire slice into `app-store.ts` (the main store creator)
4. Add `RIGHT_PANEL_STATE` to `STORAGE_KEYS` and persistence helpers to `app-store-helpers.ts`
5. Add `RIGHT_PANEL` slot and `RightPanelContribution` interface to `extension-registry.ts`
6. Create `RightPanelContainer` component (desktop Panel + mobile Sheet)
7. Create `RightPanelTabBar` component
8. Modify `AppShell.tsx`: wrap `<Outlet />` in `PanelGroup`, add `RightPanelContainer`
9. Add `useRightPanelPersistence` hook, call from AppShell
10. Write unit tests for state slice, extension registry slot, container, tab bar

### Phase 2: Canvas Migration

**Goal**: Canvas is a right-panel contribution; SessionPage is simplified.

1. Extract `CanvasContent` from `AgentCanvas.tsx` (the body without Panel/Sheet wrapper)
2. Export `CanvasContent` from `features/canvas/index.ts`
3. Register canvas as `right-panel` contribution in `init-extensions.ts` with `visibleWhen` for `/session`
4. Simplify `SessionPage.tsx`: remove `PanelGroup`, render `ChatPanel` directly
5. Remove `AgentCanvas` import from `SessionPage`
6. Update `SessionPage.test.tsx` to match new structure
7. Verify canvas persistence still works end-to-end

### Phase 3: Toggle Button and Keyboard Shortcut

**Goal**: Users can toggle the right panel from any route.

1. Create `RightPanelToggle` component
2. Add `RightPanelToggle` to AppShell header (far right)
3. Create `useRightPanelShortcut` hook (`Cmd+.` / `Ctrl+.`)
4. Remove `useCanvasShortcut` from AppShell (replaced by `useRightPanelShortcut`)
5. Remove `CanvasToggle` from `SessionHeader`
6. Update `SessionHeader` to no longer import canvas toggle
7. Write toggle and shortcut tests

## Provisional Decisions

These items were initially open questions, now resolved with provisional defaults for Phase 1. Each can be revisited based on user feedback.

1. **Activity dot indicator on toggle button**: Deferred to Spec 238. The `RightPanelToggle` renders without an activity dot in Phase 1. When Spec 238 introduces the Agent Hub (a second tab with its own notification state), the dot can be added via the state indicator pattern documented in `research/20260328_multi_panel_toggle_ux_patterns.md`. Adding it now for the canvas alone would be premature since the toggle is moving from a canvas-specific control to a general-purpose panel control.

2. **Panel width: global vs per-route**: Use a single global `autoSaveId` (`"app-shell-right-panel"`) for Phase 1. Per-route or per-tab width differentiation can be evaluated as a follow-up if user feedback indicates that different tabs need different default widths. The `autoSaveId` could incorporate the active tab ID at that point, but the added complexity is not justified until there are multiple tabs in practice.

3. **Canvas close button semantics**: Closing canvas content (via the X button in the canvas header) clears the canvas content and deactivates the canvas tab, but does **not** close the right panel itself. If another tab is available (e.g., Agent Hub from Spec 238), the panel switches to that tab. If canvas was the only visible tab, the panel closes. This is implemented by having the `CanvasContent` close handler call `setCanvasOpen(false)` (which clears canvas state) and then letting `RightPanelContainer`'s auto-tab-selection logic handle the fallthrough: if no tabs remain visible, the container returns `null` and the panel collapses.

## Related ADRs

- **[ADR-0199] Generic register<K>() API with SlotContributionMap Interface** -- establishes the pattern for adding new slots to the extension registry
- **[ADR-0200] App-Layer Synchronous Extension Initialization** -- establishes that built-in features register via `initializeExtensions()` before React mounts
- **[ADR-0161] Route-Aware Sidebar & Header Slot Pattern** -- establishes the slot/hook pattern in AppShell for route-dependent content
- **[ADR-0005] Zustand UI State, TanStack Query Server State** -- the right panel slice follows this Zustand pattern for transient UI state
- **[ADR-0002] Adopt Feature-Sliced Design** -- the new `features/right-panel` module follows FSD layer rules
- **[ADR-0107] CSS Hidden Toggle for Sidebar View Persistence** -- relevant prior art for panel state persistence

## References

- **Ideation document**: `specs/settings-ui-ux-disambiguation/01-ideation.md` -- parent spec decisions, architecture diagram, Agent Hub design context
- **Research: Multi-Panel Toggle UX Patterns**: `research/20260328_multi_panel_toggle_ux_patterns.md` -- toggle button placement, keyboard shortcut conventions, mobile patterns, state indicators
- **Canvas persistence spec**: `specs/canvas-persistence-and-toggle/02-specification.md` -- localStorage per-session pattern that canvas migration must preserve
- **Extension registry spec**: `specs/ext-platform-02-extension-registry/02-specification.md` -- slot contribution map design, `useSlotContributions` hook, `initializeExtensions()` pattern
- **react-resizable-panels**: https://github.com/bvaughn/react-resizable-panels -- PanelGroup, Panel, PanelResizeHandle API; autoSaveId for layout persistence; collapsible panel callbacks
- **Shadcn Sidebar component**: `apps/client/src/layers/shared/ui/sidebar.tsx` -- reference implementation for `SidebarTrigger` button that the `RightPanelToggle` mirrors
