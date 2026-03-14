---
slug: relay-server-client-integration
number: 51
created: 2026-02-24
status: draft
---

# Specification: Relay Server & Client Integration

**Status:** Draft
**Authors:** Claude Code, 2026-02-24
**Spec:** 51
**Depends on:** [Spec 50 — Relay Core Library](../relay-core-library/)
**Related:** [Relay Litepaper](../../meta/modules/relay-litepaper.md) | [Relay Design Doc](../../plans/2026-02-24-relay-design.md)

---

## Overview

Integrate the existing `@dorkos/relay` core library into the DorkOS server and client. This is pure integration work — the relay library is already built (Spec 50). This spec covers wiring `RelayCore` into Express routes, MCP tools, the feature flag system, and building a client-side Relay panel, following the established Pulse integration pattern exactly.

## Background / Problem Statement

DorkOS agents currently have no structured way to send messages to each other. The `@dorkos/relay` library provides the messaging primitives (Maildir storage, NATS-style subjects, budget enforcement, dead letter queue), but it has no HTTP API, no MCP tool surface, and no client UI. Agents need MCP tools to participate in the relay, developers need REST endpoints for inspection and testing, and the client needs a panel to monitor relay activity in real time.

## Goals

- Expose RelayCore functionality through REST API routes at `/api/relay/*`
- Provide 4 MCP tools for agent participation: `relay_send`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint`
- Add SSE streaming at `GET /api/relay/stream` with server-side subject filtering
- Build a client-side Relay panel with Activity Feed and Endpoints tabs
- Feature-flag relay behind `DORKOS_RELAY_ENABLED` (disabled by default, matching Pulse pattern)
- Update CLAUDE.md and API documentation

## Non-Goals

- Changes to the `@dorkos/relay` library itself
- Rate limiting or circuit breakers (Spec 52)
- External adapters (Slack, Discord, email)
- Pulse/Console migration to Relay
- Client UI for endpoint creation/management (agents and server bootstrap handle this)
- Infinite scroll in activity feed (use "Load more" button)

## Technical Dependencies

- `@dorkos/relay` (workspace package, Spec 50) — RelayCore, types, all sub-modules
- `@dorkos/shared/relay-schemas` — Zod schemas for envelopes, budgets, signals, access rules
- `@anthropic-ai/claude-agent-sdk` — `createSdkMcpServer`, `tool` for MCP tool registration
- `@tanstack/react-query` — Server state management in client
- `sonner` — Toast notifications for relay events

## Detailed Design

### 1. Server: Feature Flag (`apps/server/src/services/relay-state.ts`)

Exact copy of `pulse-state.ts` pattern:

```typescript
const state = { enabled: false };

export function setRelayEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

export function isRelayEnabled(): boolean {
  return state.enabled;
}
```

### 2. Server: Initialization (`apps/server/src/index.ts`)

Add relay initialization after pulse, same pattern. Import `RelayCore` from `@dorkos/relay`, add `relayCore` to the global shutdown references:

```typescript
import { RelayCore } from '@dorkos/relay';
import { createRelayRouter } from './routes/relay.js';
import { setRelayEnabled } from './services/relay-state.js';

// In start():
const relayConfig = configManager.get('relay') as { enabled: boolean; dataDir?: string };
const relayEnabled = process.env.DORKOS_RELAY_ENABLED === 'true' || relayConfig.enabled;

let relayCore: RelayCore | undefined;
if (relayEnabled) {
  const dataDir = relayConfig.dataDir ?? path.join(dorkHome, 'relay');
  relayCore = new RelayCore({ dataDir });
  // Register system endpoint for console/UI
  await relayCore.registerEndpoint('relay.system.console');
  logger.info('[Relay] RelayCore initialized');
}

// Inject into MCP tool deps:
const mcpToolServer = createDorkOsToolServer({
  transcriptReader,
  defaultCwd: process.env.DORKOS_DEFAULT_CWD ?? process.cwd(),
  ...(pulseStore && { pulseStore }),
  ...(relayCore && { relayCore }),
});

