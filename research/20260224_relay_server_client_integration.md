---
title: 'Relay Server-Client Integration Research'
date: 2026-02-24
type: internal-architecture
status: archived
tags: [relay, server, client, sse, integration, react]
feature_slug: relay-server-client-integration
---

# Research: Relay Server-Client Integration

**Date**: 2026-02-24
**Feature**: relay-server-client-integration
**Research Depth**: Deep
**Searches Performed**: 12
**Sources Found**: 30+

---

## Research Summary

This document covers five integration domains for wiring the `@dorkos/relay` core library into the DorkOS server and client: REST API design for message bus systems, SSE event streaming for activity feeds, activity feed UI patterns, MCP tool design for messaging operations, and a comparison of four architecture approaches for the client-side Relay panel. Findings are grounded in both general best practices and a deep read of the existing DorkOS codebase (Pulse, SessionBroadcaster, MCP tool server, RelayCore) so that the Relay integration follows established project patterns.

---

## RESEARCH FINDINGS

---

### REST API Design for Message Bus Systems

#### Core URL Structure

The relay's resource model maps cleanly to REST conventions. Using the existing `relay.` prefix in the server (analogous to `pulse.` routes):

```
POST   /api/relay/messages              — Send a message to a subject
GET    /api/relay/messages              — List indexed messages (with filters)
GET    /api/relay/messages/:id          — Get a single message by ULID
GET    /api/relay/endpoints             — List all registered endpoints
POST   /api/relay/endpoints             — Register a new endpoint
DELETE /api/relay/endpoints/:subject    — Unregister an endpoint
GET    /api/relay/endpoints/:subject/inbox  — Read inbox for a specific endpoint
GET    /api/relay/dead-letters          — List dead-letter queue entries
GET    /api/relay/metrics               — Aggregate counts by subject and status
GET    /api/relay/stream                — SSE stream for real-time activity (see SSE section)
```

This follows the same thin-router pattern as `routes/pulse.ts`: Zod validation, service delegation, consistent 200/201/400/404 error shapes.

#### Send Message: Request and Response

```typescript
// POST /api/relay/messages
// Request body (Zod-validated)
{
  subject: string;           // e.g. "relay.agent.backend"
  payload: unknown;          // JSON-serializable
  from: string;              // sender subject
  replyTo?: string;          // optional reply subject
  budget?: {
    maxHops?: number;
    ttl?: number;            // Unix ms expiry
    callBudgetRemaining?: number;
  };
}

// Success response 201
{
  messageId: string;         // ULID
  deliveredTo: number;       // endpoint count
  subject: string;
}

// Failure — no matching endpoints (200, not error — mirrors RelayCore.publish behavior)
{
  messageId: string;
  deliveredTo: 0;
  warning: "No matching endpoints — message sent to dead-letter queue";
}
```

The RelayCore already throws on invalid subject or access denial — the route handler catches these and maps to appropriate 400/403 responses.

#### Inbox Retrieval

```typescript
// GET /api/relay/endpoints/:subject/inbox
// Query params
?status=new|cur|failed     // filter by maildir subfolder (default: new)
?limit=50                  // default 50
?cursor=<ulid>             // cursor-based pagination (ULID of last seen message)
?after=<iso8601>           // time-based filter

// Response
{
  messages: IndexedMessage[];
  nextCursor: string | null;    // opaque base64-encoded ULID cursor
  hasMore: boolean;
}
```

