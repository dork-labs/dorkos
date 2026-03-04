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
| Persistent client state  | localStorage + useSyncExternalStore | Agent frecency scores (Slack bucket system)  | Survives page reloads, reactive updates via subscribe/getSnapshot |
| Dialog-scoped state      | React useState  | Pages stack in CommandPaletteDialog          | Resets when dialog closes, no persistence needed           |
| Debounced derived state  | useDeferredValue | Preview panel data during rapid navigation  | Defers expensive fetches without state management overhead |

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
  previousCwd: string | null;
  setPreviousCwd: (cwd: string | null) => void;
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

### Persistent Client State with useSyncExternalStore

For persistent client state that needs external subscription semantics (e.g., localStorage-backed frecency scores), use React's `useSyncExternalStore`:

```typescript
// apps/client/src/layers/features/command-palette/model/use-agent-frecency.ts
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'dorkos:agent-frecency-v2';

interface FrecencyRecord {
  agentId: string;
  timestamps: number[];  // epoch ms, most recent first, max 10
  totalCount: number;
}

// Singleton storage manager with subscribe/getSnapshot pattern
let listeners = new Set<() => void>();
let snapshot: FrecencyRecord[] = loadFromStorage();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

function recordVisit(agentId: string) {
  // ... update record, persist to localStorage
  snapshot = [...updatedRecords];
  listeners.forEach(l => l()); // Notify React
}

export function useAgentFrecency() {
  const data = useSyncExternalStore(subscribe, getSnapshot);
  return { data, recordVisit };
}
```

**When to use**: Client state that needs external subscribers (localStorage observers), custom unsubscribe semantics, or synchronization with non-React state systems.

### Debouncing with useDeferredValue

For high-frequency state changes that trigger expensive computations (like data fetches during rapid keyboard navigation), use React's `useDeferredValue`:

```typescript
import { useDeferredValue, useMemo } from 'react';

export function usePreviewData(agentId: string, agentCwd: string) {
  const deferredAgentId = useDeferredValue(agentId);
  const { data: health } = useMeshAgentHealth(deferredAgentId);
  const { data: sessions } = useSessions();

  const agentSessions = useMemo(
    () => sessions?.filter(s => s.cwd === agentCwd) ?? [],
    [sessions, agentCwd]
  );

  return { sessionCount: agentSessions.length, health };
}
```

**When to use**: Debouncing expensive effects (API calls, heavy computations) triggered by rapid input changes. The deferred value keeps UI responsive during typing but maintains correctness after input settles.

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

```typescript
// ❌ Don't store dialog-scoped state in global Zustand
export const usePaletteStore = create((set) => ({
  pages: [],
  setPages: (pages) => set({ pages }),
}));
// Problem: pages state persists across dialog close/open cycles

// ✅ Keep dialog-scoped state local to the component
export function CommandPaletteDialog() {
  const [pages, setPages] = useState<string[]>([]);
  // State resets when dialog closes — correct behavior
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
- [useSyncExternalStore (React docs)](https://react.dev/reference/react/useSyncExternalStore) - External state subscription pattern
- [useDeferredValue (React docs)](https://react.dev/reference/react/useDeferredValue) - High-frequency update debouncing
- [Slack Engineering — A Faster, Smarter Quick Switcher](https://slack.engineering/a-faster-smarter-quick-switcher/) - Bucket frecency algorithm
