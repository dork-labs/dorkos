---
slug: statusline-compound-component
number: 116
created: 2026-03-10
status: draft
---

# Specification: StatusLine Compound Component

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/statusline-compound-component
**Spec Number:** 116

---

## 1. Overview

Refactor `StatusLine` from an imperative `entries[]` array assembly pattern into a declarative compound component using React Context. The result is a `StatusLine` root with a single `StatusLine.Item` sub-component. Data fetching moves up to the consumer (`ChatStatusSection`), making `StatusLine` a thin layout/animation shell.

The external rendering contract is preserved exactly: same visual output, same animations, same accessibility attributes. No individual item component files change.

---

## 2. Background and Problem Statement

### Current Implementation

`StatusLine` (`apps/client/src/layers/features/status/ui/StatusLine.tsx`) owns all data fetching and assembly:

1. Calls `useSessionStatus()`, `useAppStore()`, `useGitStatus()`, and `useQuery(['config'])` internally
2. Assembles a `{ key: string; node: React.ReactNode }[]` array via 9 conditional `if`/`push` blocks
3. Renders the array with `AnimatePresence` + `map()`, inserting a `<Separator />` between items via array index

This imperative pattern has three limitations:

**Plugin extensibility is structurally blocked.** An MCP plugin that wants to inject a custom status item cannot do so. There is no injection point — the component owns its own entry list with no extension seam.

**Embedded contexts cannot vary the item set.** The Obsidian plugin embeds a minimal sidebar view. It cannot use `StatusLine` with a reduced item set without forking the component. The imperative internal array is not composable.

**The pattern diverges from established codebase conventions.** Every other multi-part compound UI in the codebase (Sidebar, Tabs, and all Shadcn components) uses the declarative compound component pattern with Context. The current StatusLine is the only large UI component that wires its own children imperatively. This creates inconsistency that violates the project's code quality standards.

### Chosen Solution

Convert `StatusLine` to a compound component following the `sidebar.tsx` precedent:

- `StatusLine` root: layout/animation shell + context provider
- `StatusLine.Item`: animated wrapper with separator and registration
- Data fetching moves to `ChatStatusSection` (the sole consumer)
- All 9 item components remain completely unchanged

---

## 3. Goals

- Replace the imperative `entries[]` array with a declarative `StatusLine.Item` composition API
- Move all data fetching hooks (`useSessionStatus`, `useGitStatus`, `useAppStore`, `useQuery(['config'])`) from `StatusLine` to `ChatStatusSection`
- Preserve the `AnimatePresence` animation contract exactly: outer container fade+slide, inner `popLayout` item animations, `layout` reflow on siblings
- Preserve separator behavior: middot between visible items, separator exits with its item during `AnimatePresence`
- Leave the barrel export line in `features/status/index.ts` unchanged — the compound shape is an implementation detail
- Write new tests covering the compound context and `StatusLine.Item` visibility and separator logic
- All 6 existing item test files continue passing without modification
- Achieve strict visual parity: identical rendered output before and after

---

## 4. Non-Goals

- New status items or changes to any individual item component files
- Plugin registration API or runtime plugin system (the compound pattern enables future injection; no registration infrastructure ships now)
- Named sub-components (`StatusLine.Cwd`, `StatusLine.Git`, etc.) — only generic `StatusLine.Item`
- Changes to `ChatPanel`, `ChatInputContainer`, or any other chat component beyond `ChatStatusSection`
- Changes to Settings UI or the 9 `showStatusBar*` booleans in `useAppStore`
- Server-side or API changes of any kind

---

## 5. Technical Dependencies

| Dependency              | Version | Usage                                                                                      |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `motion/react`          | 12.x    | `AnimatePresence`, `motion.div` — unchanged                                                |
| `react`                 | 19      | `createContext`, `useContext`, `useCallback`, `useMemo`, `useEffect`, `useRef`, `useState` |
| `@tanstack/react-query` | 5.x     | `useQuery`, `useQueryClient` — moves to `ChatStatusSection`                                |
| `useAppStore`           | —       | Zustand store — moves to `ChatStatusSection`                                               |
| `useSessionStatus`      | —       | Session entity hook — moves to `ChatStatusSection`                                         |
| `useGitStatus`          | —       | Feature model hook — moves to `ChatStatusSection`                                          |
| `useTransport`          | —       | Shared transport hook — moves to `ChatStatusSection`                                       |

