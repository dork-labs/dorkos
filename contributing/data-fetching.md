# Data Fetching Guide

## Overview

This guide covers data fetching patterns in DorkOS. The client uses TanStack Query for server-state management, communicating through the Transport abstraction layer (HttpTransport for standalone web, DirectTransport for Obsidian plugin). The server exposes Express routes that delegate to services.

## Key Files

| Concept                  | Location                                                         |
| ------------------------ | ---------------------------------------------------------------- |
| Transport interface      | `packages/shared/src/transport.ts`                               |
| HttpTransport            | `apps/client/src/layers/shared/lib/transport/http-transport.ts`  |
| DirectTransport          | `apps/client/src/layers/shared/lib/direct-transport.ts`          |
| TransportContext         | `apps/client/src/layers/shared/model/TransportContext.tsx`       |
| EventStreamProvider      | `apps/client/src/layers/shared/model/event-stream-context.tsx`   |
| Session entity hooks     | `apps/client/src/layers/entities/session/`                       |
| Command entity hooks     | `apps/client/src/layers/entities/command/`                       |
| Agent entity hooks       | `apps/client/src/layers/entities/agent/`                         |
| Runtime entity hooks     | `apps/client/src/layers/entities/runtime/`                       |
| Relay entity hooks       | `apps/client/src/layers/entities/relay/`                         |
| Binding entity hooks     | `apps/client/src/layers/entities/binding/`                       |
| Tasks entity hooks       | `apps/client/src/layers/entities/tasks/`                         |
| Marketplace entity hooks | `apps/client/src/layers/entities/marketplace/`                   |
| Chat feature hooks       | `apps/client/src/layers/features/chat/model/use-chat-session.ts` |
| Express routes           | `apps/server/src/routes/`                                        |
| Zod schemas              | `packages/shared/src/schemas.ts`                                 |

## When to Use What

| Scenario                                               | Approach                                     | Why                                                                |
| ------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| List/read server data (sessions, etc.)                 | TanStack Query + Transport method            | Caching, deduplication, background refetch                         |
| Send a chat message (streaming)                        | `useChatSession` hook + SSE                  | Real-time streaming, handles all event types                       |
| Mutate server data (create session)                    | `useMutation` + Transport method             | Automatic cache invalidation, optimistic updates                   |
| Subscribe to real-time updates                         | SSE via `GET /api/sessions/:id/stream`       | Multi-client sync, file-watcher backed                             |
| Subscribe to system events (tunnel, relay, extensions) | `useEventSubscription` via `GET /api/events` | Single multiplexed connection, replaces per-resource SSE endpoints |
| Static config/health check                             | Transport method (no TanStack Query)         | One-shot, no caching needed                                        |

## Core Patterns

### Reading Data with TanStack Query

Entity hooks in `apps/client/src/layers/entities/` wrap TanStack Query with Transport calls:

```typescript
// apps/client/src/layers/entities/session/model/use-sessions.ts
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export function useSessions(cwd?: string) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['sessions', cwd],
    queryFn: () => transport.listSessions(cwd),
    refetchInterval: 30_000, // Poll every 30s for new sessions
    refetchIntervalInBackground: false, // Pause polling when tab is hidden
  });
}
```

**Background-tab optimization:** All hooks that use `refetchInterval` should also set `refetchIntervalInBackground: false` to prevent unnecessary network requests when the browser tab is hidden. This convention is enforced across `useSessions`, `useRuns`, `useRelayAdapters`, `useTunnelStatus`, and other polling hooks.

### Sending Messages with SSE Streaming

The `useChatSession` hook manages the full message lifecycle:

```typescript
// apps/client/src/layers/features/chat/model/use-chat-session.ts
// Simplified — the real hook handles tool calls, approvals, questions, etc.

const handleSubmit = async (content: string) => {
  const abortController = new AbortController();

  await transport.sendMessage(
    sessionId,
    content,
    (event: StreamEvent) => {
      switch (event.type) {
        case 'text_delta':
          // Append text to current assistant message
          break;
        case 'tool_call_start':
          // Track new tool invocation
          break;
        case 'approval_required':
          // Show approval UI
          break;
        case 'done':
          // Finalize message
          break;
      }
    },
    abortController.signal,
    cwd
  );
};
```

### Mutations with Cache Invalidation

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export function useCreateSession() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (opts: { cwd?: string }) => transport.createSession(opts),
    onSuccess: () => {
      // Invalidate session list so it refetches
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
```

### Transport Abstraction

All data fetching goes through the Transport interface — never call `fetch()` directly from components:

```typescript
// ❌ NEVER fetch directly in components
const response = await fetch('/api/sessions');

// ✅ Always use Transport via context
const transport = useTransport();
const sessions = await transport.listSessions();
```

This ensures the same React code works in both standalone web (HTTP) and Obsidian plugin (in-process) modes.

### SSE Streaming Protocol

Messages stream from the server as Server-Sent Events:

```
POST /api/sessions/:id/messages
Content-Type: application/json

{ "content": "Hello", "cwd": "/path/to/project" }

Response: text/event-stream
data: {"type":"text_delta","delta":"Hello"}
data: {"type":"tool_call_start","toolCallId":"tc_1","toolName":"Read"}
data: {"type":"tool_result","toolCallId":"tc_1","result":"..."}
data: {"type":"done"}
```

### Session Sync (Multi-Client)

Clients subscribe to real-time changes via a persistent SSE connection:

```typescript
// GET /api/sessions/:id/stream
// Events:
//   sync_connected  — initial connection confirmed
//   sync_update     — new content written to JSONL file

// On sync_update, re-fetch messages with ETag caching:
const response = await transport.getMessages(sessionId);
// Server returns 304 if no changes (ETag match)
```

### Real-Time System Events (Unified SSE Stream)

System-wide events (tunnel status changes, extension reloads, relay activity) are delivered through a single multiplexed SSE connection rather than per-resource streams.

**Endpoint**: `GET /api/events` — one SSE connection carries all system event types. The server multiplexes tunnel, extensions, and relay events onto this single stream.

**Provider**: `EventStreamProvider` (in `layers/shared/model/event-stream-context.tsx`) manages a module-level `SSEConnection` singleton. It is mounted once in `main.tsx`. The singleton survives React StrictMode double-mounts and Vite HMR cycles.

**Consumer hook**: `useEventSubscription(eventName, handler)` — subscribes to a named event for the lifetime of the calling component. The handler is ref-stabilized, so its identity can change between renders without causing re-subscriptions.

**Available events**:

| Event                | Payload            | Source           |
| -------------------- | ------------------ | ---------------- |
| `tunnel_status`      | `TunnelStatus`     | Tunnel service   |
| `extension_reloaded` | Extension metadata | Extension loader |
| `relay_connected`    | Connection info    | Relay service    |
| `relay_message`      | Message envelope   | Relay service    |
| `relay_backpressure` | Backpressure data  | Relay service    |
| `relay_signal`       | Signal data        | Relay service    |

**Example** — invalidating TanStack Query cache on tunnel status changes:

```typescript
// apps/client/src/layers/entities/tunnel/model/use-tunnel-sync.ts
import { useQueryClient } from '@tanstack/react-query';
import { useEventSubscription } from '@/layers/shared/model';
import type { TunnelStatus } from '@dorkos/shared/types';

export function useTunnelSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('tunnel_status', (data) => {
    queryClient.setQueryData(['tunnel-status'], data as TunnelStatus);
    queryClient.invalidateQueries({ queryKey: ['config'] });
  });
}
```

**Example** — relay event stream with conditional invalidation:

```typescript
// apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts
import { useEventSubscription } from '@/layers/shared/model';

