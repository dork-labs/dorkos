# State Management Guide

## Overview

This guide covers state management patterns in DorkOS. Zustand manages complex client-side UI state, TanStack Query manages server state via the Transport abstraction, and TanStack Router search params synchronize URL parameters for session/directory state in standalone mode.

## Key Files

| Concept              | Location                                                          |
| -------------------- | ----------------------------------------------------------------- |
| App store (Zustand)  | `apps/client/src/layers/shared/model/app-store.ts`                |
| TransportContext     | `apps/client/src/layers/shared/model/TransportContext.tsx`        |
| Session entity hooks | `apps/client/src/layers/entities/session/`                        |
| Command entity hooks | `apps/client/src/layers/entities/command/`                        |
| Chat feature hooks   | `apps/client/src/layers/features/chat/model/use-chat-session.ts`  |
| URL state (router)   | `apps/client/src/layers/entities/session/model/use-session-id.ts` |
| Theme hook           | `apps/client/src/layers/shared/model/use-theme.ts`                |

## When to Use What

| State Type                 | Tool                                | Example                                                             | Why                                                                                    |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Server state               | TanStack Query                      | Sessions, messages, commands                                        | Handles caching, revalidation, background refetching                                   |
| Complex client state       | Zustand                             | Sidebar open/closed, active panel                                   | Global access, no prop drilling, middleware support                                    |
| Simple UI state            | React useState                      | Modal open/close, toggle visibility                                 | Scoped to component, no persistence needed                                             |
| URL state (standalone)     | TanStack Router search params       | `?session=` ID, `?dir=` working directory                           | Shareable links, browser history, bookmarkable                                         |
| URL state (Obsidian)       | Zustand                             | Session ID, working directory                                       | No URL bar in Obsidian; Zustand replaces router search params                          |
| Persistent client state    | localStorage + useSyncExternalStore | Agent frecency scores (Slack bucket system)                         | Survives page reloads, reactive updates via subscribe/getSnapshot                      |
| Dialog-scoped state        | React useState                      | Pages stack in CommandPaletteDialog                                 | Resets when dialog closes, no persistence needed                                       |
| Debounced derived state    | useDeferredValue                    | Preview panel data during rapid navigation                          | Defers expensive fetches without state management overhead                             |
| Multi-source derived state | TanStack Query + `useMemo`          | Feature flags + entity data combined                                | Each source stays in TanStack Query; derivation happens in a custom hook via `useMemo` |
| Cross-feature signal       | Zustand (entity layer)              | `usePulsePresetDialog` — sidebar triggers dialog in sibling feature | Entity-layer store avoids FSD model cross-import violation                             |

## Core Patterns

### Zustand Store (App Store)

The central UI store lives at `apps/client/src/layers/shared/model/app-store.ts`. It uses the `devtools` middleware for Redux DevTools support and persists boolean preferences to `localStorage` via `readBool`/`writeBool` helpers.

Key state owned by the app store:

- `sidebarOpen` — persisted to localStorage; always `false` on mobile on first load
- `previousCwd` — transient; used by command palette for "switch back" suggestions
- Dialog open states (`settingsOpen`, `pulseOpen`, `relayOpen`, `meshOpen`, etc.) — transient, not persisted
- `selectedCwd` — writes to `recentCwds` in localStorage on change
- UI preferences (`showTimestamps`, `expandToolCalls`, font size/family, etc.) — persisted

```typescript
// apps/client/src/layers/shared/model/app-store.ts
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export const useAppStore = create<AppState>()(
  devtools(
    (set) => ({
      sidebarOpen: readBool('dorkos-sidebar-open', false),
      toggleSidebar: () =>
        set((s) => {
          const next = !s.sidebarOpen;
          writeBool('dorkos-sidebar-open', next);
          return { sidebarOpen: next };
        }),
      previousCwd: null,
      setPreviousCwd: (cwd) => set({ previousCwd: cwd }),
      // ...many more fields
    }),
    { name: 'app-store' }
  )
);
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

### URL State with TanStack Router (Standalone Mode)

In standalone web mode, `?session=` and `?dir=` persist in the URL via TanStack Router's `validateSearch` and `Route.useSearch()`:

```typescript
// apps/client/src/layers/entities/session/model/use-session-id.ts
import { useSessionSearch } from './use-session-search';
import { useNavigate } from '@tanstack/react-router';

export function useSessionId(): [string | null, (id: string | null) => void] {
  const { session } = useSessionSearch();
  const navigate = useNavigate();
  const setSessionId = (id: string | null) => {
    navigate({ search: (prev) => ({ ...prev, session: id ?? undefined }) });
  };
  return [session ?? null, setSessionId];
}
```

In Obsidian embedded mode, the same hooks use Zustand instead of TanStack Router (no URL bar available). The `?dir=` parameter is omitted when using the server's default directory to keep URLs clean.

### Persistent Client State with useSyncExternalStore

For persistent client state that needs external subscription semantics (e.g., localStorage-backed frecency scores), use React's `useSyncExternalStore`:

```typescript
// apps/client/src/layers/features/command-palette/model/use-agent-frecency.ts
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'dorkos:agent-frecency-v2';