No new dependencies are introduced. No `package.json` changes.

---

## 6. Detailed Design

### 6.1 Architecture

The refactor separates three concerns that are currently entangled in `StatusLine.tsx`:

```
Before:
  StatusLine
    ├── Data layer (5 hooks, 1 query)
    ├── Visibility logic (9 conditionals)
    └── Layout/animation layer (AnimatePresence + array map)

After:
  ChatStatusSection (data layer + visibility logic)
    └── StatusLine root (layout/animation + context)
         └── StatusLine.Item x 9 (registration + separator + animation)
              └── [Item component] (unchanged)
```

`StatusLine` becomes a controlled component: it knows nothing about what data to fetch or which items should show. It only orchestrates animation and separator logic.

### 6.2 Context Design

The context is intentionally minimal. It carries only what `StatusLine.Item` needs to render correctly: the shared animation transition config, the `firstVisibleKey` for separator logic, and registration callbacks.

```tsx
/** @internal StatusLine compound component context. Not part of the public API. */
interface StatusLineContextValue {
  /** Shared animation transition applied to all items. */
  itemTransition: { duration: number; ease: number[] };
  /** The itemKey of the first currently-registered visible item, or null if none. */
  firstVisibleKey: string | null;
  /** Called by StatusLine.Item via useEffect on mount when visible. */
  registerItem: (key: string) => void;
  /** Called by StatusLine.Item via useEffect cleanup on unmount or when visible becomes false. */
  unregisterItem: (key: string) => void;
}

const StatusLineContext = React.createContext<StatusLineContextValue | null>(null);

/**
 * @internal Use within StatusLine.Item only.
 * Throws if called outside a StatusLine provider.
 */
function useStatusLineContext(): StatusLineContextValue {
  const ctx = React.useContext(StatusLineContext);
  if (!ctx) {
    throw new Error('StatusLine.Item must be used within a StatusLine.');
  }
  return ctx;
}
```

The context throws on missing provider, matching the `useSidebar` pattern in `apps/client/src/layers/shared/ui/sidebar.tsx`.

### 6.3 Registration Mechanism

Items register themselves via `useEffect` when `visible` is `true`, and deregister on unmount or when `visible` changes to `false`. The root tracks an ordered array of registered keys and derives `firstVisibleKey` from index 0.

Registration order is insertion order — the order in which `StatusLine.Item` children mount. This matches JSX declaration order, which is stable as long as items are not conditionally reordered in JSX position (they are not — only `visible` changes, not JSX order).

```tsx
// Inside StatusLineRoot
const [registeredKeys, setRegisteredKeys] = useState<string[]>([]);

const registerItem = useCallback((key: string) => {
  // Guard against duplicate registration on StrictMode double-invoke
  setRegisteredKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
}, []);

const unregisterItem = useCallback((key: string) => {
  setRegisteredKeys((prev) => prev.filter((k) => k !== key));
}, []);

// Derived from registration list — first key is first visible item
const firstVisibleKey = registeredKeys[0] ?? null;
```

At most 9 registration effects fire on initial mount. React 19 automatic batching groups them into at most 2 renders. This is negligible and matches the Shadcn Sidebar's own context update pattern.

### 6.4 StatusLine Root Component

The root accepts `sessionId`, `isStreaming`, and `children`. It no longer calls any data fetching hooks. The `sessionStatus` prop is removed from the root — it was only needed internally for `useSessionStatus`, which now lives in `ChatStatusSection`.

```tsx
interface StatusLineProps {
  /** Session identifier. Passed for future use (e.g., ARIA labeling). */
  sessionId: string;
  /** Whether the session is currently streaming. May affect item logic in future extensions. */
  isStreaming: boolean;
  /** StatusLine.Item elements. */
  children: React.ReactNode;
}
```

The root derives `hasVisibleChildren` from `registeredKeys.length > 0` to gate the outer `AnimatePresence` container — identical behavior to the current `hasItems` variable.

**Full root implementation:**