// Mount relay routes after app creation:
if (relayEnabled && relayCore) {
  app.use('/api/relay', createRelayRouter(relayCore));
  setRelayEnabled(true);
  logger.info('[Relay] Routes mounted');
}

// In shutdown():
if (relayCore) {
  await relayCore.close();
}
```

### 3. Server: HTTP Routes (`apps/server/src/routes/relay.ts`)

Factory function `createRelayRouter(relayCore: RelayCore): Router` following `pulse.ts` pattern. All endpoints use Zod `safeParse()` for validation and return consistent error shapes.

**Endpoints:**

| Method | Path | Description | Request | Response |
|--------|------|-------------|---------|----------|
| `POST` | `/messages` | Send a message | `SendMessageRequestSchema` body | `{ messageId, deliveredTo, warnings? }` |
| `GET` | `/messages` | List messages | Query: `subject?`, `status?`, `from?`, `cursor?`, `limit?` | `{ messages, nextCursor? }` |
| `GET` | `/messages/:id` | Get single message | — | `RelayEnvelope` or 404 |
| `GET` | `/endpoints` | List endpoints | — | `EndpointInfo[]` |
| `POST` | `/endpoints` | Register endpoint | `{ subject, description? }` | `EndpointInfo` |
| `DELETE` | `/endpoints/:subject` | Unregister | — | `{ success: true }` or 404 |
| `GET` | `/endpoints/:subject/inbox` | Read inbox | Query: `status?`, `cursor?`, `limit?` | `{ messages, nextCursor? }` |
| `GET` | `/dead-letters` | List DLQ | Query: `limit?` | `DeadLetterEntry[]` |
| `GET` | `/metrics` | System metrics | — | `RelayMetrics` |
| `GET` | `/stream` | SSE event stream | Query: `subject?` (pattern filter) | SSE events |

**New Zod schemas** (added to `packages/shared/src/relay-schemas.ts`):

```typescript
export const SendMessageRequestSchema = z.object({
  subject: z.string().min(1),
  payload: z.unknown(),
  from: z.string().min(1),
  replyTo: z.string().optional(),
  budget: z.object({
    maxHops: z.number().int().min(1).optional(),
    ttl: z.number().int().optional(),
    callBudgetRemaining: z.number().int().min(0).optional(),
  }).optional(),
}).openapi('SendMessageRequest');

export const MessageListQuerySchema = z.object({
  subject: z.string().optional(),
  status: z.enum(['new', 'cur', 'failed']).optional(),
  from: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).openapi('MessageListQuery');

export const InboxQuerySchema = z.object({
  status: z.enum(['new', 'cur', 'failed']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).openapi('InboxQuery');

export const EndpointRegistrationSchema = z.object({
  subject: z.string().min(1),
  description: z.string().optional(),
}).openapi('EndpointRegistration');
```

**SSE Stream endpoint** (`GET /stream`):

```typescript
router.get('/stream', (req, res) => {
  initSSEStream(res);

  // Send connected event
  sendSSEEvent(res, { type: 'relay_connected', data: { timestamp: new Date().toISOString() } });

  // Subscribe to relay messages with optional subject filter
  const pattern = (req.query.subject as string) || '>';
  const unsub = relayCore.subscribe(pattern, (envelope) => {
    res.write(`id: ${envelope.id}\n`);
    sendSSEEvent(res, { type: 'relay_message', data: envelope });
  });

  // Keepalive every 15 seconds
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    unsub();
    clearInterval(keepalive);
  });
});
```

### 4. Server: MCP Tools (`apps/server/src/services/mcp-tool-server.ts`)

Add `relayCore` to `McpToolDeps` interface and 4 relay tools:

```typescript
export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  defaultCwd: string;
  pulseStore?: PulseStore;
  relayCore?: RelayCore;  // NEW
}

