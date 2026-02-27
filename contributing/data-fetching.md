# Data Fetching Guide

## Overview

This guide covers data fetching patterns in DorkOS. The client uses TanStack Query for server-state management, communicating through the Transport abstraction layer (HttpTransport for standalone web, DirectTransport for Obsidian plugin). The server exposes Express routes that delegate to services.

## Key Files

| Concept                | Location                                                           |
| ---------------------- | ------------------------------------------------------------------ |
| Transport interface    | `packages/shared/src/transport.ts`                                 |
| HttpTransport          | `apps/client/src/layers/shared/lib/http-transport.ts`              |
| DirectTransport        | `apps/client/src/layers/shared/lib/direct-transport.ts`            |
| TransportContext       | `apps/client/src/layers/shared/model/TransportContext.tsx`         |
| Session entity hooks   | `apps/client/src/layers/entities/session/`                         |
| Command entity hooks   | `apps/client/src/layers/entities/command/`                         |
| Agent entity hooks     | `apps/client/src/layers/entities/agent/`                           |
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

## Relay Entity Hooks

When `DORKOS_RELAY_ENABLED` is true, additional entity hooks are available for message tracing and delivery metrics.

### useMessageTrace

Fetches trace spans for a specific Relay message. The query is disabled when `messageId` is null.

```typescript
// apps/client/src/layers/entities/relay/model/use-message-trace.ts
import { useQuery } from '@tanstack/react-query';

export function useMessageTrace(messageId: string | null) {
  return useQuery({
    queryKey: ['relay', 'trace', messageId],
    queryFn: () => fetch(`/api/relay/messages/${messageId}/trace`).then(r => r.json()),
    enabled: messageId !== null,
  });
}
```

### useDeliveryMetrics

Fetches aggregate delivery metrics for the Relay system with automatic 30-second refresh.

```typescript
// apps/client/src/layers/entities/relay/model/use-delivery-metrics.ts
import { useQuery } from '@tanstack/react-query';

export function useDeliveryMetrics() {
  return useQuery({
    queryKey: ['relay', 'trace', 'metrics'],
    queryFn: () => fetch('/api/relay/trace/metrics').then(r => r.json()),
    refetchInterval: 30_000,
  });
}
```

## References

- [State Management Guide](./state-management.md) - When to use TanStack Query vs Zustand
- [Architecture Guide](./architecture.md) - Transport interface and hexagonal architecture
- [API Reference](./api-reference.md) - OpenAPI spec for all endpoints
- [TanStack Query Documentation](https://tanstack.com/query/latest) - Official docs