```tsx
// Module-level constant — same value as current StatusLine.tsx itemTransition
const ITEM_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

function StatusLineRoot({ sessionId, isStreaming, children }: StatusLineProps) {
  const [registeredKeys, setRegisteredKeys] = useState<string[]>([]);

  const registerItem = useCallback((key: string) => {
    setRegisteredKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }, []);

  const unregisterItem = useCallback((key: string) => {
    setRegisteredKeys((prev) => prev.filter((k) => k !== key));
  }, []);

  // Insertion-order first key is the first visible item — stable across re-renders
  const firstVisibleKey = registeredKeys[0] ?? null;
  // Container shows when at least one item is registered (visible)
  const hasVisibleChildren = registeredKeys.length > 0;

  const contextValue = useMemo<StatusLineContextValue>(
    () => ({
      itemTransition: ITEM_TRANSITION,
      firstVisibleKey,
      registerItem,
      unregisterItem,
    }),
    [firstVisibleKey, registerItem, unregisterItem]
  );

  return (
    <StatusLineContext.Provider value={contextValue}>
      {/*
       * Outer AnimatePresence: animates the entire status bar container in/out.
       * Inner AnimatePresence (mode="popLayout"): animates individual items.
       * This two-boundary architecture is preserved from the original implementation.
       */}
      <AnimatePresence initial={false}>
        {hasVisibleChildren && (
          <motion.div
            role="toolbar"
            aria-label="Session status"
            aria-live="polite"
            data-testid="status-line"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-2 px-1 pt-2 text-xs whitespace-nowrap sm:justify-start">
              <AnimatePresence initial={false} mode="popLayout">
                {children}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </StatusLineContext.Provider>
  );
}
```

### 6.5 StatusLine.Item Component

`StatusLine.Item` is the animated wrapper for each status entry. When `visible` is `false` it returns `null`, which causes `AnimatePresence` to fire the exit animation. When `visible` is `true` it registers with the context, determines separator need, and renders content.

```tsx
interface StatusLineItemProps {
  /**
   * Stable unique identifier used for AnimatePresence tracking and separator logic.
   * Must be unique within the StatusLine. Use short lowercase slugs: 'cwd', 'git', etc.
   */
  itemKey: string;
  /** Controls whether this item participates in the status bar. */
  visible: boolean;
  /** The status item content — one of the 9 built-in item components or a plugin element. */
  children: React.ReactNode;
}

function StatusLineItem({ itemKey, visible, children }: StatusLineItemProps) {
  const { itemTransition, firstVisibleKey, registerItem, unregisterItem } = useStatusLineContext();

  /*
   * Register with root context when visible; deregister on unmount or when visibility
   * is lost. useEffect (not render-time logic) is the correct primitive — this ensures
   * the root state updates after commit, not during render.
   */
  useEffect(() => {
    if (!visible) return;
    registerItem(itemKey);
    return () => unregisterItem(itemKey);
  }, [visible, itemKey, registerItem, unregisterItem]);

  // Returning null triggers AnimatePresence to fire the exit animation for this key.
  if (!visible) return null;

  const isFirst = itemKey === firstVisibleKey;

  return (
    <motion.div
      key={itemKey}
      layout
      initial={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
      transition={itemTransition}
      className="inline-flex items-center gap-2"
    >
      {/* Separator exits with this item during AnimatePresence — no orphaned separators */}
      {!isFirst && <StatusLineSeparator />}
      {children}
    </motion.div>
  );
}

/** @internal Middot separator between status items. */
function StatusLineSeparator() {
  return (
    <span className="text-muted-foreground/30" aria-hidden="true">
      &middot;
    </span>
  );
}
```

Note: The `Separator` function is renamed to `StatusLineSeparator` to avoid collision with the Shadcn `Separator` component imported elsewhere in the codebase. The rendered HTML is identical.

### 6.6 Object.assign Export Pattern

The compound is assembled with `Object.assign` and exported as a single named export. This is the same pattern used throughout the codebase and means the barrel in `index.ts` requires no changes.

````tsx
/**
 * StatusLine compound component — animated session status bar.
 *
 * Renders a horizontal toolbar containing `StatusLine.Item` children.
 * Items animate in and out individually via Motion's AnimatePresence.
 * The container fades in when the first item becomes visible and fades
 * out when the last item disappears.
 *
 * Data fetching is the responsibility of the consumer. Pass pre-fetched
 * data to individual item components via StatusLine.Item children.
 *
 * @example
 * ```tsx
 * <StatusLine sessionId={id} isStreaming={streaming}>
 *   <StatusLine.Item itemKey="cwd" visible={showCwd && !!cwd}>
 *     <CwdItem cwd={cwd} />
 *   </StatusLine.Item>
 *   <StatusLine.Item itemKey="git" visible={showGit}>
 *     <GitStatusItem data={gitStatus} />
 *   </StatusLine.Item>
 * </StatusLine>
 * ```
 */
