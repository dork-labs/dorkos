# Data Fetching Guide

## Overview

This guide covers data fetching patterns in DorkOS. The client uses TanStack Query for server-state management, communicating through the Transport abstraction layer (HttpTransport for standalone web, DirectTransport for Obsidian plugin). The server exposes Express routes that delegate to services.

## Key Files

| Concept                | Location                                                           |
| ---------------------- | ------------------------------------------------------------------ |
| Transport interface    | `packages/shared/src/transport.ts`                                 |
| HttpTransport          | `apps/client/src/layers/shared/lib/transport/http-transport.ts`    |
| DirectTransport        | `apps/client/src/layers/shared/lib/direct-transport.ts`            |
| TransportContext       | `apps/client/src/layers/shared/model/TransportContext.tsx`         |
| Session entity hooks   | `apps/client/src/layers/entities/session/`                         |
| Command entity hooks   | `apps/client/src/layers/entities/command/`                         |
| Agent entity hooks     | `apps/client/src/layers/entities/agent/`                           |
| Runtime entity hooks   | `apps/client/src/layers/entities/runtime/`                         |
| Relay entity hooks     | `apps/client/src/layers/entities/relay/`                           |
| Binding entity hooks   | `apps/client/src/layers/entities/binding/`                         |
| Pulse entity hooks     | `apps/client/src/layers/entities/pulse/`                           |
| Chat feature hooks     | `apps/client/src/layers/features/chat/model/use-chat-session.ts`  |
| Express routes         | `apps/server/src/routes/`                                          |
| Zod schemas            | `packages/shared/src/schemas.ts`                                   |

## When to Use What

| Scenario                                | Approach                                | Why                                                   |
| --------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| List/read server data (sessions, etc.)  | TanStack Query + Transport method       | Caching, deduplication, background refetch             |
| Send a chat message (streaming)         | `useChatSession` hook + SSE             | Real-time streaming, handles all event types           |
| Mutate server data (create session)     | `useMutation` + Transport method        | Automatic cache invalidation, optimistic updates       |
| Subscribe to real-time updates          | SSE via `GET /api/sessions/:id/stream`  | Multi-client sync, file-watcher backed                 |
| Static config/health check              | Transport method (no TanStack Query)    | One-shot, no caching needed                            |

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
  });
}
```

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
    cwd,
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
    () => sessions?.filter(s => s.cwd === agentCwd) ?? [],
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
  const { data: sessions } = useSessions();           // TanStack Query
  const { data: health } = useMeshAgentHealth(agentId); // TanStack Query

  // Derive filtered + sliced data via useMemo
  const agentSessions = useMemo(
    () => sessions?.filter(s => s.cwd === agentCwd) ?? [],
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
  const { data: agent } = useCurrentAgent(projectPath);   // TanStack Query
  const relayEnabled = useRelayEnabled();                   // Feature flag (config query)
  const pulseEnabled = usePulseEnabled();                   // Feature flag (config query)

  return useMemo((): AgentToolStatus => {
    const groups = agent?.enabledToolGroups ?? {};
    return {
      pulse: !pulseEnabled ? 'disabled-by-server'
        : groups.pulse === false ? 'disabled-by-agent' : 'enabled',
      relay: !relayEnabled ? 'disabled-by-server'
        : groups.relay === false ? 'disabled-by-agent' : 'enabled',
      mesh: groups.mesh === false ? 'disabled-by-agent' : 'enabled',
      adapter: !relayEnabled ? 'disabled-by-server'
        : groups.adapter === false ? 'disabled-by-agent' : 'enabled',
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
**Fix**: The `useChatSession` hook handles reconnection. If messages stop arriving, the session sync protocol (`sync_update` events) will catch up when the connection is restored.

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
    mutationFn: ({ id, updates }: {
      id: string;
      updates: Partial<Pick<AdapterBinding, 'sessionStrategy' | 'label' | 'chatId' | 'channelType'>>;
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

## Pulse Entity Hooks

The pulse entity layer (`entities/pulse/`) provides hooks for schedule presets. These are used to pre-populate `CreateScheduleDialog` from the preset gallery.

### usePulsePresets

Fetches the list of available schedule presets from the server. No `staleTime` override — presets change rarely, relying on TanStack Query defaults.

```typescript
// apps/client/src/layers/entities/pulse/model/use-pulse-presets.ts
export function usePulsePresets() {
  const transport = useTransport();
  return useQuery<PulsePreset[]>({
    queryKey: ['pulse', 'presets'],
    queryFn: () => transport.getPulsePresets(),
  });
}
```

Used by `PresetGallery` in `features/pulse/ui/` to render the preset cards shown on the Pulse empty state.

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