export function useRelayEventStream(enabled: boolean) {
  const queryClient = useQueryClient();

  useEventSubscription('relay_message', () => {
    if (enabled) {
      queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
    }
  });

  useEventSubscription('relay_signal', () => {
    if (enabled) {
      queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
    }
  });
}
```

> **Migration note**: The unified stream replaces raw `new EventSource('/api/tunnel/stream')` and `useSSEConnection('/api/relay/stream')` patterns that each opened a dedicated HTTP connection. Use `useEventSubscription('event_name', handler)` instead for all system-wide events. `useSSEConnection` still exists for per-session SSE (e.g., `GET /api/sessions/:id/stream` for session sync) but should **not** be used for system-wide events.

### ETag Caching on Messages

The `GET /api/sessions/:id/messages` endpoint supports `If-None-Match` / `304` for efficient polling:

```typescript
// HttpTransport handles ETags automatically
// TanStack Query's refetchInterval triggers periodic checks
// Server returns 304 when content hasn't changed, saving bandwidth
```

### Debouncing Fetches with useDeferredValue

For high-frequency state changes (e.g., rapid arrow key navigation through a list), use `useDeferredValue` to prevent fetch thrashing:

```typescript
// apps/client/src/layers/features/command-palette/model/use-preview-data.ts
import { useDeferredValue, useMemo } from 'react';

export function usePreviewData(agentId: string, agentCwd: string) {
  // Defers the agent ID — prevents preview fetches on every keystroke
  const deferredAgentId = useDeferredValue(agentId);

  const { data: sessions } = useSessions();
  const { data: health } = useMeshAgentHealth(deferredAgentId);

  // Derived data via useMemo — recomputes only when dependencies change
  const agentSessions = useMemo(
    () => sessions?.filter((s) => s.cwd === agentCwd) ?? [],
    [sessions, agentCwd]
  );

  return {
    sessionCount: agentSessions.length,
    recentSessions: agentSessions.slice(0, 3),
    health: health ?? null,
  };
}
```

**When to use**: Debouncing expensive effects (API calls, heavy computations) triggered by rapid input changes. The deferred value keeps UI responsive during typing/navigation but maintains correctness after input settles. Prefer over manual `setTimeout`/`useEffect` debounce patterns.

### Data Aggregation Hooks

When multiple TanStack Query hooks need to be composed into a single derived result, create a custom hook that combines them with `useMemo`:

```typescript
export function usePreviewData(agentId: string, agentCwd: string) {
  const { data: sessions } = useSessions(); // TanStack Query
  const { data: health } = useMeshAgentHealth(agentId); // TanStack Query

  // Derive filtered + sliced data via useMemo
  const agentSessions = useMemo(
    () => sessions?.filter((s) => s.cwd === agentCwd) ?? [],
    [sessions, agentCwd]
  );

  return { sessionCount: agentSessions.length, recentSessions: agentSessions.slice(0, 3), health };
}
```

This pattern centralizes the aggregation logic, avoids scattered queries, and lets TanStack Query handle caching/refetching for each underlying data source independently.

### Multi-Source Derived Hooks (Feature Flags + Server State)

When a hook needs to combine TanStack Query data with non-query state (feature flags, config), use `useMemo` to produce a derived result:

```typescript
// apps/client/src/layers/entities/agent/model/use-agent-tool-status.ts
export function useAgentToolStatus(projectPath: string | null): AgentToolStatus {
  const { data: agent } = useCurrentAgent(projectPath); // TanStack Query
  const relayEnabled = useRelayEnabled(); // Feature flag (config query)
  const pulseEnabled = usePulseEnabled(); // Feature flag (config query)

  return useMemo((): AgentToolStatus => {
    const groups = agent?.enabledToolGroups ?? {};
    return {
      pulse: !pulseEnabled
        ? 'disabled-by-server'
        : groups.pulse === false
          ? 'disabled-by-agent'
          : 'enabled',
      relay: !relayEnabled
        ? 'disabled-by-server'
        : groups.relay === false
          ? 'disabled-by-agent'
          : 'enabled',
      mesh: groups.mesh === false ? 'disabled-by-agent' : 'enabled',
      adapter: !relayEnabled
        ? 'disabled-by-server'
        : groups.adapter === false
          ? 'disabled-by-agent'
          : 'enabled',
    };
  }, [agent, relayEnabled, pulseEnabled]);
}
```

This pattern is useful when the derived state depends on multiple independent sources with different update frequencies. Each source updates independently (agent manifest changes infrequently, feature flags almost never), but the derived value recomputes correctly via `useMemo` dependency tracking.

### Pre-loading Data with staleTime

For UI elements that need data immediately on open (e.g., command palette), pre-load data via TanStack Query with explicit `staleTime` to avoid unnecessary refetches:

```typescript
// Data is loaded before the palette opens; staleTime prevents refetch on mount
const { data: agents } = useRegisteredAgents({ staleTime: 30_000 });
const { data: sessions } = useSessions({ staleTime: 30_000 });
```

`staleTime: 30_000` means TanStack Query considers the data fresh for 30 seconds. If the user opens the palette within that window, it uses cached data without a network request. After 30 seconds, a background refetch occurs on next access.

## Anti-Patterns

```typescript
// ❌ NEVER bypass Transport to call fetch() directly
async function getSessions() {
  const res = await fetch('/api/sessions'); // Breaks in Obsidian plugin
  return res.json();
}