export const StatusLine = Object.assign(StatusLineRoot, {
  Item: StatusLineItem,
});
````

### 6.7 ChatStatusSection Migration

All data fetching moves from `StatusLine` to `ChatStatusSection`. The component gains hooks and the `handleDismissVersion` callback. The `StatusLine` JSX block in both the mobile and desktop rendering branches is replaced.

**Hooks added to `ChatStatusSection`:**

```tsx
// Data hooks (moved from StatusLine)
const status = useSessionStatus(sessionId, sessionStatus, isStreaming);
const {
  showStatusBarCwd,
  showStatusBarPermission,
  showStatusBarModel,
  showStatusBarCost,
  showStatusBarContext,
  showStatusBarGit,
  showStatusBarSound,
  showStatusBarTunnel,
  showStatusBarVersion,
  enableNotificationSound,
  setEnableNotificationSound,
} = useAppStore();
const { data: gitStatus } = useGitStatus(status.cwd);
const transport = useTransport();
const queryClient = useQueryClient();
const { data: serverConfig } = useQuery({
  queryKey: ['config'],
  queryFn: () => transport.getConfig(),
  staleTime: 5 * 60 * 1000,
});
const dismissedVersions = useMemo(
  () => serverConfig?.dismissedUpgradeVersions ?? [],
  [serverConfig?.dismissedUpgradeVersions]
);
const handleDismissVersion = useCallback(
  async (version: string) => {
    const updated = [...dismissedVersions, version];
    await transport.updateConfig({ ui: { dismissedUpgradeVersions: updated } });
    queryClient.invalidateQueries({ queryKey: ['config'] });
  },
  [dismissedVersions, transport, queryClient]
);
```

**New `StatusLine` JSX block (replaces both mobile and desktop call sites):**

```tsx
<StatusLine sessionId={sessionId} isStreaming={isStreaming}>
  <StatusLine.Item itemKey="cwd" visible={showStatusBarCwd && !!status.cwd}>
    <CwdItem cwd={status.cwd!} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="git" visible={showStatusBarGit}>
    <GitStatusItem data={gitStatus} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="permission" visible={showStatusBarPermission}>
    <PermissionModeItem
      mode={status.permissionMode}
      onChangeMode={(mode) => status.updateSession({ permissionMode: mode })}
    />
  </StatusLine.Item>
  <StatusLine.Item itemKey="model" visible={showStatusBarModel}>
    <ModelItem model={status.model} onChangeModel={(model) => status.updateSession({ model })} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="cost" visible={showStatusBarCost && status.costUsd !== null}>
    <CostItem costUsd={status.costUsd!} />
  </StatusLine.Item>
  <StatusLine.Item
    itemKey="context"
    visible={showStatusBarContext && status.contextPercent !== null}
  >
    <ContextItem percent={status.contextPercent!} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="sound" visible={showStatusBarSound}>
    <NotificationSoundItem
      enabled={enableNotificationSound}
      onToggle={() => setEnableNotificationSound(!enableNotificationSound)}
    />
  </StatusLine.Item>
  <StatusLine.Item itemKey="tunnel" visible={showStatusBarTunnel && !!serverConfig?.tunnel}>
    <TunnelItem tunnel={serverConfig!.tunnel!} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="version" visible={showStatusBarVersion && !!serverConfig}>
    <VersionItem
      version={serverConfig!.version}
      latestVersion={serverConfig!.latestVersion}
      isDevMode={serverConfig!.isDevMode}
      isDismissed={
        serverConfig!.latestVersion
          ? dismissedVersions.includes(serverConfig!.latestVersion)
          : false
      }
      onDismiss={handleDismissVersion}
    />
  </StatusLine.Item>
</StatusLine>
```

If inlining the StatusLine JSX in both mobile and desktop branches creates a function over 50 lines, extract to a `const statusLineContent = (...)` JSX variable declared before the return statement.

**Imports added to `ChatStatusSection.tsx`:**

