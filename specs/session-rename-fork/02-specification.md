---
slug: session-rename-fork
number: 242
created: 2026-04-13
status: specification
---

# Session Rename & Fork Actions — Specification

## Overview

Wire the existing session rename and fork backend operations through to all client UI locations where `SessionRow` appears. Create a `ResponsiveContextMenu` shared primitive that uses Radix ContextMenu on desktop and a Vaul Drawer on mobile. Convert rename to use optimistic updates via `useMutation` for instant feedback.

**Backend status:** Fully implemented — schemas, API routes, runtime methods, SDK calls, and transport client methods all exist. This spec is client-side only.

## Scope

### In Scope

1. **ResponsiveContextMenu** — new shared primitive at `layers/shared/ui/`
2. **useLongPress** — new shared hook at `layers/shared/model/`
3. **SessionContextMenu** — update to use `ResponsiveContextMenu` instead of Radix ContextMenu directly
4. **SessionsTab** (Agent Hub) — wire `onForkSession` and `onRenameSession` handlers
5. **AgentListItem** — wire `onForkSession` and `onRenameSession` handlers for compact session rows
6. **DashboardSidebar** — add rename/fork handlers and pass them down to `AgentListItem`
7. **Optimistic rename** — convert `handleRenameSession` in `SessionSidebar` to `useMutation` pattern; apply same pattern in new consumers
8. **Tests** — update existing tests and add new ones for responsive context menu behavior

### Out of Scope

- Mid-conversation fork (`upToMessageId` selection UI)
- Double-click-to-rename trigger
- Batch rename / multi-select
- `OverviewTabPanel` wiring (component being deprecated)
- Server-side changes

## Technical Design

### 1. ResponsiveContextMenu (`layers/shared/ui/responsive-context-menu.tsx`)

Follows the exact pattern of `responsive-dropdown-menu.tsx` — device detection via `useIsMobile()`, ContextMenu on desktop, Drawer on mobile.

**API shape:**

```tsx
<ResponsiveContextMenu>
  <ResponsiveContextMenuTrigger asChild>{children}</ResponsiveContextMenuTrigger>
  <ResponsiveContextMenuContent>
    <ResponsiveContextMenuItem onClick={handler}>
      <Icon className="mr-2 size-4" />
      Label
    </ResponsiveContextMenuItem>
    <ResponsiveContextMenuSeparator />
    <ResponsiveContextMenuItem onClick={handler}>Label</ResponsiveContextMenuItem>
  </ResponsiveContextMenuContent>
</ResponsiveContextMenu>
```

**Desktop path:** Delegates to `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, `ContextMenuSeparator` from `shared/ui/context-menu.tsx`. Right-click triggers the menu.

**Mobile path:** Delegates to `Drawer`, `DrawerTrigger`, `DrawerContent` from `shared/ui/drawer.tsx`. Long-press on the trigger opens the drawer. Menu items render as full-width touch-friendly rows (min-height 44px per WCAG 2.5.5).

**Context pattern:** A `ResponsiveContextMenuContext` React context provides `{ isDesktop, close }` — identical to `ResponsiveDropdownMenuContext`.

**Exports:**

- `ResponsiveContextMenu` — root wrapper
- `ResponsiveContextMenuTrigger` — trigger element (right-click on desktop, long-press on mobile)
- `ResponsiveContextMenuContent` — menu content container
- `ResponsiveContextMenuItem` — individual menu item
- `ResponsiveContextMenuSeparator` — visual separator

### 2. useLongPress Hook (`layers/shared/model/use-long-press.ts`)

Simple pointer-event-based long-press detection for mobile drawer triggers.

```ts
interface UseLongPressOptions {
  /** Delay in ms before the long-press fires. Default: 500. */
  delay?: number;
  /** Called when long-press is detected. */
  onLongPress: () => void;
}

interface UseLongPressReturn {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
}
```

Implementation:

- `onPointerDown`: filter to primary pointer only (`e.button === 0`), start a `setTimeout(delay)`
- `onPointerUp/Leave/Cancel`: clear the timeout
- No external library needed — ~20 lines

### 3. SessionContextMenu Update (`entities/session/ui/SessionContextMenu.tsx`)

Replace direct `ContextMenu` usage with `ResponsiveContextMenu`:

```tsx
// Before
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/layers/shared/ui';