Use cursor-based pagination, not offset. With high message volume, offset pagination causes duplicate/skipped messages when new items arrive during pagination. ULID cursors are already ordered by time + entropy — they make ideal stable cursors. The cursor can be base64-encoded to keep it opaque (Slack's approach).

#### Message Listing with Filtering

```typescript
// GET /api/relay/messages
?subject=relay.agent.backend     // exact subject filter
?subjectPattern=relay.agent.>    // wildcard pattern filter (future)
?status=new|cur|failed           // status filter
?from=relay.agent.frontend       // sender filter
?limit=50                        // max 100 enforced server-side
?cursor=<ulid>                   // cursor
?after=2026-02-24T00:00:00Z      // created_at lower bound
?before=2026-02-24T23:59:59Z     // created_at upper bound
```

Sorting and filtering must be applied before pagination. The SQLite index already has indexes on `(endpoint_hash, created_at DESC)`, `status`, and `subject` — all filters map directly to prepared statements with no full-table scan.

#### Message Status Tracking

The RelayCore uses three statuses that map directly to Maildir subdirectories:

- `new` — delivered to Maildir `new/`, awaiting claim
- `cur` — claimed and processed successfully (moved to `cur/`)
- `failed` — handler threw, moved to `failed/`

The REST layer should surface these as-is. A fourth synthetic status `dead_letter` covers messages that had no matching endpoint (stored in the DLQ). The `GET /api/relay/dead-letters` endpoint lists these separately.

#### Idempotency

POST `/api/relay/messages` should accept an optional `idempotencyKey` header. The RelayCore's ULID generation is not currently idempotent — the server route can implement a short-lived (5 minute TTL) in-memory cache of `idempotencyKey -> PublishResult` to make retries safe. This is especially important for MCP tool callers that may retry on network errors.

---

### SSE Activity Feed Patterns

#### SSE Approach vs. Polling

SSE is the correct choice for the Relay activity feed for the same reasons it was chosen for session sync (`SessionBroadcaster`) and message streaming (`routes/sessions.ts`). The DorkOS stack already has established SSE helpers in `services/stream-adapter.ts` — `initSSEStream`, `sendSSEEvent`, `endSSEStream`. The Relay SSE endpoint reuses these exactly.

#### Stream Endpoint Design

```
GET /api/relay/stream
```

Optional query parameters for client-side filtering:

```
?subject=relay.agent.backend       — subscribe to a specific subject
?subjectPattern=relay.agent.>      — subscribe to a pattern
?includeStatuses=new,failed        — only emit for these statuses (default: all)
```

Filtering at the server level (not client) is critical for high message volume — sending every message to every connected browser and filtering client-side wastes bandwidth and browser resources. The `RelayCore.subscribe()` API supports pattern-based filtering natively.

#### Event Types for the Activity Feed

```typescript
// relay_message — a new message was published
{
  type: 'relay_message',
  data: {
    messageId: string;
    subject: string;
    from: string;
    status: 'new' | 'cur' | 'failed';
    deliveredTo: number;
    createdAt: string;          // ISO 8601
    payloadPreview?: string;    // first 100 chars of payload content
  }
}

// relay_delivery — a message status changed (claimed, completed, failed)
{
  type: 'relay_delivery',
  data: {
    messageId: string;
    subject: string;
    previousStatus: 'new' | 'cur';
    newStatus: 'cur' | 'failed';
    endpointHash: string;
    timestamp: string;
  }
}

// relay_dead_letter — message rejected to DLQ
{
  type: 'relay_dead_letter',
  data: {
    messageId: string;
    subject: string;
    from: string;
    reason: string;             // "no matching endpoints" | "budget exceeded" | etc.
    failedAt: string;
  }
}

// relay_connected — sent on initial SSE connection
{
  type: 'relay_connected',
  data: {
    subscribedSubject: string | null;
    timestamp: string;
  }
}

// relay_metrics — periodic metrics snapshot (every 30s or on significant change)
{
  type: 'relay_metrics',
  data: {
    totalMessages: number;
    byStatus: Record<string, number>;
    bySubject: Array<{ subject: string; count: number }>;
  }
}
```

This mirrors the `StreamEvent` type pattern from `packages/shared/src/schemas.ts` — add a `RelayStreamEvent` union type to the shared schemas.

#### Last-Event-ID and Reconnection

The SSE stream for the relay activity feed is a live "tail" — it does not need to replay history on reconnect. Instead:

1. Include `id: <messageId>` fields in SSE events (the ULID is perfect here — lexicographically monotonic).
2. When the client reconnects with `Last-Event-ID`, the server can optionally replay events from the SQLite index that occurred after that ULID.
3. For the MVP, replay is optional — the client can simply re-fetch the message list via REST on reconnect.

The `EventSource` browser API handles automatic reconnection with exponential backoff. The DorkOS client already manages this pattern for session sync.

#### Backpressure and Connection Management

At high message volume, each SSE write is buffered in Node.js's HTTP response stream. Best practices from Shopify's SSE implementation (serving >1 trillion events/month):

1. **Event batching**: If multiple messages arrive in the same tick, batch them into a single SSE write to reduce HTTP frame overhead. A 10ms debounce window is appropriate for the relay activity feed.
2. **Per-connection filtering**: The `RelayCore.subscribe()` pattern subscription is registered per SSE connection and cleaned up on `res.on('close', ...)`. Never fan-out to unfiltered clients.
3. **Connection limit**: Browsers allow 6 concurrent SSE connections per domain. DorkOS has one SSE connection for sessions and one for relay — well within limits.
4. **Keep-alive**: Send a comment line (`: keepalive\n\n`) every 15 seconds to prevent proxy timeout drops.

#### Implementation Pattern (follows SessionBroadcaster)

The Relay SSE endpoint should follow the same `registerClient` pattern as `SessionBroadcaster`, but backed by `RelayCore.subscribe()` instead of chokidar:

```typescript
// routes/relay.ts (SSE handler)
router.get('/stream', (req, res) => {
  initSSEStream(res);

  const pattern = (req.query.subjectPattern as string) ?? '>';
  const unsub = relay.subscribe(pattern, (envelope) => {
    sendSSEEvent(res, {
      type: 'relay_message',
      data: buildRelayMessageEvent(envelope),
    });
  });

  // Keep-alive
  const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15_000);

  req.on('close', () => {
    unsub();
    clearInterval(keepAlive);
  });
});
```

---

### Activity Feed UI Patterns

#### Infinite Scroll vs. Pagination

For the Relay activity feed, **infinite scroll (virtual list with "load more")** is the correct choice:

- The feed is time-ordered and continuously appended — not a navigable dataset
- Users consume messages in arrival order, not by jumping to page 7
- New messages should appear at the top (newest-first) without disrupting scroll position
- Pagination creates awkward "page 1" race conditions when new messages arrive

However, pure infinite scroll has DOM performance issues at high volume. Use the "virtual list + windowing" approach: only render visible rows, recycle DOM nodes for off-screen items. This is what GitHub's activity feed and Slack's message history use. For the initial implementation without a virtual list library, a simpler "Load 50 more" button at the bottom of the list is acceptable.

#### Filtering Approaches

Three filtering dimensions are relevant for the relay panel:

1. **Subject/endpoint filter**: Dropdown or combobox listing registered endpoints. Selecting one scopes the feed and inbox view.
2. **Status filter**: Multi-select for `new`, `cur`, `failed`, `dead_letter`. Badge counts next to each.
3. **Time range**: Date picker for "after" and "before" bounds. Useful for auditing.

Filters should be reflected in URL params (`?subject=relay.agent.backend&status=failed`) using nuqs, consistent with DorkOS's existing `?session=` and `?dir=` URL state pattern. This makes filters shareable and bookmarkable.

#### Visual Design for Message Statuses

Follow the existing DorkOS color system (neutral gray palette with semantic accents):

| Status            | Color Treatment                              | Icon                       |
| ----------------- | -------------------------------------------- | -------------------------- |
| `new`             | Muted (default text color)                   | Clock or inbox icon        |
| `cur`             | Muted-foreground (de-emphasized — processed) | Check or done icon         |
| `failed`          | `text-destructive` (red)                     | X or alert-triangle icon   |
| `dead_letter`     | `text-warning` (amber)                       | Mail-X or letter-dead icon |
| `budget_exceeded` | `text-warning` (amber)                       | Gauge or limits icon       |

Delivered messages (`cur`) should be visually de-emphasized since they represent completed work. Failed and dead-letter messages should stand out — these are actionable.

#### Grouping Strategies

Two grouping options:

1. **Group by subject**: Collapsible groups with a header showing the subject name + message count badge. Natural for monitoring multiple endpoints at once. The `bySubject` array from `relay.getMetrics()` drives the sidebar count badges.
2. **Chronological flat list**: All messages interleaved by timestamp. Best for a live "tail" view.

Recommend: Flat chronological list as the default (activity feed mode), with a toggle to switch to "by endpoint" grouped view (inbox browser mode). This maps to the Split Panel architecture (Approach D).

#### Badge/Notification Patterns

- Status bar icon (like the Pulse active run badge): Show count of unread `new` messages or `failed` messages since last visit.
- The badge count is derived from the SSE stream — increment on `relay_message` events, reset when the user opens the panel.
- A red badge for failures, a neutral badge for pending new messages. Do not use the same color for both — failures need immediate attention.

#### Compact vs. Expanded Message Views

Default to compact rows (single line: subject + from + time + status badge). Click to expand into a detail view showing:

- Full payload (JSON formatted with syntax highlighting)
- Budget details (hops remaining, TTL, call budget remaining)
- Delivery timeline

This pattern is identical to `ScheduleRow` in Pulse — the `expandedId` state toggle pattern is already proven in the codebase.

---

### MCP Tool Design for Messaging

#### Existing Pattern (from mcp-tool-server.ts)

The DorkOS MCP tool server uses:

- `jsonContent(data, isError?)` helper to wrap all responses as `TextContent` JSON blocks
- `requirePulse(deps)` guard pattern for optional features — follow with `requireRelay(deps)`
- Handler factories that close over `McpToolDeps` for dependency injection
- `isError: true` field on the result for tool execution errors (not protocol errors)

The Relay tools follow the same pattern exactly.

#### Recommended Tool Set

```typescript
// relay_send_message
// Send a message to a subject on the relay bus
{
  subject: z.string().describe("Target subject (e.g. 'relay.agent.backend')"),
  payload: z.record(z.unknown()).describe("Message payload as a JSON object"),
  from: z.string().describe("Sender subject (your agent's endpoint)"),
  reply_to: z.string().optional().describe("Subject for responses"),
  budget_max_hops: z.number().int().optional().describe("Max relay hops (default 5)"),
  budget_ttl_ms: z.number().int().optional().describe("TTL in ms from now (default 1h)"),
}
// Returns: { messageId, deliveredTo, subject }

// relay_read_inbox
// Read pending messages from an endpoint's inbox
{
  subject: z.string().describe("Your endpoint's subject"),
  status: z.enum(['new', 'cur', 'failed']).optional().describe("Message status filter (default: new)"),
  limit: z.number().int().optional().describe("Max messages to return (default 10)"),
}
// Returns: { messages: IndexedMessage[], count: number }

// relay_list_endpoints
// List all registered relay endpoints
{
  pattern: z.string().optional().describe("Subject pattern filter with NATS wildcards"),
}
// Returns: { endpoints: EndpointInfo[], count: number }

// relay_register_endpoint
// Register a new message endpoint (creates maildir)
{
  subject: z.string().describe("Subject for the new endpoint"),
}
// Returns: { endpoint: EndpointInfo }

// relay_get_metrics
// Get aggregate message counts by subject and status
{}
// Returns: { metrics: RelayMetrics }

// relay_get_dead_letters
// List dead-letter queue entries (messages that failed delivery)
{
  limit: z.number().int().optional().describe("Max entries to return (default 20)"),
}
// Returns: { deadLetters: DeadLetterEntry[], count: number }
```

#### Input Schema Best Practices (from MCP spec 2025-06-18)

- Use enums wherever the domain is bounded (e.g., `status` is `'new' | 'cur' | 'failed'`)
- All required params first, then optional params
- Descriptions should tell the agent when to use the param, not just what it is
- Accept strict schemas but be lenient in execution — if `subject` has a trailing dot, normalize it rather than reject
- Make tools idempotent where possible: `relay_register_endpoint` with the same subject should return the existing endpoint info, not error

#### Error Handling Pattern

```typescript
// Tool execution errors: use isError: true in result (NOT JSON-RPC protocol errors)
// This allows the LLM to read the error and potentially recover

// Access denied
return jsonContent(
  {
    error: 'Access denied',
    code: 'ACCESS_DENIED',
    from: args.from,
    subject: args.subject,
    hint: 'Check access control rules with relay_list_endpoints',
  },
  true
);

// No matching endpoints (informational, not an error — agent can register first)
return jsonContent({
  messageId,
  deliveredTo: 0,
  warning: 'No registered endpoints match this subject. Use relay_register_endpoint first.',
});

// Budget exceeded
return jsonContent(
  {
    error: 'Message budget exceeded',
    code: 'BUDGET_EXCEEDED',
    hint: 'Increase budget_max_hops or budget_ttl_ms, or check for routing loops',
  },
  true
);
```

#### Delivery Status Surfacing

Agents cannot block on async delivery (the `relay_send_message` tool returns immediately after `RelayCore.publish()`). Surface delivery status via:

1. The `deliveredTo` count in the send response — 0 means no endpoints matched
2. The `relay_get_dead_letters` tool — agents can poll for their own failed messages by filtering on `from`
3. The `relay_read_inbox` tool — for request/reply patterns, the agent sends a message then reads its own inbox for the response

This mirrors NATS's request/reply model: send to a subject, listen on a `replyTo` subject.

---

### Potential Solutions: Architecture Approaches

#### Approach A: Dedicated Relay Panel (like Pulse)

A top-level panel in the sidebar navigation, parallel to Pulse. Shows a tabbed view with "Activity Feed" and "Endpoints" tabs. Activated by clicking a sidebar icon (like the Pulse HeartPulse icon).

**Pros:**

- Exactly matches the existing Pulse pattern — zero new infrastructure
- Clear information hierarchy: Pulse = scheduled tasks, Relay = inter-agent messages
- Visible at all times without interfering with the main chat interface
- Easy to add badge counts to the sidebar icon (unread messages, failures)
- Fits naturally in the `layers/features/relay/` FSD module structure

**Cons:**

- Takes up permanent sidebar real estate — the sidebar already has Sessions + Pulse
- The panel is invisible when collapsed — users may miss new failures
- Less contextual: relay messages related to the active session are shown separately

**Complexity:** Low — reuses all Pulse UI patterns (PulsePanel → RelayPanel, RunHistoryPanel → RelayFeedPanel)
**Maintenance:** Low — one feature module, no cross-feature state sharing needed

---

#### Approach B: Integrated into Session View

Relay messages relevant to the active session are shown inline in the chat panel, interleaved with assistant messages. The sender's `from` subject is matched against the current session ID.

**Pros:**

- Maximum context — agent messages appear alongside the conversation that triggered them
- No extra UI surface required
- Users immediately see inter-agent communication as it happens

**Cons:**

- Coupling between session view and relay creates cross-feature model imports (violates FSD rules in `.claude/rules/fsd-layers.md`)
- Requires knowing which relay messages are "for" the active session — non-trivial mapping
- Clutters the chat interface with infrastructure-level events
- Hard to view relay messages without an active session
- No overview of all relay traffic across all sessions

**Complexity:** High — requires cross-feature coordination, new message type rendering in ChatPanel
**Maintenance:** High — tight coupling between features/chat and features/relay

---

#### Approach C: Notification Drawer

A slide-out panel anchored to the right edge of the viewport, triggered by a status bar icon with a badge count. Shows recent relay activity without navigation.

**Pros:**

- Non-intrusive — doesn't consume sidebar space
- Accessible from anywhere in the UI (any active session or panel)
- Status bar badge is immediately visible for new failures
- Overlay drawer doesn't compress main content (unlike inline sidebar)

**Cons:**

- Overlays the current view — disruptive for users who want to monitor relay while working
- No deep inbox browsing — drawers work for notifications but not complex filtering
- PatternFly's notification drawer design guidance explicitly notes: "Do not use the notification drawer as the sole place to notify users about events requiring immediate action"
- Adds a new UI primitive not currently in the DorkOS component library
- Cannot show both chat and relay activity simultaneously

**Complexity:** Medium — needs new drawer component, status bar integration, SSE badge count
**Maintenance:** Medium — status bar coupling, badge state management across features

---

#### Approach D: Split Panel (Activity Feed + Inbox Browser in Tabs)

A dedicated top-level panel (like Approach A) but with two distinct views in tabs:

- **Activity Feed tab**: Live SSE-powered chronological event stream, newest-first, all subjects
- **Endpoints tab**: Browse registered endpoints, click to view per-endpoint inbox, filter by status

This is the approach closest to how tools like Datadog event streams and AWS SQS consoles are designed.

**Pros:**

- Separates two distinct use cases: monitoring (activity feed) and management (endpoint inbox)
- The Activity Feed tab handles the "is anything broken?" question at a glance
- The Endpoints tab handles the "what's in my inbox?" question for agents
- Tab state can be preserved in URL params (`?relayTab=feed`)
- Both tabs share the same SSE connection — efficient

**Cons:**

- More UI surface area to design and build than Approach A
- Tabs add a layer of navigation that may not be needed initially
- Risk of under-populating the Endpoints tab if endpoint count is low in early usage

**Complexity:** Medium — two views but same FSD module structure as Pulse
**Maintenance:** Low — clean separation of concerns between tabs

---

### Security Considerations

#### Message Access Control

The `AccessControl` module in RelayCore already enforces YAML-configured `from -> to` rules. The REST and MCP layers must pass the correct `from` value — never let clients self-declare arbitrary sender identities without verification.

For the HTTP API, the `from` field in POST `/api/relay/messages` should be validated:

- In single-user DorkOS, the boundary check is sufficient (directory boundary)
- For multi-user deployments (future), `from` should be tied to the authenticated user's namespace

#### Endpoint Isolation

Each endpoint's Maildir is isolated by its SHA-256 hash of the subject. The REST API's inbox endpoint (`GET /api/relay/endpoints/:subject/inbox`) must:

1. Validate the subject against `isWithinBoundary` — not needed here, but the endpoint registry will only return subjects that were registered
2. Never expose raw file paths in responses
3. Enforce that the `from` in a send request matches a registered endpoint (optional but recommended)

#### SSE Authentication

The SSE stream endpoint should respect the same boundary checks as other endpoints. In the current DorkOS architecture there is no session-level auth (single-user local tool), so no additional auth is needed beyond what exists.

#### Budget Limits as a Security Layer

The RelayCore's budget system (`callBudgetRemaining`, `maxHops`, `ttl`) is also a security control against message amplification loops. The default limits (5 hops, 10 calls, 1-hour TTL) should be enforced by the server — the REST API should cap client-supplied budget overrides at reasonable maximums (e.g., `maxHops <= 10`, `ttl <= 24 * 3600 * 1000`).

---

### Performance Considerations

#### SSE Connection Management

The relay SSE stream uses `RelayCore.subscribe()` which registers a JavaScript callback — no filesystem watcher overhead per connection. This is more efficient than `SessionBroadcaster` (which uses chokidar). Each SSE client registers one subscription; cleanup is automatic via `req.on('close')`. No special connection registry is needed.

At 100 concurrent SSE clients each subscribing to `relay.>` (all messages), every published message triggers 100 synchronous callback invocations before the `publish()` call returns. For high-frequency relay usage, consider:

1. Limiting SSE clients to subject-scoped subscriptions (not `relay.>`)
2. Batching events within a 10ms window before flushing to SSE clients
3. Making SSE callbacks async with `setImmediate` to avoid blocking the publish pipeline

#### Message Volume Handling

The SQLite index is the performance bottleneck at high volume. The existing indexes cover the common query patterns. The `deleteExpired()` method on SqliteIndex should be called on a periodic interval (e.g., every 10 minutes) to prune expired messages and keep index size bounded. This mirrors the PulseStore retention pruning pattern.

#### React Query Polling vs. SSE for Feed Data

The client should use SSE for the live activity feed (new message events) and TanStack Query with a long stale time for endpoint/inbox data:

- `useRelayFeed()`: SSE subscription, appends events to a local list (Zustand store or `useRef` list)
- `useRelayEndpoints()`: TanStack Query, `staleTime: 60_000`, refetch on window focus
- `useRelayInbox(subject)`: TanStack Query, refetch triggered by SSE `relay_message` events for that subject (same pattern as session sync)

---

### Recommendation

**Recommended Approach: Approach D (Split Panel — Activity Feed + Endpoints Tabs)**

**Rationale:**

The split panel is the right architecture because the two use cases it serves — live activity monitoring and inbox management — have fundamentally different interaction models. The Activity Feed tab is a passive read-only stream; the Endpoints tab is an active management surface. Collapsing them into a single view (Approach A) forces visual compromises. Approach B creates FSD violations and tight coupling. Approach C (notification drawer) is not appropriate as the primary UI for a rich inbox system.

The split panel fits cleanly into the existing FSD module structure (`layers/features/relay/ui/RelayPanel.tsx` with `RelayFeedPanel.tsx` and `RelayEndpointsPanel.tsx` sub-components), mirrors the Pulse pattern (dedicated top-level panel), and can be built incrementally: ship Approach A first (activity feed only), then add the Endpoints tab in the next iteration.

**Implementation Order:**

1. `packages/relay` is already complete — no changes needed
2. `apps/server`: Add `routes/relay.ts` + register `RelayCore` singleton at startup + extend `McpToolDeps` + add relay tools to `mcp-tool-server.ts`
3. `packages/shared`: Add `RelayStreamEvent` union to schemas, add relay API request/response schemas
4. `apps/client`: Add `entities/relay/` (hooks: `useRelayFeed`, `useRelayEndpoints`, `useRelayInbox`) + `features/relay/` (RelayPanel, RelayFeedPanel, RelayEndpointsPanel) + sidebar entry point

**Caveats:**

- The `RelayCore` singleton must be initialized once at server startup and injected via dependency injection into the routes and MCP tool server — do not create multiple instances (each instance owns its own SQLite connection and chokidar watchers)
- The server service count will reach approximately 24 after adding relay services — the `.claude/rules/server-structure.md` threshold for considering domain grouping is 20+. Consider grouping existing services into domain directories at the same time
- The SSE `relay.>` subscription in RelayCore dispatches handlers synchronously within `publish()`. At very high publish rates, the SSE fan-out could introduce latency into the publish pipeline. Monitor and add async dispatch if needed.

---

## Search Methodology

- **Searches performed**: 12
- **Codebase files read**: 14 (relay-core.ts, sqlite-index.ts, types.ts, relay-schemas.ts, mcp-tool-server.ts, stream-adapter.ts, pulse.ts route, session-broadcaster.ts, PulsePanel.tsx, and relay index.ts)
- **Most productive search terms**: "SSE last-event-id reconnection backpressure Node.js", "MCP tool design error handling isError 2025", "cursor pagination inbox messages filtering REST"
- **Primary information sources**: modelcontextprotocol.io (official spec), shopify.engineering (SSE scale), speakeasy.com (pagination), MDN (SSE), DorkOS codebase

---

## Sources

- [MCP Tools Specification 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/)
- [15 Best Practices for Building MCP Servers in Production](https://thenewstack.io/15-best-practices-for-building-mcp-servers-in-production/)
- [Using Server-Sent Events — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [Shopify Engineering: Server-Sent Events Data Streaming](https://shopify.engineering/server-sent-events-data-streaming)
- [SSE: A Practical Guide for the Real World](https://tigerabrodi.blog/server-sent-events-a-practical-guide-for-the-real-world)
- [Server-Sent Events in OpenAPI Best Practices — Speakeasy](https://www.speakeasy.com/openapi/content/server-sent-events)
- [REST API Pagination Best Practices — Speakeasy](https://www.speakeasy.com/api-design/pagination)
- [Evolving API Pagination at Slack](https://slack.engineering/evolving-api-pagination-at-slack/)
- [JSON API Cursor Pagination Profile](https://jsonapi.org/profiles/ethanresnick/cursor-pagination/)
- [Moesif: REST API Design — Filtering, Sorting, Pagination](https://www.moesif.com/blog/technical/api-design/REST-API-Design-Filtering-Sorting-and-Pagination/)
- [Knock Docs: Feed Component for React](https://docs.knock.app/in-app-ui/react/feed)
- [Activity Stream Design Pattern — UI Patterns](https://ui-patterns.com/patterns/ActivityStream)
- [PatternFly Notification Drawer Design Guidelines](https://www.patternfly.org/components/notification-drawer/design-guidelines/)
- [Pagination vs Infinite Scroll — UX Patterns for Developers](https://uxpatterns.dev/pattern-guide/pagination-vs-infinite-scroll)
- [REST API Best Practices — Postman Blog](https://blog.postman.com/rest-api-best-practices/)
- [Web API Design Best Practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-design)