```tsx
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSessionStatus } from '@/layers/entities/session';
import { useAppStore, useTransport } from '@/layers/shared/model';
```

All 9 item components imported from the status feature barrel (after barrel update) or internal paths.

### 6.8 Barrel Export Update

The barrel export line for `StatusLine` is unchanged. The compound shape is transparent to importers:

```ts
// apps/client/src/layers/features/status/index.ts
// (no changes to this line)
export { StatusLine } from './ui/StatusLine';
```

Add the 7 item components not yet in the barrel:

```ts
export { CwdItem } from './ui/CwdItem';
export { GitStatusItem } from './ui/GitStatusItem';
export { PermissionModeItem } from './ui/PermissionModeItem';
export { ModelItem } from './ui/ModelItem';
export { CostItem } from './ui/CostItem';
export { ContextItem } from './ui/ContextItem';
export { NotificationSoundItem } from './ui/NotificationSoundItem';
```

`TunnelItem` and `VersionItem` are already exported.

### 6.9 File Organization

```
apps/client/src/layers/features/status/
├── ui/
│   ├── StatusLine.tsx           REWRITE — compound root + Item + context (co-located)
│   ├── CwdItem.tsx              UNCHANGED
│   ├── GitStatusItem.tsx        UNCHANGED
│   ├── PermissionModeItem.tsx   UNCHANGED
│   ├── ModelItem.tsx            UNCHANGED
│   ├── CostItem.tsx             UNCHANGED
│   ├── ContextItem.tsx          UNCHANGED
│   ├── NotificationSoundItem.tsx UNCHANGED
│   ├── TunnelItem.tsx           UNCHANGED
│   └── VersionItem.tsx          UNCHANGED
├── model/
│   └── use-git-status.ts        UNCHANGED
├── lib/
│   └── version-compare.ts       UNCHANGED
├── __tests__/
│   ├── StatusLine.test.tsx      NEW — compound context + Item tests
│   ├── GitStatusItem.test.tsx   UNCHANGED
│   ├── NotificationSoundItem.test.tsx UNCHANGED
│   ├── ModelItem.test.tsx       UNCHANGED
│   ├── TunnelItem.test.tsx      UNCHANGED
│   ├── VersionItem.test.tsx     UNCHANGED
│   └── use-git-status.test.tsx  UNCHANGED
└── index.ts                     MODIFY — add item barrel exports

apps/client/src/layers/features/chat/
└── ui/
    └── ChatStatusSection.tsx    MODIFY — add data hooks, compound API call sites
```

---

## 7. User Experience

There is no user-visible change. This is a pure internal refactor.

The rendered DOM, CSS classes, ARIA attributes (`role="toolbar"`, `aria-label="Session status"`, `aria-live="polite"`), and `data-testid="status-line"` are preserved exactly. The status bar appears and disappears identically, items animate identically, separators appear identically.

**Animation contract — preserved exactly:**

| Property                     | Value                                   | Component              |
| ---------------------------- | --------------------------------------- | ---------------------- |
| Container enter: height      | `0 -> auto`                             | `motion.div` outer     |
| Container enter: opacity     | `0 -> 1`                                | `motion.div` outer     |
| Container exit: height       | `auto -> 0`                             | `motion.div` outer     |
| Container transition         | `duration: 0.2, ease: [0.4, 0, 0.2, 1]` | outer                  |
| Item enter: opacity          | `0 -> 1`                                | `motion.div` inner     |
| Item enter: scale            | `0.8 -> 1`                              | `motion.div` inner     |
| Item enter: filter           | `blur(4px) -> blur(0px)`                | `motion.div` inner     |
| Item exit: reverse of enter  | —                                       | `motion.div` inner     |
| Item transition              | `duration: 0.2, ease: [0.4, 0, 0.2, 1]` | inner                  |
| Inner `AnimatePresence` mode | `popLayout`                             | —                      |
| Item `layout` prop           | present                                 | each item `motion.div` |

Interactive items (dropdowns, toggles, dialogs, popovers) are fully functional. The compound pattern changes which component declares the item tree, not how items render or respond to interaction. `PermissionModeItem`, `ModelItem`, `NotificationSoundItem`, `TunnelItem`, and `VersionItem` with their internal state remain identical.

Mobile gestures (`DragHandle`, swipe-to-collapse in `ChatStatusSection`) are unaffected. `ShortcutChips` are unaffected.