// ✅ Always go through Transport
function useSessions() {
  const transport = useTransport();
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => transport.listSessions(), // Works in both modes
  });
}
```

```typescript
// ❌ Don't forget to invalidate queries after mutations
const mutation = useMutation({
  mutationFn: (id: string) => transport.approveTool(sessionId, id),
  // Missing onSuccess — UI shows stale approval state
});

// ✅ Always invalidate affected queries
const mutation = useMutation({
  mutationFn: (id: string) => transport.approveTool(sessionId, id),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['messages', sessionId] });
  },
});
```

```typescript
// ❌ Don't use hardcoded query keys
useQuery({ queryKey: ['sessions'], ... });
useQuery({ queryKey: ['sessions'], ... }); // Duplicate, easy to drift

// ✅ Use consistent key patterns across entity hooks
// All session queries use ['sessions', ...params] prefix
// All command queries use ['commands', ...params] prefix
```

## Troubleshooting

### "TypeError: transport.listSessions is not a function"

**Cause**: Component rendered outside `TransportProvider` context.
**Fix**: Ensure your component tree is wrapped with `TransportProvider`. In tests, use `createMockTransport()` from `@dorkos/test-utils`.

### Stale data after creating a session

**Cause**: TanStack Query cache not invalidated after mutation.
**Fix**: Add `onSuccess` to invalidate the `['sessions']` query key.

### SSE connection drops silently

**Cause**: Network interruption or server restart.
**Fix**: The `useChatSession` hook handles reconnection for chat streams. If messages stop arriving, the session sync protocol (`sync_update` events) will catch up when the connection is restored.

For system-wide SSE events (tunnel, relay, extensions), reconnection is handled automatically by the `SSEConnection` singleton managed by `EventStreamProvider` — individual consumer hooks do not need to manage reconnection. The singleton includes exponential backoff, a heartbeat watchdog, and page visibility optimization (pauses when the tab is hidden, reconnects when it becomes visible).

### Messages endpoint returns 304 but UI is stale

**Cause**: ETag mismatch between cached and actual content.
**Fix**: Force refetch by invalidating the query: `queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })`.

## Agent Entity Hooks

The agent entity layer (`entities/agent/`) provides hooks for agent identity, independent of Mesh. These work whenever a `.dork/agent.json` file exists in the working directory.

### Query Key Factory

```typescript
// apps/client/src/layers/entities/agent/api/queries.ts
export const agentKeys = {
  all: ['agents'] as const,
  byPath: (path: string) => ['agents', 'byPath', path] as const,
  resolved: (paths: string[]) => ['agents', 'resolved', ...paths] as const,
};
```

### useCurrentAgent

Fetches the agent manifest for a working directory. Returns `null` when no agent is registered. Uses a 60-second stale time since agent config changes infrequently.

```typescript
// apps/client/src/layers/entities/agent/model/use-current-agent.ts
export function useCurrentAgent(cwd: string | null) {
  const transport = useTransport();
  return useQuery<AgentManifest | null>({
    queryKey: agentKeys.byPath(cwd ?? ''),
    queryFn: () => transport.getAgentByPath(cwd!),
    enabled: !!cwd,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
```

### useUpdateAgent

Mutation with optimistic updates. Reverts to previous data on error.

```typescript
// apps/client/src/layers/entities/agent/model/use-update-agent.ts
export function useUpdateAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (opts: { path: string; updates: Partial<AgentManifest> }) =>
      transport.updateAgentByPath(opts.path, opts.updates),
    onMutate: async ({ path, updates }) => {
      await queryClient.cancelQueries({ queryKey: agentKeys.byPath(path) });
      const previous = queryClient.getQueryData<AgentManifest | null>(agentKeys.byPath(path));
      if (previous) {
        queryClient.setQueryData(agentKeys.byPath(path), { ...previous, ...updates });
      }
      return { previous };
    },
    onError: (_err, { path }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(agentKeys.byPath(path), context.previous);
      }
    },
    onSettled: (_data, _err, { path }) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.byPath(path) });
    },
  });
}
```

### useResolvedAgents

Batch-resolves agents for multiple paths in a single request. Used by DirectoryPicker to show agent names in recents.

```typescript
// apps/client/src/layers/entities/agent/model/use-resolved-agents.ts
export function useResolvedAgents(paths: string[]) {
  const transport = useTransport();
  return useQuery({
    queryKey: agentKeys.resolved(paths),
    queryFn: () => transport.resolveAgents(paths),
    enabled: paths.length > 0,
    staleTime: 60_000,
  });
}
```

## Session Entity: useModels

Available models are fetched via `useModels()` in `entities/session/`. Models rarely change so the query uses a long `staleTime` (30 minutes):

```typescript
// apps/client/src/layers/entities/session/model/use-models.ts
export function useModels() {
  const transport = useTransport();
  return useQuery<ModelOption[]>({
    queryKey: ['models'],
    queryFn: () => transport.getModels(),
    staleTime: 30 * 60 * 1000,
  });
}
```

The server delegates to `runtimeRegistry.getDefault().getSupportedModels()` via `GET /api/models`.

## Session Entity: useSubagents

Available subagents are fetched via `useSubagents()` in `entities/session/`. Same non-blocking pattern as `useModels()` — long `staleTime` (30 minutes) since subagent sets rarely change between sessions:

```typescript
// apps/client/src/layers/entities/session/model/use-subagents.ts
export function useSubagents() {
  const transport = useTransport();
  return useQuery<SubagentInfo[]>({
    queryKey: ['subagents'],
    queryFn: () => transport.getSubagents(),
    staleTime: 30 * 60 * 1000,
  });
}
```

The server delegates to `runtimeRegistry.getDefault().getSupportedSubagents()` via `GET /api/subagents`. Values are cached by `RuntimeCache` and refreshed on `reloadPlugins()`.

## Session Chat Store (Zustand)

Per-session chat state is stored in a global Zustand store (`useSessionChatStore`) rather than in component state. This decouples chat state from the React component lifecycle so sessions can stream concurrently, resume instantly on switch, and expose background activity indicators in the sidebar.

**File:** `apps/client/src/layers/entities/session/model/session-chat-store.ts`

### Why Zustand here instead of TanStack Query

TanStack Query manages _server state_ (sessions list, messages, models). The session chat store manages _client-side streaming state_ that doesn't come from an API response:

| State                                     | Managed by            |
| ----------------------------------------- | --------------------- |
| Session list, message history             | TanStack Query        |
| Streaming messages, tool call parts       | `useSessionChatStore` |
| Input drafts, status (`idle`/`streaming`) | `useSessionChatStore` |
| Unseen activity badges (sidebar)          | `useSessionChatStore` |

### API

The store is keyed by `sessionId`. All actions auto-initialize a session entry if one doesn't exist:

```typescript
const { initSession, destroySession, updateSession, getSession } = useSessionChatStore.getState();
```

**Selectors (prefer granular over full-state):**

```typescript
// Full session state — re-renders on any field change
const state = useSessionChatState(sessionId);