function requireRelay(deps: McpToolDeps) {
  if (!deps.relayCore) {
    return jsonContent({ error: 'Relay is not enabled', code: 'RELAY_DISABLED' }, true);
  }
  return null;
}
```

**Tools:**

| Tool | Description | Params | Response |
|------|-------------|--------|----------|
| `relay_send` | Send a message to a subject | `subject`, `payload`, `from`, `replyTo?`, `budget?` | `{ messageId, deliveredTo }` |
| `relay_inbox` | Read inbox for an endpoint | `endpoint_subject`, `limit?`, `status?` | `{ messages, count }` |
| `relay_list_endpoints` | List registered endpoints | — | `{ endpoints, count }` |
| `relay_register_endpoint` | Register a new endpoint | `subject`, `description?` | `{ endpoint }` |

Error responses use `isError: true` with structured `{ error, code, hint }` payloads. Error codes: `RELAY_DISABLED`, `ACCESS_DENIED`, `BUDGET_EXCEEDED`, `INVALID_SUBJECT`, `ENDPOINT_NOT_FOUND`.

Tools are added to the `tools` array in `createDorkOsToolServer` alongside pulse tools:

```typescript
const relayTools = [
  tool('relay_send', 'Send a message to a Relay subject...', { ... }, createRelaySendHandler(deps)),
  tool('relay_inbox', 'Read inbox messages for a Relay endpoint...', { ... }, createRelayInboxHandler(deps)),
  tool('relay_list_endpoints', 'List all registered Relay endpoints.', {}, createRelayListEndpointsHandler(deps)),
  tool('relay_register_endpoint', 'Register a new Relay endpoint...', { ... }, createRelayRegisterEndpointHandler(deps)),
];

return createSdkMcpServer({
  tools: [...coreTools, ...pulseTools, ...relayTools],
});
```

### 5. Server: Config Route (`apps/server/src/routes/config.ts`)

Add relay status to GET response:

```typescript
import { isRelayEnabled } from '../services/relay-state.js';

// In GET handler response:
res.json({
  ...existingFields,
  relay: {
    enabled: isRelayEnabled(),
  },
});
```

### 6. Shared: Config Schema (`packages/shared/src/config-schema.ts`)

Add relay config section:

```typescript
relay: z
  .object({
    enabled: z.boolean().default(false),
    dataDir: z.string().nullable().default(null),
  })
  .default(() => ({
    enabled: false,
    dataDir: null,
  })),
```

### 7. Config: turbo.json

Add `DORKOS_RELAY_ENABLED` to `globalPassThroughEnv` array.

### 8. Client: Entity Hooks (`apps/client/src/layers/entities/relay/`)

**`model/use-relay-config.ts`** — Feature flag hook (mirrors `use-pulse-config.ts`):

```typescript
export function useRelayEnabled(): boolean {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });
  return data?.relay?.enabled ?? false;
}
```

**`model/use-relay-messages.ts`** — Message list with cursor pagination:

```typescript
export function useRelayMessages(enabled: boolean, filters?: MessageFilters) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['relay', 'messages', filters],
    queryFn: () => transport.fetch('/api/relay/messages', { params: filters }),
    enabled,
    refetchInterval: 10_000, // Poll every 10s as fallback to SSE
  });
}
```

**`model/use-relay-endpoints.ts`** — Endpoint list query.

**`model/use-relay-metrics.ts`** — Metrics query.

**`model/use-relay-event-stream.ts`** — EventSource hook for SSE:

```typescript
export function useRelayEventStream(enabled: boolean, pattern?: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    const params = pattern ? `?subject=${encodeURIComponent(pattern)}` : '';
    const source = new EventSource(`/api/relay/stream${params}`);

    source.addEventListener('relay_message', (e) => {
      const envelope = JSON.parse(e.data);
      // Inject into React Query cache
      queryClient.setQueryData(['relay', 'messages'], (old: any) => {
        if (!old) return { messages: [envelope] };
        return { ...old, messages: [envelope, ...old.messages] };
      });
    });

    return () => source.close();
  }, [enabled, pattern, queryClient]);
}
```

**`index.ts`** barrel:

```typescript
export { useRelayEnabled } from './model/use-relay-config';
export { useRelayMessages } from './model/use-relay-messages';
export { useRelayEndpoints } from './model/use-relay-endpoints';
export { useRelayMetrics } from './model/use-relay-metrics';
export { useRelayEventStream } from './model/use-relay-event-stream';
```

### 9. Client: Feature UI (`apps/client/src/layers/features/relay/`)

**`ui/RelayPanel.tsx`** — Main panel with tabs. Mirrors PulsePanel disabled/loading/active states:

```
┌─────────────────────────────────────┐
│  Relay                              │
│  [Activity] [Endpoints]             │
├─────────────────────────────────────┤
│  Activity Feed (newest first)       │
│  ┌─────────────────────────────────┐│
│  │ ● relay.agent.backend          ││
│  │   from: relay.agent.frontend   ││
│  │   2m ago                    new ││
│  ├─────────────────────────────────┤│
│  │ ● relay.system.console         ││
│  │   from: relay.agent.backend    ││
│  │   5m ago                    cur ││
│  ├─────────────────────────────────┤│
│  │ ▲ relay.agent.unknown          ││
│  │   from: relay.agent.frontend   ││
│  │   12m ago               failed ││
│  └─────────────────────────────────┘│
│  [Load more]                        │
└─────────────────────────────────────┘
```

**Disabled state** (when `useRelayEnabled()` returns false):

```tsx
<div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
  <Route className="size-8 text-muted-foreground/50" />
  <div>
    <p className="font-medium">Relay is not enabled</p>
    <p className="mt-1 text-sm text-muted-foreground">
      Relay enables inter-agent messaging. Start DorkOS with DORKOS_RELAY_ENABLED=true to enable it.
    </p>
  </div>
