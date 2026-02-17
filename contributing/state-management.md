# State Management Guide

## Overview

This guide covers state management patterns in DorkOS. Zustand manages complex client-side UI state, TanStack Query manages server state via the Transport abstraction, and nuqs synchronizes URL parameters for session/directory state in standalone mode.

## Key Files

| Concept              | Location                                                          |
| -------------------- | ----------------------------------------------------------------- |
| App store (Zustand)  | `apps/client/src/layers/shared/model/app-store.ts`                |
| TransportContext     | `apps/client/src/layers/shared/model/TransportContext.tsx`        |
| Session entity hooks | `apps/client/src/layers/entities/session/`                        |
| Command entity hooks | `apps/client/src/layers/entities/command/`                        |
| Chat feature hooks   | `apps/client/src/layers/features/chat/model/use-chat-session.ts` |
| URL state (nuqs)     | `apps/client/src/layers/entities/session/model/use-session-id.ts` |
| Theme hook           | `apps/client/src/layers/shared/model/use-theme.ts`               |

## When to Use What

| State Type               | Tool            | Example                                     | Why                                                        |
| ------------------------ | --------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Server state             | TanStack Query  | Sessions, messages, commands                | Handles caching, revalidation, background refetching       |
| Complex client state     | Zustand         | Sidebar open/closed, active panel           | Global access, no prop drilling, middleware support         |
| Simple UI state          | React useState  | Modal open/close, toggle visibility         | Scoped to component, no persistence needed                 |
| URL state (standalone)   | nuqs            | `?session=` ID, `?dir=` working directory   | Shareable links, browser history, bookmarkable             |
| URL state (Obsidian)     | Zustand         | Session ID, working directory               | No URL bar in Obsidian; Zustand replaces nuqs              |

## Core Patterns

### Zustand Store (App Store)

The central UI store lives at `apps/client/src/layers/shared/model/app-store.ts`:

```typescript
// apps/client/src/layers/shared/model/app-store.ts
import { create } from 'zustand';

interface AppState {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
}));
```

### Using Selectors (Prevent Re-renders)

```typescript
import { useAppStore } from '@/layers/shared/model';

export function Sidebar() {
  // ✅ Use selectors — only re-renders when this specific value changes
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);

  if (!sidebarOpen) return null;

  return (
    <aside>
      <button onClick={toggleSidebar}>Close</button>
      {/* sidebar content */}
    </aside>
  );
}
```

### Server State with TanStack Query

Server state is managed through entity hooks in the `entities/` FSD layer:

```typescript
// apps/client/src/layers/entities/session/model/use-sessions.ts
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export function useSessions(cwd?: string) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['sessions', cwd],
    queryFn: () => transport.listSessions(cwd),
    refetchInterval: 30_000,
  });
}
```

### URL State with nuqs (Standalone Mode)

In standalone web mode, `?session=` and `?dir=` persist in the URL via nuqs:

```typescript
// apps/client/src/layers/entities/session/model/use-session-id.ts
import { useQueryState } from 'nuqs';

export function useSessionId() {
  // Syncs session ID to/from URL: ?session=<uuid>
  const [sessionId, setSessionId] = useQueryState('session');
  return { sessionId, setSessionId };
}
```

In Obsidian embedded mode, the same hooks use Zustand instead of nuqs (no URL bar available). The `?dir=` parameter is omitted when using the server's default directory to keep URLs clean.

### Combining Zustand with TanStack Query

```typescript
import { useQuery } from '@tanstack/react-query';
import { useAppStore } from '@/layers/shared/model';
import { useTransport } from '@/layers/shared/model';

export function SessionSidebar() {
  const transport = useTransport();

  // Server state (sessions from API) — TanStack Query
  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => transport.listSessions(),
  });

  // Client state (sidebar visibility) — Zustand
  const sidebarOpen = useAppStore((state) => state.sidebarOpen);

  if (!sidebarOpen) return null;

  return (
    <ul>
      {sessions?.map((session) => (
        <li key={session.id}>{session.title}</li>
      ))}
    </ul>
  );
}
```