---

## 8. Testing Strategy

### 8.1 Existing Tests

Six test files cover individual item components. Because no item component files change, these tests require zero modification and must continue passing:

| File                                       | Tests | Status               |
| ------------------------------------------ | ----- | -------------------- |
| `__tests__/GitStatusItem.test.tsx`         | 10    | Unchanged, must pass |
| `__tests__/NotificationSoundItem.test.tsx` | 3     | Unchanged, must pass |
| `__tests__/ModelItem.test.tsx`             | ~6    | Unchanged, must pass |
| `__tests__/TunnelItem.test.tsx`            | ~8    | Unchanged, must pass |
| `__tests__/VersionItem.test.tsx`           | ~28   | Unchanged, must pass |
| `__tests__/use-git-status.test.tsx`        | ~4    | Unchanged, must pass |

### 8.2 New Tests: StatusLine.test.tsx

Create at `apps/client/src/layers/features/status/__tests__/StatusLine.test.tsx`.

The motion library is stubbed using the proxy pattern established in `ModelItem.test.tsx`:

```tsx
/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { StatusLine } from '../ui/StatusLine';

// Stub Motion — not available in jsdom. Proxy renders any tag as a plain HTML element.
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_, tag: string) =>
        ({
          children,
          ...props
        }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) =>
          React.createElement(tag as keyof JSX.IntrinsicElements, props, children),
    }
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
```

**Test suite:**

```tsx
describe('StatusLine', () => {
  describe('container visibility', () => {
    it('does not render the toolbar when no items are visible', () => {
      render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="cwd" visible={false}>
            <span>cwd</span>
          </StatusLine.Item>
        </StatusLine>
      );
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    });

    it('renders the toolbar when at least one item is visible', () => {
      render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="cwd" visible>
            <span>cwd content</span>
          </StatusLine.Item>
        </StatusLine>
      );
      expect(screen.getByRole('toolbar')).toBeInTheDocument();
    });

    it('has the correct ARIA attributes on the toolbar container', () => {
      render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="cwd" visible>
            <span>content</span>
          </StatusLine.Item>
        </StatusLine>
      );
      const toolbar = screen.getByRole('toolbar');
      expect(toolbar).toHaveAttribute('aria-label', 'Session status');
      expect(toolbar).toHaveAttribute('aria-live', 'polite');
      expect(toolbar).toHaveAttribute('data-testid', 'status-line');
    });
  });

  describe('StatusLine.Item visibility', () => {
    it('renders visible items', () => {
      render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="cwd" visible>
            <span>cwd content</span>
          </StatusLine.Item>
        </StatusLine>
      );
      expect(screen.getByText('cwd content')).toBeInTheDocument();
    });

    it('does not render invisible items', () => {
      render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="cwd" visible={false}>
            <span>should not appear</span>
          </StatusLine.Item>
          <StatusLine.Item itemKey="git" visible>
            <span>git content</span>
          </StatusLine.Item>
        </StatusLine>
      );
      expect(screen.queryByText('should not appear')).not.toBeInTheDocument();
      expect(screen.getByText('git content')).toBeInTheDocument();
    });

    it('renders all visible items when multiple are provided', () => {
      render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="a" visible>
            <span>item a</span>
          </StatusLine.Item>
          <StatusLine.Item itemKey="b" visible>
            <span>item b</span>
          </StatusLine.Item>
          <StatusLine.Item itemKey="c" visible>
            <span>item c</span>
          </StatusLine.Item>
        </StatusLine>
      );
      expect(screen.getByText('item a')).toBeInTheDocument();
      expect(screen.getByText('item b')).toBeInTheDocument();
      expect(screen.getByText('item c')).toBeInTheDocument();
    });
  });

  describe('separator logic', () => {
    it('renders no separator when only one item is visible', () => {
      const { container } = render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="only" visible>
            <span>only item</span>
          </StatusLine.Item>
        </StatusLine>
      );
      expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
    });

    it('renders exactly one separator between two visible items', () => {
      const { container } = render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="a" visible>
            <span>a</span>
          </StatusLine.Item>
          <StatusLine.Item itemKey="b" visible>
            <span>b</span>
          </StatusLine.Item>
        </StatusLine>
      );
      expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    });

    it('renders N-1 separators for N visible items', () => {
      const { container } = render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="a" visible>
            <span>a</span>
          </StatusLine.Item>
          <StatusLine.Item itemKey="b" visible>
            <span>b</span>
          </StatusLine.Item>
          <StatusLine.Item itemKey="c" visible>
            <span>c</span>
          </StatusLine.Item>
        </StatusLine>
      );
      expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    });

    it('does not render a separator before the first visible item when earlier items are invisible', () => {
      const { container } = render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="hidden" visible={false}>
            <span>hidden</span>
          </StatusLine.Item>
          <StatusLine.Item itemKey="first-visible" visible>
            <span>first visible</span>
          </StatusLine.Item>
          <StatusLine.Item itemKey="second-visible" visible>
            <span>second visible</span>
          </StatusLine.Item>
        </StatusLine>
      );
      expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    });

    it('renders the middot character as separator content', () => {
      const { container } = render(
        <StatusLine sessionId="s1" isStreaming={false}>
          <StatusLine.Item itemKey="a" visible>
            <span>a</span>
          </StatusLine.Item>
          <StatusLine.Item itemKey="b" visible>
            <span>b</span>
          </StatusLine.Item>
        </StatusLine>
      );
      const separator = container.querySelector('[aria-hidden="true"]');
      expect(separator?.textContent).toBe('\u00B7');
    });
  });

  describe('provider guard', () => {
    it('throws when StatusLine.Item is used outside a StatusLine', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        render(
          <StatusLine.Item itemKey="orphan" visible>
            <span>orphan</span>
          </StatusLine.Item>
        )
      ).toThrow('StatusLine.Item must be used within a StatusLine.');
      errorSpy.mockRestore();
    });
  });
});
```

