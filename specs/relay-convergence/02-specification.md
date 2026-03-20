---
slug: relay-convergence
number: 55
created: 2026-02-25
status: draft
---

# Specification: Relay Convergence — Migrate Pulse & Console to Relay Transport

**Status:** Draft
**Authors:** Claude Code, 2026-02-25
**Ideation:** [01-ideation.md](./01-ideation.md)
**Research:** [research/20260224_relay_convergence.md](../../research/20260224_relay_convergence.md)
**Design Doc:** [plans/2026-02-24-relay-design.md](../../plans/2026-02-24-relay-design.md)

---

## Overview

Migrate Pulse scheduled dispatch and Console chat messaging to flow through Relay, completing the convergence where all DorkOS communication uses a single message bus transport. After this spec, every message in DorkOS — Console chat, Pulse dispatch, inter-agent, and external adapters — flows through RelayCore with unified delivery, tracing, and observability.

This is the final Relay spec (Phase 5 in the litepaper roadmap). Specs 50-54 built the core library, integrated it, hardened reliability, connected external channels, and established the Mesh foundation. This spec closes the loop by routing the two remaining direct-call paths (Pulse → AgentManager and Console → AgentManager) through Relay.

## Background / Problem Statement

Today, DorkOS has three communication pathways:

1. **Console → AgentManager** — HTTP POST streams SSE response on the same connection
2. **Pulse → AgentManager** — Direct function call from `SchedulerService.executeRun()`
3. **External/Inter-agent → Relay** — Messages flow through RelayCore with budget envelopes

Paths 1 and 2 bypass Relay entirely. This means:

- Pulse dispatches have no delivery receipts, budget envelopes, or dead letter handling
- Console messages don't appear in the unified Relay message log
- No end-to-end message tracing across the system
- Two different streaming protocols (SSE on POST response vs SSE EventSource)
- The architecture diagram in the litepaper isn't fully realized

The convergence eliminates these gaps by making Relay the universal transport for all communication.

## Goals

- Pulse dispatches via Relay: `SchedulerService` publishes to `relay.system.pulse.{scheduleId}` instead of calling AgentManager directly
- Console becomes a Relay endpoint: `relay.human.console.{clientId}`, with POST returning a receipt and responses arriving via SSE
- Single SSE stream carries both session sync and Relay events (fan-in)
- End-to-end message tracing: every message has a traceId, spans recorded in SQLite, queryable via API
- Client-side trace UI: click any message to see its delivery timeline
- Delivery metrics API: DLQ depth, latency, throughput, budget rejection counts
- Backwards-compatible: everything works when `DORKOS_RELAY_ENABLED=false`

## Non-Goals