## Anti-Patterns

```typescript
// ❌ NEVER use Zustand for server state
export const useSessionStore = create((set) => ({
  sessions: [],
  fetchSessions: async () => {
    const sessions = await transport.listSessions();
    set({ sessions }); // Stale data, no cache invalidation, no background refetch
  },
}));

// ✅ Use TanStack Query for server state
export function useSessions() {
  const transport = useTransport();
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => transport.listSessions(),
  });
}
```

```typescript
// ❌ Don't destructure the entire store (causes re-renders on ANY state change)
const { sidebarOpen, setSidebarOpen, toggleSidebar } = useAppStore();

// ✅ Use selectors for each value
const sidebarOpen = useAppStore((state) => state.sidebarOpen);
const toggleSidebar = useAppStore((state) => state.toggleSidebar);
```

```typescript
// ❌ Don't store derived state
export const useAppStore = create((set, get) => ({
  items: [],
  count: 0, // Gets out of sync!
  addItem: (item) =>
    set((state) => ({
      items: [...state.items, item],
      count: state.count + 1, // Manual tracking, bug-prone
    })),
}));

// ✅ Compute derived values on demand
export const useAppStore = create((set, get) => ({
  items: [],
  getCount: () => get().items.length,
}));
```

```typescript
// ❌ Don't use Zustand for URL-synchronized state in standalone mode
export const useFilterStore = create((set) => ({
  sessionId: null,
  setSessionId: (id) => set({ sessionId: id }),
}));

// ✅ Use nuqs for URL-synchronized state (shareable, bookmarkable)
import { useQueryState } from 'nuqs';

export function useSessionId() {
  const [sessionId, setSessionId] = useQueryState('session');
  return { sessionId, setSessionId };
}
```

## Adding a New Store

1. **Determine if you need a store**: Check the decision matrix above. Most state should be TanStack Query (server) or useState (local UI).

2. **Create the store** in `apps/client/src/layers/shared/model/`:

   ```typescript
   // apps/client/src/layers/shared/model/my-store.ts
   import { create } from 'zustand';

   interface MyState {
     value: string;
     setValue: (value: string) => void;
   }

   export const useMyStore = create<MyState>((set) => ({
     value: '',
     setValue: (value) => set({ value }),
   }));
   ```

3. **Export from barrel**: Add to `apps/client/src/layers/shared/model/index.ts`

4. **Use in components**: Import from the barrel

   ```typescript
   import { useMyStore } from '@/layers/shared/model';
   ```

## Troubleshooting

### Store updates not triggering re-renders

**Cause**: Mutating state directly instead of using `set()`:

```typescript
// ❌ Direct mutation doesn't trigger re-renders
addItem: (item) => {
  get().items.push(item); // Mutates in place
};

// ✅ Create new reference
addItem: (item) =>
  set((state) => ({ items: [...state.items, item] }));
```

### Component re-renders on every store update

**Cause**: Not using selectors, or selecting too much state:

```typescript
// ❌ Re-renders on ANY store change
const store = useAppStore();

// ✅ Only re-renders when sidebarOpen changes
const sidebarOpen = useAppStore((state) => state.sidebarOpen);
```

### URL state not persisting after navigation

**Cause**: Using Zustand instead of nuqs for URL-synced state in standalone mode.
**Fix**: Use `useQueryState` from nuqs for state that should persist in the URL.

### "Cannot use store outside React components"

**Cause**: Trying to call `useAppStore()` in a non-React function.
**Fix**: Use `getState()` for non-React usage:

```typescript
import { useAppStore } from '@/layers/shared/model';

// Non-React usage
const currentState = useAppStore.getState();
```

## References

- [Data Fetching Guide](./data-fetching.md) - TanStack Query patterns and Transport abstraction
- [Architecture Guide](./architecture.md) - Transport interface, dependency injection
- [Zustand Documentation](https://docs.pmnd.rs/zustand/getting-started/introduction)
- [nuqs Documentation](https://nuqs.47ng.com/) - Type-safe URL query state for React