### 8.3 Coverage Summary

| Concern                                               | Tests  |
| ----------------------------------------------------- | ------ |
| Container hidden when no items visible                | 1      |
| Container renders when item visible                   | 1      |
| ARIA attributes on toolbar                            | 1      |
| Item renders when visible                             | 1      |
| Item hidden when not visible                          | 1      |
| Multiple items all render                             | 1      |
| No separator for single item                          | 1      |
| One separator for two items                           | 1      |
| N-1 separators for N items                            | 1      |
| First visible is first even when earlier items hidden | 1      |
| Separator content is middot                           | 1      |
| Provider guard throws                                 | 1      |
| **Total new tests**                                   | **12** |

---

## 9. Performance Considerations

**Registration batching.** React 19 automatic batching groups all 9 registration `setState` calls from a single synchronous mount into at most 2 renders (one initial, one after effects). In practice, because all 9 items mount in the same commit, React will batch these into a single state update. Negligible impact.

**Context stability.** `contextValue` is wrapped in `useMemo`. `registerItem` and `unregisterItem` are stable `useCallback` references. `firstVisibleKey` changes only when the set of visible items changes — which happens only when a user toggles a visibility setting. Items that do not change visibility produce no re-renders from context.

**`ITEM_TRANSITION` allocation.** Defined at module level as a `const` object. Same behavior as the existing module-level `itemTransition` constant. Zero allocation per render.

**Data fetching unchanged.** All hooks move to `ChatStatusSection`, which already re-renders on session state changes. The number of hook calls, query subscriptions, and cache interactions is identical to the current implementation — just located one component higher in the tree.

---

## 10. Security Considerations

No security surface area changes. This refactor moves data fetching one component up the tree within the same React component tree. No new network calls, no new API endpoints, no new data exposure surface. The `sessionId` prop flows through identically. All existing access controls on the underlying hooks and queries remain in place.

---

## 11. Documentation

### TSDoc on Exports

The exported `StatusLine` constant receives a full TSDoc comment with `@example` (see section 6.6). `StatusLineProps` and `StatusLineItemProps` receive TSDoc on each property. `StatusLineContextValue` and `useStatusLineContext` receive `@internal` tags.

### Inline Comments

Three inline comments are warranted in `StatusLine.tsx`:

1. **Above the two `AnimatePresence` elements in root:** explaining the two-boundary architecture — outer for container enter/exit, inner for individual item enter/exit.
2. **Above the registration `useEffect` in `StatusLineItem`:** explaining that `useEffect` (not render-time logic) is the correct primitive for "register on mount, deregister on unmount" — this ensures the root state updates after commit, not during render.
3. **Above `firstVisibleKey = registeredKeys[0]`:** explaining that order is insertion order matching JSX declaration order, which is stable because items are not conditionally reordered.