// Granular selectors — fewer re-renders
const messages = useSessionMessages(sessionId);
const status = useSessionStatus(sessionId);
```

### LRU eviction

The store retains at most 20 sessions (`MAX_RETAINED_SESSIONS`). When a new session is initialized and the limit is exceeded, the oldest `idle` sessions are evicted. Active sessions (`status !== 'idle'`) are never evicted.

### Mount generation

Each `initSession` call increments a monotonic `mountGeneration` counter. Stale closures captured by a previous component instance for the same session ID detect their staleness by comparing generation values and drop their writes rather than corrupting the new session's state.

## Runtime Entity Hooks

The runtime entity layer (`entities/runtime/`) provides hooks for querying runtime capabilities. These are static for the server's lifetime, so `staleTime: Infinity` prevents unnecessary refetches.

### useRuntimeCapabilities

Fetches capability flags for all registered runtimes via `transport.getCapabilities()`.

```typescript
// apps/client/src/layers/entities/runtime/model/use-runtime-capabilities.ts
export function useRuntimeCapabilities() {
  const transport = useTransport();

  return useQuery({
    queryKey: ['capabilities'],
    queryFn: () => transport.getCapabilities(),
    staleTime: Infinity,
  });
}
```

### useDefaultCapabilities

Convenience hook that returns the default runtime's capability flags. Returns `undefined` while loading.

```typescript
// apps/client/src/layers/entities/runtime/model/use-runtime-capabilities.ts
export function useDefaultCapabilities(): RuntimeCapabilities | undefined {
  const { data } = useRuntimeCapabilities();
  if (!data) return undefined;
  return data.capabilities[data.defaultRuntime];
}
```

## Relay Entity Hooks

When `DORKOS_RELAY_ENABLED` is true, additional entity hooks are available for message tracing and delivery metrics.

### useMessageTrace

Fetches trace spans for a specific Relay message. The query is disabled when `messageId` is null.

```typescript
// apps/client/src/layers/entities/relay/model/use-message-trace.ts
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export function useMessageTrace(messageId: string | null) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['relay', 'trace', messageId],
    queryFn: () => transport.getRelayTrace(messageId!),
    enabled: !!messageId,
    staleTime: 30_000,
  });
}
```

### useDeliveryMetrics

Fetches aggregate delivery metrics for the Relay system with automatic 30-second refresh.

```typescript
// apps/client/src/layers/entities/relay/model/use-delivery-metrics.ts
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export function useDeliveryMetrics() {
  const transport = useTransport();

  return useQuery({
    queryKey: ['relay', 'metrics'],
    queryFn: () => transport.getRelayDeliveryMetrics(),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
```

### useAdapterEvents

Fetches lifecycle events for a specific adapter instance with 5-second polling. Disabled when `adapterId` is null. Used by `AdapterEventLog` to display real-time adapter activity.

```typescript
// apps/client/src/layers/entities/relay/model/use-adapter-events.ts
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { AdapterEvent } from '@dorkos/shared/transport';

export function useAdapterEvents(adapterId: string | null) {
  const transport = useTransport();
  return useQuery<{ events: AdapterEvent[] }>({
    queryKey: ['relay', 'adapters', adapterId, 'events'],
    queryFn: () => transport.getAdapterEvents(adapterId!),
    enabled: !!adapterId,
    refetchInterval: 5_000,
  });
}
```

Also exports `AdapterEventMetadata` — a typed interface for parsed event metadata used by the `AdapterEventLog` UI component.

## Binding Entity Hooks

Adapter-agent bindings represent routing rules that connect Relay adapters to DorkOS agents. The binding entity layer (`entities/binding/`) provides hooks for the full CRUD lifecycle.

### Query Key Pattern

Bindings use a simple constant for query keys (contrast with the factory pattern used by agent entity hooks):

```typescript
// apps/client/src/layers/entities/binding/model/use-bindings.ts
export const BINDINGS_QUERY_KEY = ['relay', 'bindings'] as const;
```

All mutation hooks import this constant and call `queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] })` on success, ensuring the binding list stays fresh after any CRUD operation.

### useBindings

Fetches all configured adapter-agent bindings.

```typescript
// apps/client/src/layers/entities/binding/model/use-bindings.ts
export function useBindings() {
  const transport = useTransport();
  return useQuery({
    queryKey: [...BINDINGS_QUERY_KEY],
    queryFn: () => transport.getBindings(),
  });
}
```

### useCreateBinding

Creates a new adapter-agent binding. Invalidates the bindings cache on success.

```typescript
// apps/client/src/layers/entities/binding/model/use-create-binding.ts
export function useCreateBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBindingRequest) => transport.createBinding(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
  });
}
```

### useUpdateBinding

Updates mutable fields on an existing binding (`sessionStrategy`, `label`, `chatId`, `channelType`). Invalidates the bindings cache on success.

```typescript
// apps/client/src/layers/entities/binding/model/use-update-binding.ts
export function useUpdateBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string;
      updates: Partial<
        Pick<AdapterBinding, 'sessionStrategy' | 'label' | 'chatId' | 'channelType'>
      >;
    }) => transport.updateBinding(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
  });
}
```

### useDeleteBinding

Deletes a binding by ID. Invalidates the bindings cache on success.

```typescript
// apps/client/src/layers/entities/binding/model/use-delete-binding.ts
export function useDeleteBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.deleteBinding(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...BINDINGS_QUERY_KEY] });
    },
  });
}
```

### Usage Pattern

Feature components compose multiple binding hooks. For example, `BindingList` in `features/relay/ui/`:

```typescript
const { data: bindings = [], isLoading } = useBindings();
const { mutate: deleteBinding } = useDeleteBinding();
const { mutate: updateBinding } = useUpdateBinding();
```

## Tasks Entity Hooks

The tasks entity layer (`entities/tasks/`) provides hooks for task scheduling and run data. These are consumed by the Tasks feature (`features/tasks/`) to power the schedule list, run history, and task creation dialogs.

### useTasks / useCreateTask / useUpdateTask / useDeleteTask / useTriggerTask

CRUD and trigger hooks for the Tasks scheduler. All mutations invalidate the `['tasks']` query key on success.

```typescript
// apps/client/src/layers/entities/tasks/model/use-tasks.ts
export function useTasks(enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['tasks'],
    queryFn: () => transport.listTasks(),
    enabled,
  });
}