// After
import {
  ResponsiveContextMenu,
  ResponsiveContextMenuTrigger,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuSeparator,
} from '@/layers/shared/ui';
```

The JSX structure stays identical — only the component names change. The early-return for `!onRename && !onFork` is preserved.

### 4. SessionsTab Handler Wiring (`features/agent-hub/ui/tabs/SessionsTab.tsx`)

`SessionsTab` currently renders `SessionsView` without rename/fork handlers. Add them:

```tsx
export function SessionsTab() {
  const { projectPath } = useAgentHubContext();
  const transport = useTransport();
  const queryClient = useQueryClient();
  // ... existing code ...

  const handleForkSession = useCallback(
    async (sessionId: string) => {
      try {
        const forked = await transport.forkSession(sessionId, undefined, projectPath);
        await queryClient.invalidateQueries({ queryKey: ['sessions'] });
        setActiveSession(forked.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to fork session');
      }
    },
    [transport, projectPath, queryClient, setActiveSession]
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      // Optimistic update pattern — see Section 6
    },
    [transport, projectPath, queryClient]
  );

  return (
    <SessionsView
      activeSessionId={activeSessionId}
      groupedSessions={groupedSessions}
      onSessionClick={setActiveSession}
      onForkSession={handleForkSession}
      onRenameSession={handleRenameSession}
    />
  );
}
```

**FSD note:** `SessionsTab` is in `features/agent-hub` and can import from `entities/session` and `shared`. The transport and query client are from `shared/model`, which is allowed.

### 5. AgentListItem + DashboardSidebar Handler Wiring

**DashboardSidebar** (`features/dashboard-sidebar/ui/DashboardSidebar.tsx`) needs new handlers:

```tsx
const handleForkSession = useCallback(
  async (sessionId: string) => {
    try {
      const forked = await transport.forkSession(sessionId, undefined, selectedCwd ?? undefined);
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      handleSessionClick(forked.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to fork session');
    }
  },
  [transport, selectedCwd, queryClient, handleSessionClick]
);

const handleRenameSession = useCallback(
  async (sessionId: string, title: string) => {
    // Optimistic update pattern — see Section 6
  },
  [transport, selectedCwd, queryClient]
);
```

These get passed through `AgentListItem` as new props:

```tsx
interface AgentListItemProps {
  // ... existing props ...
  onForkSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string) => void;
}
```

Then passed down to `SessionRow`:

```tsx
<SessionRow
  variant="compact"
  session={session}
  isActive={session.id === activeSessionId}
  onClick={() => onSessionClick(session.id)}
  onFork={onForkSession}
  onRename={onRenameSession}
/>
```

### 6. Optimistic Rename with useMutation

Extract a reusable `useRenameSession` hook at `entities/session/model/use-rename-session.ts`:

```ts
export function useRenameSession(cwd: string | null) {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      transport.updateSession(sessionId, { title }, cwd ?? undefined),

    onMutate: async ({ sessionId, title }) => {
      await queryClient.cancelQueries({ queryKey: ['sessions'] });
      const previous = queryClient.getQueryData<Session[]>(['sessions', cwd]);

      queryClient.setQueryData<Session[]>(['sessions', cwd], (old) =>
        old?.map((s) => (s.id === sessionId ? { ...s, title } : s))
      );

      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['sessions', cwd], context.previous);
      }
      toast.error('Failed to rename session');
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
```

Usage in all three consumers:

```ts
const renameSession = useRenameSession(selectedCwd);