- Additional external adapters beyond Spec 53 (Telegram, webhook)
- Additional runtime adapters (Codex, OpenCode) — future work
- AgentRuntimeAdapter interface extraction — deferred to Spec 6
- Multi-user support (DorkOS is single-user; Console uses clientId)
- Changes to the `packages/relay` core library (it's stable)
- Console activity feed (separate from trace UI; already exists in RelayPanel)
- Real-time metrics WebSocket (SSE is sufficient)

## Technical Dependencies

| Dependency              | Version   | Purpose                                           |
| ----------------------- | --------- | ------------------------------------------------- |
| `@dorkos/relay`         | workspace | RelayCore message bus (no changes needed)         |
| `@dorkos/shared`        | workspace | Zod schemas for trace types, extended StreamEvent |
| `better-sqlite3`        | existing  | Trace storage in `~/.dork/relay/index.db`         |
| `croner`                | existing  | Cron scheduling (no changes to cron logic)        |
| `chokidar`              | existing  | File watching for session sync (unchanged)        |
| `@tanstack/react-query` | existing  | Client data fetching for traces and metrics       |

No new external dependencies required.

## Detailed Design

### Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Pulse           │     │  Console          │     │ External        │
│  (cron timer)    │     │  (React SPA)      │     │ Adapters        │
└────────┬─────────┘     └────────┬──────────┘     └────────┬────────┘
         │                        │                         │
         │ relay.publish(         │ POST /messages          │
         │ 'relay.system.pulse.   │ → relay.publish(        │ relay.publish(
         │  {scheduleId}')        │ 'relay.agent.{sid}')    │ 'relay.human.*')
         │                        │                         │
         └────────────┬───────────┴─────────────────────────┘
                      │
                      ▼
              ┌───────────────────┐
              │    RelayCore       │
              │  subject matching  │
              │  budget check      │
              │  trace INSERT      │
              │  maildir delivery  │
              └───────┬───────────┘
                      │
                      ▼
              ┌───────────────────┐
              │  MessageReceiver   │  ← NEW service
              │  subscribes to:    │
              │  relay.agent.>     │
              │  relay.system.     │
              │    pulse.>         │
              └───────┬───────────┘
                      │
                      ▼
              ┌───────────────────┐
              │  AgentManager      │
              │  .sendMessage()    │
              │  → Claude SDK      │
              └───────┬───────────┘
                      │
                      ▼
              ┌───────────────────┐
              │  Response          │
              │  → relay.publish(  │
              │  replyTo subject)  │
              │  → SSE stream      │
              └───────────────────┘
```

### 1. Message Receiver Service

**New file:** `apps/server/src/services/relay/message-receiver.ts`

The MessageReceiver is the bridge between Relay and AgentManager. It subscribes to agent-targeted subjects and translates Relay message arrival into AgentManager calls.

```typescript
export interface MessageReceiverDeps {
  relay: RelayCore;
  agentManager: SchedulerAgentManager;
  traceStore: TraceStore;
}

export class MessageReceiver {
  constructor(private deps: MessageReceiverDeps) {}

  /** Start subscribing to agent and Pulse subjects. */
  async start(): Promise<void> {
    // Subscribe to agent messages (Console chat, inter-agent)
    this.deps.relay.subscribe('relay.agent.>', this.handleAgentMessage.bind(this));

    // Subscribe to Pulse dispatches
    this.deps.relay.subscribe('relay.system.pulse.>', this.handlePulseMessage.bind(this));
  }

  private async handleAgentMessage(envelope: RelayEnvelope): Promise<void> {
    // Extract sessionId from subject: relay.agent.{sessionId}
    const sessionId = extractSessionId(envelope.subject);
    const payload = envelope.payload as StandardPayload;

    // Update trace: mark as processing
    this.deps.traceStore.updateSpan(envelope.id, { status: 'processing', processedAt: Date.now() });

    // Call AgentManager and stream response
    const stream = this.deps.agentManager.sendMessage(sessionId, payload.content, {
      cwd: payload.platformData?.cwd,
      permissionMode: payload.platformData?.permissionMode,
    });

    // Publish response chunks back to sender via replyTo
    for await (const event of stream) {
      if (envelope.replyTo) {
        await this.deps.relay.publish(envelope.replyTo, {
          from: envelope.subject,
          payload: event,
          // Response budget is a subset of original
          budget: { ...envelope.budget, hopCount: envelope.budget.hopCount + 1 },
        });
      }
    }

    // Update trace: mark as delivered
    this.deps.traceStore.updateSpan(envelope.id, { status: 'delivered', deliveredAt: Date.now() });
  }

  private async handlePulseMessage(envelope: RelayEnvelope): Promise<void> {
    const payload = envelope.payload as PulseDispatchPayload;
    // Delegate to existing executeRun logic with schedule/run context from payload
    // (Details in Pulse Migration section below)
  }
}
```

### 2. Pulse Dispatch Migration

**Modified file:** `apps/server/src/services/pulse/scheduler-service.ts`

The `executeRun` method gains a Relay path controlled by `isRelayEnabled()`.

**Current flow:**

```
SchedulerService.executeRun()
  → agentManager.ensureSession()
  → agentManager.sendMessage()
  → iterate StreamEvents, update PulseStore
```

**New flow (when Relay enabled):**

```
SchedulerService.executeRun()
  → relay.publish('relay.system.pulse.{scheduleId}', envelope)
  → MessageReceiver.handlePulseMessage()
    → agentManager.ensureSession()
    → agentManager.sendMessage()
    → iterate StreamEvents, update PulseStore
    → publish response events to replyTo
```

**Changes to SchedulerService:**

1. Add optional `relay: RelayCore | null` to constructor deps
2. Import `isRelayEnabled` from `relay-state.ts`
3. In `executeRun()`, branch on `isRelayEnabled() && this.relay`:

```typescript
private async executeRun(schedule: PulseSchedule, run: PulseRun): Promise<void> {
  if (isRelayEnabled() && this.relay) {
    await this.executeRunViaRelay(schedule, run);
  } else {
    await this.executeRunDirect(schedule, run);
  }
}
```

4. Extract current `executeRun` body into `executeRunDirect()` (no changes)
5. New `executeRunViaRelay()` publishes to Relay:

```typescript
private async executeRunViaRelay(schedule: PulseSchedule, run: PulseRun): Promise<void> {
  const envelope = {
    subject: `relay.system.pulse.${schedule.id}`,
    from: 'relay.system.pulse',
    replyTo: `relay.system.pulse.${schedule.id}.response`,
    budget: createDefaultBudget({ maxHops: 3, ttlMs: schedule.maxRuntime ?? 3_600_000 }),
    payload: {
      type: 'pulse_dispatch',
      scheduleId: schedule.id,
      runId: run.id,
      prompt: schedule.prompt,
      cwd: schedule.cwd,
      permissionMode: schedule.permissionMode ?? 'acceptEdits',
      scheduleName: schedule.name,
      cron: schedule.cron,
      trigger: run.trigger,
    },
  };

  const result = await this.relay.publish(envelope.subject, envelope);

  if (result.deliveredCount === 0) {
    // No receiver — update run as failed
    this.store.updateRun(run.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: 'No Relay receiver for Pulse dispatch',
    });
  }
  // Run status updates happen in MessageReceiver.handlePulseMessage()
}
```

**New type:**

```typescript
/** Payload for Pulse dispatch via Relay. */
export interface PulseDispatchPayload {
  type: 'pulse_dispatch';
  scheduleId: string;
  runId: string;
  prompt: string;
  cwd: string | null;
  permissionMode: string;
  scheduleName: string;
  cron: string;
  trigger: string;
}
```

**MessageReceiver.handlePulseMessage()** reconstructs the `PulseSchedule` and `PulseRun` from the payload and delegates to the same agent execution logic, preserving run lifecycle (AbortController, status updates, output summary collection).

### 3. Console Migration

**Modified files:**

- `apps/server/src/routes/sessions.ts` — POST handler
- `apps/server/src/services/session/session-broadcaster.ts` — Fan-in Relay events
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Receipt+SSE protocol

#### Server-Side: POST /api/sessions/:id/messages

The POST handler branches on `isRelayEnabled()`:

```typescript
router.post('/:id/messages', async (req, res) => {
  // ... existing validation and lock acquisition ...

  if (isRelayEnabled() && relay) {
    // NEW PATH: Publish to Relay, return receipt
    const traceId = crypto.randomUUID();
    const messageId = ulid();
    const consoleSubject = `relay.human.console.${clientId}`;

    // Ensure Console endpoint is registered
    relay.registerEndpoint(consoleSubject);

    const result = await relay.publish(`relay.agent.${sessionId}`, {
      from: consoleSubject,
      replyTo: consoleSubject,
      budget: createDefaultBudget({ maxHops: 5, ttlMs: 300_000 }),
      payload: {
        content,
        platformData: { cwd, sessionId, clientId, traceId },
      } satisfies StandardPayload,
    });

    // Return receipt immediately (202)
    res.status(202).json({
      messageId: result.messageId,
      traceId,
      deliveredCount: result.deliveredCount,
    });
    // Response chunks arrive via SSE stream (session-broadcaster)
  } else {
    // EXISTING PATH: Stream SSE response on this connection
    initSSEStream(res);
    try {
      for await (const event of agentManager.sendMessage(sessionId, content, { cwd })) {
        sendSSEEvent(res, event);
        // ... existing SDK session ID tracking ...
      }
    } catch (err) {
      sendSSEEvent(res, {
        type: 'error',
        data: { message: err instanceof Error ? err.message : 'Unknown error' },
      });
    } finally {
      agentManager.releaseLock(sessionId, clientId);
      endSSEStream(res);
    }
  }
});
```

#### Server-Side: Session Broadcaster Fan-In

**Modified file:** `apps/server/src/services/session/session-broadcaster.ts`

The SessionBroadcaster gains a Relay subscription alongside its existing chokidar watcher:

```typescript
export class SessionBroadcaster {
  private relay: RelayCore | null = null;

  /** Inject Relay for fan-in event streaming. */
  setRelay(relay: RelayCore): void {
    this.relay = relay;
  }

  registerClient(sessionId: string, vaultRoot: string, res: Response): void {
    // ... existing client registration and watcher setup ...

    // Subscribe to Relay events for this client's Console endpoint
    const clientId = res.getHeader?.('x-client-id') as string;
    if (this.relay && clientId) {
      const consoleSubject = `relay.human.console.${clientId}`;
      this.relay.subscribe(consoleSubject, (envelope) => {
        // Fan Relay events into SSE stream as typed events
        const eventData = JSON.stringify(envelope.payload);
        res.write(`event: relay_message\ndata: ${eventData}\n\n`);
      });
    }
  }
}
```

**New SSE event types on `GET /api/sessions/:id/stream`:**

| Event Type          | Data                                         | When                             |
| ------------------- | -------------------------------------------- | -------------------------------- |
| `sync_connected`    | `{ sessionId }`                              | On initial connection (existing) |
| `sync_update`       | `{ sessionId, timestamp }`                   | JSONL file change (existing)     |
| `relay_message`     | StreamEvent (text*delta, tool_call*\*, etc.) | Agent response chunk via Relay   |
| `relay_receipt`     | `{ messageId, traceId }`                     | Message accepted by Relay        |
| `message_delivered` | `{ messageId, subject, status }`             | Delivery confirmation            |

#### Client-Side: use-chat-session.ts Protocol Change

**Modified file:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

The hook must handle both protocols:

1. **Legacy (Relay disabled):** POST returns SSE stream → iterate events → build message
2. **Relay (enabled):** POST returns receipt (202 JSON) → listen on existing EventSource → build message from `relay_message` events

```typescript
// In handleSubmit():
if (relayEnabled) {
  // New protocol: POST returns receipt, events come via EventSource
  const receipt = await transport.sendMessageRelay(sessionId, content, { cwd });
  // receipt = { messageId, traceId }
  // Response events arrive on the existing EventSource (session sync stream)
  // which is already connected and calling handleRelayMessage()
} else {
  // Existing protocol: SSE stream on POST response
  await transport.sendMessage(sessionId, content, onEvent, signal, cwd);
}
```

The EventSource listener (already connected for `sync_update`) gains handlers for `relay_message`:

```typescript
eventSource.addEventListener('relay_message', (e) => {
  const event = JSON.parse(e.data) as StreamEvent;
  handleStreamEvent(event); // Same handler as the legacy SSE stream
});
```

This means the `createStreamEventHandler()` function is reused for both paths — same event processing, different transport.

**Transport interface extension:**

```typescript
// Add to Transport interface
sendMessageRelay(
  sessionId: string,
  content: string,
  opts?: { cwd?: string }
): Promise<{ messageId: string; traceId: string }>;
```

### 4. Message Tracing

**New file:** `apps/server/src/services/relay/trace-store.ts`

#### Trace Schema

Added to the existing `~/.dork/relay/index.db` SQLite database:

```sql
CREATE TABLE IF NOT EXISTS message_traces (
  message_id     TEXT PRIMARY KEY,
  trace_id       TEXT NOT NULL,
  span_id        TEXT NOT NULL,
  parent_span_id TEXT,
  subject        TEXT NOT NULL,
  from_endpoint  TEXT NOT NULL,
  to_endpoint    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  budget_hops_used       INTEGER,
  budget_ttl_remaining_ms INTEGER,
  sent_at        INTEGER NOT NULL,
  delivered_at   INTEGER,
  processed_at   INTEGER,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON message_traces(trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_subject ON message_traces(subject);
CREATE INDEX IF NOT EXISTS idx_traces_sent_at ON message_traces(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_status ON message_traces(status) WHERE status = 'dead_lettered';
```

#### TraceStore Service

```typescript
export class TraceStore {
  constructor(private db: Database) {
    this.migrate();
  }

  /** Record a new trace span when a message is published. */
  insertSpan(span: TraceSpan): void {
    /* INSERT INTO message_traces */
  }

  /** Update span status (e.g., pending → delivered → processed). */
  updateSpan(messageId: string, update: Partial<TraceSpan>): void {
    /* UPDATE */
  }

  /** Get all spans for a trace (conversation thread). */
  getTrace(traceId: string): TraceSpan[] {
    /* SELECT ... ORDER BY sent_at */
  }

  /** Get delivery metrics (aggregate queries). */
  getMetrics(): DeliveryMetrics {
    /* COUNT, AVG queries */
  }
}
```

#### Trace Integration Points

1. **On `relay.publish()`:** Insert a span with `status: 'pending'`
2. **On successful Maildir delivery:** Update span to `status: 'delivered'`, set `delivered_at`
3. **On MessageReceiver processing:** Update span to `status: 'processed'`, set `processed_at`
4. **On dead letter:** Update span to `status: 'dead_lettered'`, set `error`

The trace is wired into RelayCore via a publish hook / event listener pattern — the TraceStore subscribes to RelayCore's delivery events rather than modifying RelayCore itself.

#### Trace Schemas (packages/shared)

**Added to `relay-schemas.ts`:**

```typescript
export const TraceSpanSchema = z
  .object({
    messageId: z.string(),
    traceId: z.string(),
    spanId: z.string(),
    parentSpanId: z.string().nullable(),
    subject: z.string(),
    fromEndpoint: z.string(),
    toEndpoint: z.string(),
    status: z.enum(['pending', 'delivered', 'processed', 'failed', 'dead_lettered']),
    budgetHopsUsed: z.number().int().nullable(),
    budgetTtlRemainingMs: z.number().int().nullable(),
    sentAt: z.number().int(),
    deliveredAt: z.number().int().nullable(),
    processedAt: z.number().int().nullable(),
    error: z.string().nullable(),
  })
  .openapi('TraceSpan');

export const DeliveryMetricsSchema = z
  .object({
    totalMessages: z.number().int(),
    deliveredCount: z.number().int(),
    failedCount: z.number().int(),
    deadLetteredCount: z.number().int(),
    avgDeliveryLatencyMs: z.number().nullable(),
    p95DeliveryLatencyMs: z.number().nullable(),
    activeEndpoints: z.number().int(),
    budgetRejections: z.object({
      hopLimit: z.number().int(),
      ttlExpired: z.number().int(),
      cycleDetected: z.number().int(),
      budgetExhausted: z.number().int(),
    }),
  })
  .openapi('DeliveryMetrics');
```

### 5. Trace API Endpoints

**Extended in:** `apps/server/src/routes/relay.ts`

| Method | Path                            | Description                                              |
| ------ | ------------------------------- | -------------------------------------------------------- |
| `GET`  | `/api/relay/messages/:id/trace` | Full trace for a message (all spans sharing the traceId) |
| `GET`  | `/api/relay/metrics`            | Aggregate delivery metrics                               |

```typescript
// GET /api/relay/messages/:id/trace
router.get('/messages/:id/trace', (req, res) => {
  const messageId = req.params.id;
  const span = traceStore.getSpanByMessageId(messageId);
  if (!span) return res.status(404).json({ error: 'Message not found' });

  const trace = traceStore.getTrace(span.traceId);
  res.json({ traceId: span.traceId, spans: trace });
});

// GET /api/relay/metrics
router.get('/metrics', (_req, res) => {
  const metrics = traceStore.getMetrics();
  res.json(metrics);
});
```

### 6. MCP Tool Extensions

**Modified file:** `apps/server/src/services/core/mcp-tool-server.ts`

New tools for agent access to tracing:

| Tool                | Description                     |
| ------------------- | ------------------------------- |
| `relay_get_trace`   | Get full trace for a message ID |
| `relay_get_metrics` | Get delivery metrics snapshot   |

### 7. Message Trace UI

**New files in `apps/client/`:**

#### Entity Layer

**`apps/client/src/layers/entities/relay/model/use-message-trace.ts`**

```typescript
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

**`apps/client/src/layers/entities/relay/model/use-delivery-metrics.ts`**

```typescript
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

#### Feature Layer

**`apps/client/src/layers/features/relay/ui/MessageTrace.tsx`**

A vertical timeline component showing the delivery path of a message:

```
┌────────────────────────────────────────────────┐
│  Message Trace: abc123                          │
├────────────────────────────────────────────────┤
│                                                │
│  ● Sent                     10:32:01.123       │
│  │ relay.human.console.xyz → relay.agent.sess1 │
│  │ Budget: 5 hops, TTL 5min                    │
│  │                                             │
│  ● Budget Check             +0.1ms             │
│  │ Hops: 0/5, TTL: 299.9s remaining           │
│  │                                             │
│  ● Delivered                +0.3ms             │
│  │ Maildir: new/abc123                         │
│  │                                             │
│  ● Processing               +1.2ms             │
│  │ MessageReceiver → AgentManager              │
│  │                                             │
│  ● Response                 +4523ms            │
│  │ 12 events streamed to console endpoint      │
│  │                                             │
│  ✓ Complete                 4.5s total         │
│                                                │
└────────────────────────────────────────────────┘
```

- Colored status dots: green (delivered), red (failed), yellow (pending), gray (dead_lettered)
- Latency deltas between each span
- Budget consumption shown at each hop
- Clickable from MessageRow in the existing RelayPanel ActivityFeed

**`apps/client/src/layers/features/relay/ui/DeliveryMetrics.tsx`**

A compact metrics dashboard added to the existing RelayPanel:

- DLQ depth (with warning badge when > 0)
- Delivery latency (p50 / p95)
- Messages delivered / failed (last 24h)
- Budget rejection breakdown (hop limit, TTL, cycle, exhausted)
- Active endpoint count

Uses `useDeliveryMetrics()` with 30s auto-refresh.

### 8. Feature Flag Integration

**Single flag:** `DORKOS_RELAY_ENABLED` controls all convergence behavior.

The existing `isRelayEnabled()` from `relay-state.ts` is the check point. No new flags.

**Behavior matrix:**

| DORKOS_RELAY_ENABLED | Pulse Dispatch           | Console Messages          | Tracing  | Trace UI |
| -------------------- | ------------------------ | ------------------------- | -------- | -------- |
| `false`              | Direct AgentManager call | SSE stream on POST        | Disabled | Hidden   |
| `true`               | Via Relay publish        | Via Relay (receipt + SSE) | Active   | Visible  |

**Fallback guarantee:** When Relay is disabled, both Pulse and Console operate exactly as they do today. No behavioral change.

### 9. Initialization Order

**Modified file:** `apps/server/src/index.ts`

```
1. Express app setup
2. RelayCore initialization (if enabled)
3. TraceStore initialization (if Relay enabled)
4. MessageReceiver initialization (depends on RelayCore + AgentManager)
5. SessionBroadcaster.setRelay(relay) (if Relay enabled)
6. SchedulerService with relay injection (if Relay enabled)
7. MCP tool server with traceStore injection
8. Route mounting
9. Server listen
```

The key addition is MessageReceiver starting its subscriptions after both RelayCore and AgentManager are available.

## User Experience

### Console Chat (Relay Enabled)

From the user's perspective, chat behavior is identical:

1. Type message, press Enter
2. Message appears immediately in chat
3. Agent response streams in word-by-word
4. Tool calls, approvals, questions all work the same

The only visible difference: messages now have trace IDs and are visible in the Relay panel's activity feed.

### Message Trace UI

Users can click any message in the Relay panel to see its delivery timeline:

- When was it sent?
- How long did budget checking take?
- When was it delivered to the mailbox?
- When did the agent start processing?
- How long was the total round-trip?
- Were there any errors or dead letters?

### Pulse Runs (Relay Enabled)

Pulse scheduled runs work identically. The difference:

- Each dispatch appears in the Relay activity feed
- Failed dispatches land in the dead letter queue (visible in Relay panel)
- Budget envelopes prevent runaway agent loops in complex multi-agent schedules

### Delivery Metrics

The Relay panel gains a metrics section showing system health:

- DLQ depth (0 is healthy)
- Delivery latency
- Budget rejection counts

## Testing Strategy

### Unit Tests

**scheduler-service.test.ts (modified):**

- Test `executeRunViaRelay()` publishes correct envelope to Relay
- Test fallback to `executeRunDirect()` when Relay disabled
- Test PulseDispatchPayload contains all required fields
- Mock RelayCore.publish() and verify envelope structure

**trace-store.test.ts (new):**

- Test span insertion and retrieval
- Test trace grouping by traceId
- Test status updates (pending → delivered → processed)
- Test metrics aggregation queries
- Test partial index for dead_lettered status

**message-receiver.test.ts (new):**

- Test agent message handling: correct sessionId extraction, AgentManager called
- Test Pulse message handling: schedule/run context reconstructed correctly
- Test trace updates at each lifecycle stage
- Test error handling when AgentManager throws

**sessions.test.ts (modified):**

- Test Relay path: POST returns 202 with receipt
- Test legacy path: POST returns SSE stream (when Relay disabled)
- Test endpoint registration on first message
- Test lock acquisition still works in Relay path

### Client Tests

**use-chat-session.test.tsx (modified):**

- Test receipt+SSE protocol: POST returns JSON, events arrive via EventSource
- Test legacy protocol: SSE stream on POST (when Relay disabled)
- Test `relay_message` event handler builds assistant message correctly
- Test both protocols produce identical UI state

**MessageTrace.test.tsx (new):**

- Test timeline rendering from trace data
- Test status badge colors
- Test latency delta calculations
- Test empty/error states

**DeliveryMetrics.test.tsx (new):**

- Test metrics display with various data
- Test DLQ warning badge appears when depth > 0
- Test loading and error states

### Integration Tests

- End-to-end: Send Console message → Relay publishes → MessageReceiver processes → response arrives via SSE → client displays
- End-to-end: Pulse dispatches → Relay publishes → MessageReceiver processes → run status updated → trace recorded
- Fallback: Disable Relay → verify both Console and Pulse work via direct path
- Multi-tab: Two clients with different clientIds both receive their own responses

## Performance Considerations

- **Trace write latency:** ~0.1-0.5ms per message (synchronous SQLite INSERT in WAL mode). Negligible vs LLM response times (seconds). No batching needed at DorkOS scale.
- **SSE fan-in:** Merging Relay events into the existing SSE stream reduces browser connection count by 1. Single EventSource is cleaner than two.
- **Console protocol change:** POST returns immediately (no hanging request). SSE delivers response chunks. May feel slightly faster for users since the POST doesn't block.
- **Relay overhead:** Subject matching + Maildir write + SQLite index is ~1-2ms per message. Imperceptible.
- **Metrics queries:** Live SQL aggregates (COUNT, AVG) on indexed columns. At DorkOS scale (tens of messages/minute), these complete in <1ms.

## Security Considerations

- **Console endpoint scoping:** `relay.human.console.{clientId}` uses the existing `X-Client-Id` UUID header. No new authentication surface.
- **Trace data:** Stores metadata only (subjects, timestamps, status). Message payload content is NOT stored in traces. Same retention pruning as Relay messages.
- **Dead letter queue access:** Gated behind existing boundary validation. No new access paths.
- **Budget envelope integrity:** Relay enforces that budgets can only decrease. Response messages inherit the parent budget with incremented hop count.
- **Pulse dispatch validation:** MessageReceiver validates PulseDispatchPayload schema before executing. Malformed envelopes are rejected to DLQ.

## Documentation Updates

| Document                        | Changes                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                     | Update Session Architecture section to describe Relay convergence. Update scheduler-service description. Add MessageReceiver and TraceStore to services list. Update SSE streaming protocol description. |
| `contributing/architecture.md`  | Add converged data flow diagram. Document receipt+SSE protocol. Document MessageReceiver service.                                                                                                        |
| `contributing/api-reference.md` | Document new/changed endpoints (POST /messages 202, GET /trace, GET /metrics). Document new SSE event types.                                                                                             |
| `contributing/data-fetching.md` | Add useMessageTrace and useDeliveryMetrics patterns.                                                                                                                                                     |

## Implementation Phases

### Phase 1: Server Infrastructure

- Create TraceStore service with SQLite schema and migration
- Create MessageReceiver service with agent and Pulse subscription handlers
- Wire TraceStore into RelayCore's publish/delivery lifecycle
- Add trace/metrics API endpoints to relay routes
- Add MCP tools for trace access

### Phase 2: Pulse Migration

- Modify SchedulerService to accept optional RelayCore dependency
- Implement `executeRunViaRelay()` with PulseDispatchPayload
- Implement MessageReceiver.handlePulseMessage() with full run lifecycle
- Wire initialization in index.ts (Relay → MessageReceiver → SchedulerService)
- Update scheduler-service tests

### Phase 3: Console Migration (Server)

- Modify POST /messages handler with Relay path (202 receipt)
- Extend SessionBroadcaster with Relay subscription fan-in
- Register Console endpoints on SSE connection
- Add new SSE event types (relay_message, relay_receipt, message_delivered)
- Update sessions route tests

### Phase 4: Console Migration (Client)

- Extend Transport interface with `sendMessageRelay()`
- Implement in HttpTransport and DirectTransport
- Update use-chat-session.ts to handle receipt+SSE protocol
- Add relay_message EventSource listener
- Ensure both protocols produce identical UI behavior
- Update client tests

### Phase 5: Trace UI

- Create useMessageTrace and useDeliveryMetrics entity hooks
- Build MessageTrace timeline component
- Build DeliveryMetrics dashboard component
- Integrate into existing RelayPanel
- Add click-to-trace from MessageRow

### Phase 6: Documentation & Cleanup

- Update CLAUDE.md, contributing guides, API reference
- Verify all acceptance criteria
- Remove any temporary scaffolding

## Open Questions

1. ~~**How should the MessageReceiver handle the existing interactive flows (tool approvals, AskUserQuestion)?**~~ (RESOLVED)
   **Answer:** Interactive events (approval_required, question_prompt) are published back to the Console endpoint via Relay as StreamEvent payloads. The approve/deny/submit-answers endpoints remain HTTP POST (not routed through Relay) since they're synchronous control commands, not messages.

2. ~~**Should the Relay envelope carry the full StreamEvent union or just the payload content?**~~ (RESOLVED)
   **Answer:** Carry the full StreamEvent as the envelope payload. The client's event handler already understands StreamEvent types. This avoids re-mapping at the Console endpoint boundary.

3. ~~**How should session creation work in the Relay path?**~~ (RESOLVED)
   **Answer:** The MessageReceiver calls `ensureSession()` when it first receives a message for an unknown sessionId. The Console's POST /sessions endpoint (session creation) remains unchanged — it still calls `agentManager.ensureSession()` directly.

4. ~~**How to handle the client's `useRelayEnabled()` flag to switch protocols?**~~ (RESOLVED)
   **Answer:** The existing `useRelayEnabled()` hook reads from server config. The `use-chat-session` hook uses this to decide which protocol to use. The server config endpoint already reflects whether Relay is active via `isRelayEnabled()`.

## Related ADRs

| ADR  | Title                                     | Relevance                                                                     |
| ---- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| 0010 | Use Maildir for Relay Message Storage     | Message storage format used by Pulse dispatch and Console messages            |
| 0011 | Use NATS-Style Subject Matching           | Subject hierarchy used for `relay.system.pulse.*` and `relay.human.console.*` |
| 0013 | Use Hybrid Maildir + SQLite Storage       | Trace storage extends the same SQLite index                                   |
| 0017 | Standardize Subsystem Integration Pattern | MessageReceiver follows the same integration pattern                          |
| 0018 | Server-Side SSE Subject Filtering         | SSE fan-in extends this pattern                                               |

## References

- [Ideation document](./01-ideation.md)
- [Research report](../../research/20260224_relay_convergence.md)
- [Relay design doc](../../plans/2026-02-24-relay-design.md)
- [Relay litepaper](../../meta/modules/relay-litepaper.md)
- [Convergence spec prompt](../../plans/relay-specs/05-relay-convergence.md)
- [Strangler Fig Pattern — AWS](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/strangler-fig.html)
- [OpenTelemetry Context Propagation](https://opentelemetry.io/docs/concepts/context-propagation/)
- [SSE Fan-In Pattern — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