export function useCreateTask() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => transport.createTask(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
```

`enabled` is driven by `useTasksEnabled()` — a config flag that gates the Tasks feature entirely. Pass `enabled={false}` when Tasks is disabled to skip the query.

### useTaskTemplates

Fetches built-in and user-defined task templates. Used to pre-populate `CreateTaskDialog` from the template gallery.

```typescript
// apps/client/src/layers/entities/tasks/model/use-task-templates.ts
export function useTaskTemplates() {
  const transport = useTransport();
  return useQuery({
    queryKey: ['tasks', 'templates'],
    queryFn: () => transport.getTemplates(),
  });
}
```

### useTaskRuns / useTaskRun / useCancelTaskRun / useActiveTaskRunCount

Hooks for task execution history. `useTaskRuns(taskId)` fetches the run list for a specific task. `useActiveTaskRunCount()` is a lightweight selector used by the sidebar badge.

## Marketplace Entity Hooks

The marketplace entity layer (`entities/marketplace/`) provides hooks for browsing, installing, and managing DorkOS marketplace packages. All hooks follow the same Transport-through-TanStack-Query pattern as other entities. Query keys are defined in `api/query-keys.ts`.

### useMarketplacePackages / useMarketplacePackage

Fetch all packages from enabled sources (aggregated) or a single package by name.

```typescript
// apps/client/src/layers/entities/marketplace/model/use-marketplace-packages.ts
export function useMarketplacePackages() {
  const transport = useTransport();
  return useQuery({
    queryKey: marketplaceKeys.packages(),
    queryFn: () => transport.listMarketplacePackages(),
  });
}

// apps/client/src/layers/entities/marketplace/model/use-marketplace-package.ts
export function useMarketplacePackage(name: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: marketplaceKeys.package(name ?? ''),
    queryFn: () => transport.getMarketplacePackage(name!),
    enabled: !!name,
  });
}
```

### useMarketplaceSources / useAddMarketplaceSource / useRemoveMarketplaceSource

CRUD hooks for marketplace sources. Mutations invalidate the sources and packages caches.

```typescript
export function useMarketplaceSources() {
  const transport = useTransport();
  return useQuery({
    queryKey: marketplaceKeys.sources(),
    queryFn: () => transport.listMarketplaceSources(),
  });
}
```

### useInstallPackage / useUninstallPackage / useUpdatePackage

Mutation hooks for the install/uninstall/update pipeline. Each invalidates the installed-packages cache and the package query on success.

```typescript
export function useInstallPackage() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: InstallRequest) => transport.installPackage(opts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
    },
  });
}
```

### useInstalledPackages

Lists packages currently installed in `~/.dork/plugins/` and `~/.dork/agents/`.

```typescript
export function useInstalledPackages() {
  const transport = useTransport();
  return useQuery({
    queryKey: marketplaceKeys.installed(),
    queryFn: () => transport.listInstalledPackages(),
  });
}
```

### usePermissionPreview

Fetches a `PermissionPreview` (filesystem writes, skills, extensions, adapters) for a package without installing it. Used by `InstallConfirmationDialog` to show users what a package will do before they confirm.

```typescript
export function usePermissionPreview(name: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: marketplaceKeys.preview(name ?? ''),
    queryFn: () => transport.previewPackagePermissions(name!),
    enabled: !!name,
  });
}
```

## Agent Entity: useMcpConfig

Fetches MCP server entries from `.mcp.json` in a given project directory. Returns `{ servers: McpServerEntry[] }`. Disabled when `projectPath` is null (e.g., no active working directory). Uses 30-second stale time.

```typescript
// apps/client/src/layers/entities/agent/model/use-mcp-config.ts
export function useMcpConfig(projectPath: string | null) {
  const transport = useTransport();
  return useQuery<McpConfigResponse>({
    queryKey: ['mcp-config', projectPath],
    queryFn: () => transport.getMcpConfig(projectPath!),
    enabled: !!projectPath,
    staleTime: 30_000,
  });
}
```

Used by `ConnectionsView` to show MCP servers in the connections sidebar panel.

## References

- [State Management Guide](./state-management.md) - When to use TanStack Query vs Zustand
- [Architecture Guide](./architecture.md) - Transport interface and hexagonal architecture
- [API Reference](./api-reference.md) - OpenAPI spec for all endpoints
- [TanStack Query Documentation](https://tanstack.com/query/latest) - Official docs