const handleRenameSession = useCallback(
  (sessionId: string, title: string) => {
    renameSession.mutate({ sessionId, title });
  },
  [renameSession]
);
```

This replaces the existing try/catch + invalidate pattern in `SessionSidebar` and provides the same behavior in `SessionsTab` and `DashboardSidebar`.

### 7. Fork Handler — Shared Pattern

Unlike rename, fork involves navigation after success, which differs per consumer:

- `SessionSidebar`: calls `handleSessionClick(forked.id)` — navigates within session route
- `DashboardSidebar`: calls `handleSessionClick(forked.id)` — same navigation pattern
- `SessionsTab`: calls `setActiveSession(forked.id)` — updates active session in agent hub

Since the navigation callback differs, fork stays as inline `useCallback` in each consumer rather than a shared hook. The transport + invalidation + error toast pattern is simple enough to duplicate across 3 locations.

## File Changes

### New Files

| File                                           | Layer    | Description                       |
| ---------------------------------------------- | -------- | --------------------------------- |
| `shared/ui/responsive-context-menu.tsx`        | shared   | Responsive context menu primitive |
| `shared/model/use-long-press.ts`               | shared   | Long-press detection hook         |
| `entities/session/model/use-rename-session.ts` | entities | Optimistic rename mutation hook   |

### Modified Files

| File                                                 | Change                                                 |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `shared/ui/index.ts`                                 | Export ResponsiveContextMenu components                |
| `shared/model/index.ts`                              | Export useLongPress                                    |
| `entities/session/ui/SessionContextMenu.tsx`         | Use ResponsiveContextMenu instead of ContextMenu       |
| `entities/session/model/index.ts` (if separate)      | Export useRenameSession                                |
| `entities/session/index.ts`                          | Export useRenameSession                                |
| `features/agent-hub/ui/tabs/SessionsTab.tsx`         | Add rename/fork handlers, pass to SessionsView         |
| `features/dashboard-sidebar/ui/AgentListItem.tsx`    | Accept + pass onForkSession, onRenameSession props     |
| `features/dashboard-sidebar/ui/DashboardSidebar.tsx` | Add rename/fork handlers, pass to AgentListItem        |
| `features/session-list/ui/SessionSidebar.tsx`        | Replace handleRenameSession with useRenameSession hook |

### Test Files

| File                                                          | Change                                                |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| `entities/session/__tests__/SessionRow.test.tsx`              | Add tests for responsive context menu (mobile drawer) |
| `features/dashboard-sidebar/__tests__/AgentListItem.test.tsx` | Update mock, test rename/fork callback propagation    |

## Implementation Phases

### Phase 1: Shared Primitives

1. Create `use-long-press.ts` hook
2. Create `responsive-context-menu.tsx` following the `responsive-dropdown-menu.tsx` pattern
3. Export both from their respective barrel files
4. Update `SessionContextMenu` to use `ResponsiveContextMenu`

### Phase 2: Optimistic Rename Hook

1. Create `use-rename-session.ts` with `useMutation` + optimistic update
2. Refactor `SessionSidebar.handleRenameSession` to use the new hook
3. Verify existing rename flow still works (sidebar sessions tab)

### Phase 3: Wire AgentListItem (Dashboard Sidebar)

1. Add `onForkSession`/`onRenameSession` props to `AgentListItem`
2. Add handlers in `DashboardSidebar` (fork as useCallback, rename via useRenameSession)
3. Pass handlers through to `SessionRow` in `AgentListItem`
4. Update `AgentListItem` tests

### Phase 4: Wire SessionsTab (Agent Hub)

1. Add fork handler and rename mutation to `SessionsTab`
2. Pass handlers to `SessionsView`
3. Verify in Agent Hub panel

## Acceptance Criteria

- [ ] Right-click on any SessionRow (full or compact) shows context menu with Rename and Fork
- [ ] On mobile (viewport < 768px), long-press opens a bottom drawer instead of floating menu
- [ ] Rename via context menu activates inline edit mode; Enter commits, Escape cancels
- [ ] Rename is optimistic — title changes instantly, rolls back on error
- [ ] Fork creates a new session and navigates to it
- [ ] Fork shows a toast on error
- [ ] Context menu renders empty (no wrapper) when no callbacks provided
- [ ] All existing SessionRow tests continue to pass
- [ ] New tests cover: responsive context menu mobile/desktop paths, rename/fork in AgentListItem, rename/fork in SessionsTab

## Dependencies

- `@radix-ui/react-context-menu` — already installed
- `vaul` — already installed (used by Drawer)
- `@tanstack/react-query` — already installed (useMutation)
- `sonner` — already installed (toast)

No new dependencies needed.