</div>
```

**Components:**

- `RelayPanel` — Tabs wrapper (Activity + Endpoints), disabled/loading states
- `ActivityFeed` — Chronological message list, compact rows, expand on click, filtering
- `MessageRow` — Individual message card (compact: subject + from + time + badge; expanded: payload + budget)
- `EndpointList` — List of registered endpoints with subject, message count
- `InboxView` — Messages for a selected endpoint, reuses MessageRow

**Status indicators:**

| Status | Icon | Color class |
|--------|------|------------|
| `new` | `Clock` | `text-muted-foreground` |
| `cur` | `Check` | `text-muted-foreground` |
| `failed` | `AlertTriangle` | `text-destructive` |
| `dead_letter` | `MailX` | `text-warning` (amber) |

**`index.ts`** barrel:

```typescript
export { RelayPanel } from './ui/RelayPanel';
```

### 10. Client: Sidebar Integration (`SessionSidebar.tsx`)

The Route icon button already exists at line 233-245 in `SessionSidebar.tsx` with "Relay not connected" hover text. Modify it to:

1. Add `const [relayOpen, setRelayOpen] = useState(false)` state
2. Import `useRelayEnabled` from `@/layers/entities/relay`
3. Change the Route button's `onClick` to `() => setRelayOpen(true)`
4. Update hover text based on `relayEnabled` state
5. Add a `ResponsiveDialog` for the Relay panel (same pattern as Pulse dialog at lines 300-314)

```tsx
import { RelayPanel } from '@/layers/features/relay';
import { useRelayEnabled } from '@/layers/entities/relay';

// In SessionSidebar:
const relayEnabled = useRelayEnabled();
const [relayOpen, setRelayOpen] = useState(false);

// Route icon button:
<button
  onClick={() => setRelayOpen(true)}
  className={cn(
    'rounded-md p-1 transition-colors duration-150 max-md:p-2',
    relayEnabled
      ? 'text-muted-foreground/50 hover:text-muted-foreground'
      : 'text-muted-foreground/25 hover:text-muted-foreground/40'
  )}
  aria-label="Relay messaging"
>
  <Route className="size-(--size-icon-sm)" />
</button>