interface FrecencyRecord {
  agentId: string;
  timestamps: number[]; // epoch ms, most recent first, max 10
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
  listeners.forEach((l) => l()); // Notify React
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
    () => sessions?.filter((s) => s.cwd === agentCwd) ?? [],
    [sessions, agentCwd]
  );

  return { sessionCount: agentSessions.length, health };
}
```

**When to use**: Debouncing expensive effects (API calls, heavy computations) triggered by rapid input changes. The deferred value keeps UI responsive during typing but maintains correctness after input settles.

### Multi-Source Derived State

When a component needs state computed from multiple independent server queries, create a dedicated hook that combines them:

```typescript
// Pattern: useAgentToolStatus combines agent manifest + feature flags
function useAgentToolStatus() {
  const { data: agent } = useCurrentAgent(); // TanStack Query
  const pulseEnabled = usePulseEnabled(); // TanStack Query
  const relayEnabled = useRelayEnabled(); // TanStack Query

  return useMemo(
    () => ({
      pulse: !pulseEnabled
        ? 'disabled-by-server'
        : agent?.enabledToolGroups?.pulse === false
          ? 'disabled-by-agent'
          : 'enabled',
      // ... similar for relay, mesh, adapter
    }),
    [agent, pulseEnabled, relayEnabled]
  );
}
```

**Anti-pattern:** Do NOT use `useEffect` to sync derived state into a separate `useState`. This causes unnecessary re-renders and state synchronization bugs. Use `useMemo` instead.

```typescript
// ❌ useEffect + useState for derived state — causes extra renders and sync bugs
const [toolStatus, setToolStatus] = useState({});
useEffect(() => {
  setToolStatus({ pulse: computeStatus(agent, pulseEnabled) });
}, [agent, pulseEnabled]);

// ✅ useMemo — derived inline, no extra state, no sync issues
const toolStatus = useMemo(
  () => ({ pulse: computeStatus(agent, pulseEnabled) }),
  [agent, pulseEnabled]
);
```

### Cross-Feature Signal Stores (Entity Layer)

When one feature needs to trigger a dialog or action in a sibling feature, FSD's model cross-import rules forbid `features/A` from importing `features/B`'s model. The solution: put a small Zustand store in the `entities/` layer. Both features can read from it without creating a circular dependency.

```typescript
// apps/client/src/layers/entities/pulse/model/use-pulse-preset-dialog.ts
// Lives in entities/ so both features/pulse and features/session-list can use it.

export const usePulsePresetDialog = create<PulsePresetDialogState>((set) => ({
  pendingPreset: null,
  externalTrigger: false,
  openWithPreset: (preset) => set({ pendingPreset: preset, externalTrigger: true }),
  clear: () => set({ pendingPreset: null, externalTrigger: false }),
}));
```

Usage pattern:

```typescript
// In features/session-list/ui/SchedulesView.tsx — triggers the dialog
const openWithPreset = usePulsePresetDialog((s) => s.openWithPreset);
openWithPreset(preset); // Signals PulsePanel to open CreateScheduleDialog

// In features/pulse/ui/PulsePanel.tsx — consumes the signal
const { pendingPreset, externalTrigger, clear } = usePulsePresetDialog();
useEffect(() => {
  if (externalTrigger && pendingPreset) {
    openDialog({ preset: pendingPreset });
    clear();
  }
}, [externalTrigger, pendingPreset]);
```

**When to use**: A sibling feature needs to trigger a UI action (open a dialog, navigate to a view) in another feature, and lifting the state higher would add unnecessary coupling. Keep these stores small — just the signal payload and a `clear()` method.

### Combining Zustand with TanStack Query

```typescript
import { useQuery } from '@tanstack/react-query';
import { useAppStore } from '@/layers/shared/model';
import { useTransport } from '@/layers/shared/model';

export function AgentSidebar() {
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

// ✅ Use TanStack Router search params for URL-synchronized state (shareable, bookmarkable)
import { useSessionSearch } from './use-session-search';
import { useNavigate } from '@tanstack/react-router';

export function useSessionId() {
  const { session } = useSessionSearch();
  const navigate = useNavigate();
  const setSessionId = (id: string | null) => {
    navigate({ search: (prev) => ({ ...prev, session: id ?? undefined }) });
  };
  return [session ?? null, setSessionId];
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
   import { devtools } from 'zustand/middleware';

   interface MyState {
     value: string;
     setValue: (value: string) => void;
   }

   export const useMyStore = create<MyState>()(
     devtools(
       (set) => ({
         value: '',
         setValue: (value) => set({ value }),
       }),
       { name: 'my-store' }
     )
   );
   ```

   Use `devtools` middleware for any store that would benefit from Redux DevTools inspection. The `name` field appears as the store label in DevTools.

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
addItem: (item) => set((state) => ({ items: [...state.items, item] }));
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

**Cause**: Using Zustand instead of TanStack Router search params for URL-synced state in standalone mode.
**Fix**: Use `useSessionSearch()` / `useNavigate()` from TanStack Router for state that should persist in the URL.

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
- [TanStack Router Documentation](https://tanstack.com/router/latest) - Type-safe routing and URL search params for React
- [useSyncExternalStore (React docs)](https://react.dev/reference/react/useSyncExternalStore) - External state subscription pattern
- [useDeferredValue (React docs)](https://react.dev/reference/react/useDeferredValue) - High-frequency update debouncing
- [Slack Engineering — A Faster, Smarter Quick Switcher](https://slack.engineering/a-faster-smarter-quick-switcher/) - Bucket frecency algorithm