---

## 12. Implementation Phases

### Phase 1: Rewrite StatusLine.tsx

- [ ] Delete the existing `StatusLine` function body and all internal hooks
- [ ] Define `StatusLineContextValue` interface
- [ ] Implement `StatusLineContext` and `useStatusLineContext` with provider guard
- [ ] Implement `StatusLineRoot` with registration state, callbacks, context memoization, and two-boundary AnimatePresence JSX
- [ ] Implement `StatusLineItem` with registration useEffect, separator logic, and motion.div wrapper
- [ ] Implement `StatusLineSeparator`
- [ ] Define `ITEM_TRANSITION` at module level
- [ ] Assemble and export via `Object.assign`
- [ ] Add TSDoc and inline comments (see section 11)
- [ ] Remove all now-unused imports
- [ ] Verify file is under 250 LOC

### Phase 2: Migrate ChatStatusSection.tsx

- [ ] Add imports for data hooks, item components, and react/tanstack utilities
- [ ] Add all data hooks and `handleDismissVersion` callback to the function body
- [ ] Replace `<StatusLine>` call in the mobile branch
- [ ] Replace `<StatusLine>` call in the desktop branch
- [ ] Remove `sessionStatus` from the `StatusLine` call
- [ ] If function body exceeds 50 lines, extract StatusLine JSX to a `const statusLineContent` variable

### Phase 3: Update Barrel Exports

- [ ] Add the 7 item components not yet in the barrel to `features/status/index.ts`
- [ ] Verify existing barrel exports are unchanged

### Phase 4: Write Tests

- [ ] Create `apps/client/src/layers/features/status/__tests__/StatusLine.test.tsx`
- [ ] Implement the motion mock
- [ ] Implement all 12 test cases from section 8.2
- [ ] Run: `pnpm vitest run apps/client/src/layers/features/status/__tests__/StatusLine.test.tsx`
- [ ] Run all status feature tests: `pnpm vitest run apps/client/src/layers/features/status`
- [ ] Confirm all 6 existing item test files pass

### Phase 5: Verification

- [ ] `pnpm typecheck` — zero TypeScript errors
- [ ] `pnpm lint` — zero ESLint violations
- [ ] `pnpm test -- --run` — all tests pass
- [ ] Manual: start dev server, open session, verify status bar renders correctly
- [ ] Manual: toggle visibility settings — items animate in/out with correct separators
- [ ] Manual: mobile viewport — swipe-to-collapse gesture works
- [ ] Manual: interactive overlays (model dropdown, permission dropdown, tunnel dialog, version popover) all work

---

## 13. Open Questions

None. All design decisions were resolved during ideation:

| Decision                     | Resolution                                                           |
| ---------------------------- | -------------------------------------------------------------------- |
| Separator strategy           | Inline in `motion.div` — exits with its item, no orphaned separators |
| API shape                    | Generic `StatusLine.Item` only — no named sub-components             |
| Registration mechanism       | `useEffect` + ordered `string[]` state in root                       |
| `firstVisibleKey` derivation | `registeredKeys[0]` — insertion order equals JSX declaration order   |
| File organization            | All co-located in `StatusLine.tsx` — context is too small to extract |
| Data migration target        | `ChatStatusSection` is the sole consumer and the correct data owner  |

---

## 14. Related ADRs

No ADR is required. This refactor applies an existing established pattern (compound component with Context, as used by the Shadcn `sidebar.tsx`) to a new component. No new architectural principle is introduced.

---

## 15. References

| Resource                            | Path                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| Current `StatusLine` implementation | `apps/client/src/layers/features/status/ui/StatusLine.tsx`      |
| Sole consumer                       | `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx` |
| Compound component prior art        | `apps/client/src/layers/shared/ui/sidebar.tsx`                  |
| Status feature barrel               | `apps/client/src/layers/features/status/index.ts`               |
| Animation conventions               | `contributing/animations.md`                                    |
| Design system                       | `contributing/design-system.md`                                 |
| Component conventions               | `.claude/rules/components.md`                                   |
| FSD layer rules                     | `.claude/rules/fsd-layers.md`                                   |
| Ideation document                   | `specs/statusline-compound-component/01-ideation.md`            |