// Dialog (after Pulse dialog):
<ResponsiveDialog open={relayOpen} onOpenChange={setRelayOpen}>
  <ResponsiveDialogContent className="max-w-2xl gap-0 p-0">
    <ResponsiveDialogHeader className="border-b px-4 py-3">
      <ResponsiveDialogTitle className="text-sm font-medium">
        Relay
      </ResponsiveDialogTitle>
      <ResponsiveDialogDescription className="sr-only">
        Inter-agent messaging activity and endpoints
      </ResponsiveDialogDescription>
    </ResponsiveDialogHeader>
    <div className="overflow-y-auto">
      <RelayPanel />
    </div>
  </ResponsiveDialogContent>
</ResponsiveDialog>
```

### 11. Server: OpenAPI Registration

Register relay route schemas in `apps/server/src/services/openapi-registry.ts` under a `relay` tag for API docs at `/api/docs`.

## User Experience

1. **Relay disabled (default):** Server starts normally. Route icon in sidebar footer shows muted/inactive. Clicking opens RelayPanel with "Relay is not enabled" message and setup instructions.

2. **Relay enabled:** Set `DORKOS_RELAY_ENABLED=true` env var or `relay.enabled: true` in config. Server initializes RelayCore, mounts routes, registers MCP tools. Route icon becomes interactive.

3. **Agent sends a message:** Agent calls `relay_send` MCP tool → RelayCore.publish() → message delivered to matching endpoints → SSE event pushed to connected clients → ActivityFeed updates in real-time.

4. **Developer inspects relay:** Opens Relay panel → Activity tab shows live feed → clicks a message to expand payload and budget details → switches to Endpoints tab to see registered endpoints → clicks an endpoint to view its inbox.

5. **API testing:** `POST /api/relay/messages` with JSON body → returns `{ messageId, deliveredTo }` → `GET /api/relay/endpoints/:subject/inbox` to verify delivery.

## Testing Strategy

### Server Route Tests (`apps/server/src/routes/__tests__/relay.test.ts`)

Test all 10 endpoints with a mock RelayCore instance. Key scenarios:

- POST /messages with valid payload → 200, returns messageId
- POST /messages with invalid subject → 400, Zod error details
- GET /endpoints → returns registered endpoints
- POST /endpoints with duplicate subject → idempotent (returns existing)
- DELETE /endpoints/:subject for non-existent → 404
- GET /endpoints/:subject/inbox → returns messages for that endpoint
- GET /stream → establishes SSE connection, receives events

### MCP Tool Tests (`apps/server/src/services/__tests__/mcp-relay-tools.test.ts`)

Test tool handlers with mock McpToolDeps:

- `relay_send` with relayCore undefined → returns error with `RELAY_DISABLED` code
- `relay_send` with valid args → calls RelayCore.publish(), returns messageId
- `relay_send` with access denied → returns error with `ACCESS_DENIED` code
- `relay_inbox` → calls appropriate query methods, returns messages
- `relay_register_endpoint` → calls RelayCore.registerEndpoint(), returns endpoint info

### Client Entity Hook Tests

Test query hooks with mock Transport using React Testing Library's `renderHook`:

- `useRelayEnabled` → queries config, returns boolean
- `useRelayMessages` → fetches message list, handles pagination
- `useRelayEventStream` → creates EventSource, injects events into cache

### Client UI Component Tests

Test RelayPanel and ActivityFeed with mock data:

- RelayPanel renders disabled state when relay is not enabled
- RelayPanel renders loading skeletons while fetching
- ActivityFeed renders message list with correct status indicators
- MessageRow expands on click to show payload details
- Tabs switch between Activity and Endpoints views

## Performance Considerations

- **SSE connections:** One `RelayCore.subscribe()` per SSE client, server-side subject filtering prevents unnecessary event delivery. Keepalive every 15s prevents proxy disconnections.
- **Client polling fallback:** React Query polls every 10 seconds as fallback when SSE is unavailable. SSE events inject directly into the query cache, so polling is mostly redundant when SSE is connected.
- **Cursor pagination:** ULID-based cursors are immune to insert/delete races. Limit defaults to 50 messages per page.
- **Feature flag:** When relay is disabled, no RelayCore instance is created, no routes mounted, no MCP tools registered — zero runtime cost.

## Security Considerations

- **Access control:** RelayCore's `AccessControl` module enforces pattern-based allow/deny rules on publish. Access violations return structured errors (not stack traces).
- **Budget enforcement:** `BudgetEnforcer` prevents infinite message loops (hop count), resource exhaustion (call budget), and message expiry (TTL).
- **Input validation:** All HTTP routes use Zod `safeParse()` with 400 error on failure. MCP tools validate inputs through Zod schemas.
- **No auth on relay routes:** Relay routes follow the same security model as all other DorkOS routes (no auth, single-user tool). Authentication is a future concern.

## Documentation

- Update `CLAUDE.md` with:
  - `relay-state.ts` in the services list
  - Relay routes in the route groups list
  - Relay MCP tools in the mcp-tool-server.ts description
  - `entities/relay/` and `features/relay/` in the FSD layers table
  - `DORKOS_RELAY_ENABLED` in the env var documentation
- Register Relay schemas in `openapi-registry.ts` for Scalar docs at `/api/docs`
- Update `contributing/api-reference.md` with relay endpoints

## Implementation Phases

### Phase 1: Server Foundation

- Create `relay-state.ts`
- Add relay config to `config-schema.ts`
- Add `DORKOS_RELAY_ENABLED` to `turbo.json`
- Add relay initialization to `index.ts`
- Add `relayCore` to `McpToolDeps` and config route
- Create `routes/relay.ts` with all endpoints (non-SSE first)
- Add relay schemas to `relay-schemas.ts`
- Server route tests

### Phase 2: MCP Tools & SSE

- Add 4 relay MCP tools to `mcp-tool-server.ts`
- Add SSE stream endpoint to `routes/relay.ts`
- MCP tool tests

### Phase 3: Client Entity Hooks

- Create `entities/relay/` with all hooks
- `useRelayEnabled`, `useRelayMessages`, `useRelayEndpoints`, `useRelayMetrics`
- `useRelayEventStream` SSE hook
- Entity hook tests

### Phase 4: Client Feature UI

- Create `features/relay/` with RelayPanel, ActivityFeed, MessageRow, EndpointList, InboxView
- Integrate into SessionSidebar (Route icon → RelayPanel dialog)
- Component tests

### Phase 5: Documentation & Polish

- Update CLAUDE.md
- Register OpenAPI schemas
- Update `contributing/api-reference.md`

## Related ADRs

- [ADR 0010 — Use Maildir for Relay Message Storage](../../decisions/0010-use-maildir-for-relay-message-storage.md)
- [ADR 0011 — Use NATS-style Subject Matching](../../decisions/0011-use-nats-style-subject-matching.md)
- [ADR 0012 — Use ULID for Relay Message IDs](../../decisions/0012-use-ulid-for-relay-message-ids.md)
- [ADR 0013 — Hybrid Maildir + SQLite Storage](../../decisions/0013-hybrid-maildir-sqlite-storage.md)
- [ADR 0017 — Standardize Subsystem Integration Pattern](../../decisions/0017-standardize-subsystem-integration-pattern.md)
- [ADR 0018 — Server-Side SSE Subject Filtering](../../decisions/0018-server-side-sse-subject-filtering.md)

## References

- [Relay Core Library (Spec 50)](../relay-core-library/)
- [Relay Litepaper](../../meta/modules/relay-litepaper.md)
- [Relay Design Doc](../../plans/2026-02-24-relay-design.md)
- [Pulse Router Pattern](../../apps/server/src/routes/pulse.ts)
- [MCP Tool Server](../../apps/server/src/services/mcp-tool-server.ts)
- [SSE Stream Adapter](../../apps/server/src/services/stream-adapter.ts)
- [Pulse Client Entity](../../apps/client/src/layers/entities/pulse/)
- [Pulse Client Feature](../../apps/client/src/layers/features/pulse/)
- [Research: Relay Server & Client Integration](../../research/20260224_relay_server_client_integration.md)
