---
slug: relay-convergence
number: 55
created: 2026-02-25
status: draft
lastDecompose: 2026-02-25
---

# Tasks: Relay Convergence — Migrate Pulse & Console to Relay Transport

## Task Summary

| Phase   | Tasks   | Description                                                   |
| ------- | ------- | ------------------------------------------------------------- |
| Phase 1 | T1-T5   | Server Infrastructure (TraceStore, MessageReceiver, API, MCP) |
| Phase 2 | T6-T8   | Pulse Migration (SchedulerService Relay path)                 |
| Phase 3 | T9-T11  | Console Migration — Server (POST 202, SSE fan-in)             |
| Phase 4 | T12-T14 | Console Migration — Client (Transport, use-chat-session)      |
| Phase 5 | T15-T17 | Trace UI (hooks, timeline, metrics dashboard)                 |
| Phase 6 | T18     | Documentation & Cleanup                                       |

**Total: 18 tasks**

## Dependency Graph

```
T1 (TraceStore schemas) ──────┐
                               ├─→ T2 (TraceStore service)
                               │     ├─→ T3 (MessageReceiver)
                               │     │     ├─→ T6 (SchedulerService Relay dep)
                               │     │     │     └─→ T7 (executeRunViaRelay)
                               │     │     │           └─→ T8 (handlePulseMessage)
                               │     │     ├─→ T9 (POST 202 receipt)
                               │     │     │     └─→ T10 (SSE fan-in)
                               │     │     │           └─→ T11 (SSE event types)
                               │     │     └─→ T5 (Initialization wiring)
                               │     ├─→ T4 (Trace API + MCP tools)
                               │     └─→ T15 (useMessageTrace hook)
                               │           └─→ T16 (MessageTrace UI)
T4 (Trace API) ───────────────→ T15
T4 (Trace API) ───────────────→ T17 (DeliveryMetrics UI)
T10 (SSE fan-in) ─────────────→ T12 (Transport extension)
T12 (Transport extension) ────→ T13 (use-chat-session protocol)
T13 ──────────────────────────→ T14 (Client tests)
T8 + T11 + T14 + T16 + T17 ──→ T18 (Documentation)
```

## Parallel Execution Opportunities

- **T6 + T9** can run in parallel (both depend on T3, independent of each other)
- **T15 + T12** can run in parallel (T15 depends on T4, T12 depends on T10)
- **T16 + T17** can run in parallel (both are independent UI components)

## Critical Path

T1 → T2 → T3 → T9 → T10 → T12 → T13 → T14 → T18

---

## Phase 1: Server Infrastructure

### T1: Add TraceSpan and DeliveryMetrics Zod schemas to packages/shared

**Blocked by:** None
**Files:**

- `packages/shared/src/relay-schemas.ts` — Add schemas
- `packages/shared/src/types.ts` — Re-export types

**Implementation:**

Add the following to `packages/shared/src/relay-schemas.ts`:

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

export type TraceSpan = z.infer<typeof TraceSpanSchema>;

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

export type DeliveryMetrics = z.infer<typeof DeliveryMetricsSchema>;

export const PulseDispatchPayloadSchema = z.object({
  type: z.literal('pulse_dispatch'),
  scheduleId: z.string(),
  runId: z.string(),
  prompt: z.string(),
  cwd: z.string().nullable(),
  permissionMode: z.string(),
  scheduleName: z.string(),
  cron: z.string(),
  trigger: z.string(),
});

export type PulseDispatchPayload = z.infer<typeof PulseDispatchPayloadSchema>;
```

**Acceptance Criteria:**

- [ ] TraceSpanSchema validates all required fields (messageId, traceId, spanId, subject, fromEndpoint, toEndpoint, status, sentAt)
- [ ] TraceSpanSchema allows nullable optional fields (parentSpanId, deliveredAt, processedAt, error, budgetHopsUsed, budgetTtlRemainingMs)
- [ ] DeliveryMetricsSchema includes budgetRejections sub-object with all four rejection types
- [ ] PulseDispatchPayloadSchema validates the pulse_dispatch literal type
- [ ] Types are exported from relay-schemas.ts
- [ ] `npm run typecheck` passes

---

### T2: Create TraceStore service with SQLite schema

**Blocked by:** T1
**Files:**

- `apps/server/src/services/relay/trace-store.ts` — New service
- `apps/server/src/services/relay/__tests__/trace-store.test.ts` — Unit tests

**SQLite Schema:**

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

**TraceStore Service:**

```typescript
import type Database from 'better-sqlite3';
import type { TraceSpan, DeliveryMetrics } from '@dorkos/shared/relay-schemas';

export class TraceStore {
  constructor(private db: Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
    `);
  }

  /** Record a new trace span when a message is published. */
  insertSpan(span: TraceSpan): void {
    const stmt = this.db.prepare(`
      INSERT INTO message_traces (message_id, trace_id, span_id, parent_span_id, subject, from_endpoint, to_endpoint, status, budget_hops_used, budget_ttl_remaining_ms, sent_at, delivered_at, processed_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      span.messageId,
      span.traceId,
      span.spanId,
      span.parentSpanId,
      span.subject,
      span.fromEndpoint,
      span.toEndpoint,
      span.status,
      span.budgetHopsUsed,
      span.budgetTtlRemainingMs,
      span.sentAt,
      span.deliveredAt,
      span.processedAt,
      span.error
    );
  }

  /** Update span status (e.g., pending -> delivered -> processed). */
  updateSpan(messageId: string, update: Partial<TraceSpan>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(update)) {
      if (key === 'messageId') continue;
      const col = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
      fields.push(`${col} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(messageId);
    this.db
      .prepare(`UPDATE message_traces SET ${fields.join(', ')} WHERE message_id = ?`)
      .run(...values);
  }

  /** Get a single span by message ID. */
  getSpanByMessageId(messageId: string): TraceSpan | null {
    const row = this.db
      .prepare('SELECT * FROM message_traces WHERE message_id = ?')
      .get(messageId) as Record<string, unknown> | undefined;
    return row ? this.rowToSpan(row) : null;
  }

  /** Get all spans for a trace (conversation thread). */
  getTrace(traceId: string): TraceSpan[] {
    const rows = this.db
      .prepare('SELECT * FROM message_traces WHERE trace_id = ? ORDER BY sent_at')
      .all(traceId) as Record<string, unknown>[];
    return rows.map(this.rowToSpan);
  }

  /** Get delivery metrics (aggregate queries). */
  getMetrics(): DeliveryMetrics {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM message_traces').get() as {
      count: number;
    };
    const delivered = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM message_traces WHERE status IN ('delivered', 'processed')"
      )
      .get() as { count: number };
    const failed = this.db
      .prepare("SELECT COUNT(*) as count FROM message_traces WHERE status = 'failed'")
      .get() as { count: number };
    const deadLettered = this.db
      .prepare("SELECT COUNT(*) as count FROM message_traces WHERE status = 'dead_lettered'")
      .get() as { count: number };
    const latency = this.db
      .prepare(
        'SELECT AVG(delivered_at - sent_at) as avg_ms FROM message_traces WHERE delivered_at IS NOT NULL'
      )
      .get() as { avg_ms: number | null };
    const p95 = this.db
      .prepare(
        `
      SELECT (delivered_at - sent_at) as latency_ms FROM message_traces
      WHERE delivered_at IS NOT NULL ORDER BY latency_ms
      LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.95 AS INTEGER) FROM message_traces WHERE delivered_at IS NOT NULL)
    `
      )
      .get() as { latency_ms: number } | undefined;
    const endpoints = this.db
      .prepare(
        "SELECT COUNT(DISTINCT to_endpoint) as count FROM message_traces WHERE status != 'dead_lettered'"
      )
      .get() as { count: number };

    return {
      totalMessages: total.count,
      deliveredCount: delivered.count,
      failedCount: failed.count,
      deadLetteredCount: deadLettered.count,
      avgDeliveryLatencyMs: latency.avg_ms,
      p95DeliveryLatencyMs: p95?.latency_ms ?? null,
      activeEndpoints: endpoints.count,
      budgetRejections: {
        hopLimit: this.countByError('hop_limit_exceeded'),
        ttlExpired: this.countByError('ttl_expired'),
        cycleDetected: this.countByError('cycle_detected'),
        budgetExhausted: this.countByError('budget_exhausted'),
      },
    };
  }

  private countByError(errorPattern: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM message_traces WHERE error LIKE ?')
      .get(`%${errorPattern}%`) as { count: number };
    return row.count;
  }

  private rowToSpan(row: Record<string, unknown>): TraceSpan {
    return {
      messageId: row.message_id as string,
      traceId: row.trace_id as string,
      spanId: row.span_id as string,
      parentSpanId: row.parent_span_id as string | null,
      subject: row.subject as string,
      fromEndpoint: row.from_endpoint as string,
      toEndpoint: row.to_endpoint as string,
      status: row.status as TraceSpan['status'],
      budgetHopsUsed: row.budget_hops_used as number | null,
      budgetTtlRemainingMs: row.budget_ttl_remaining_ms as number | null,
      sentAt: row.sent_at as number,
      deliveredAt: row.delivered_at as number | null,
      processedAt: row.processed_at as number | null,
      error: row.error as string | null,
    };
  }
}
```

**Tests:**

- Insert span and retrieve by messageId
- Insert span, update status to 'delivered' with deliveredAt, verify update persisted
- Insert multiple spans with same traceId, retrieve via getTrace(), verify ordering by sent_at
- getMetrics() returns correct counts for total, delivered, failed, dead_lettered
- getMetrics() returns avg and p95 latency
- getMetrics() counts budget rejection errors correctly
- getSpanByMessageId() returns null for non-existent ID

**Acceptance Criteria:**

- [ ] SQLite table created with all columns matching schema
- [ ] Indexes on trace_id, subject, sent_at (DESC), and partial index on status='dead_lettered'
- [ ] insertSpan, updateSpan, getSpanByMessageId, getTrace, getMetrics all work correctly
- [ ] Column name conversion from camelCase to snake_case works in updateSpan
- [ ] All unit tests pass

---

### T3: Create MessageReceiver service

**Blocked by:** T2
**Files:**

- `apps/server/src/services/relay/message-receiver.ts` — New service
- `apps/server/src/services/relay/__tests__/message-receiver.test.ts` — Unit tests

**Implementation:**

```typescript
import type { RelayCore, RelayEnvelope } from '@dorkos/relay';
import type { TraceStore } from './trace-store';
import type { PulseDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';

export interface SchedulerAgentManager {
  ensureSession(sessionId: string, opts?: { cwd?: string; permissionMode?: string }): Promise<void>;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: { cwd?: string; permissionMode?: string }
  ): AsyncIterable<StreamEvent>;
}

export interface MessageReceiverDeps {
  relay: RelayCore;
  agentManager: SchedulerAgentManager;
  traceStore: TraceStore;
  pulseStore?: PulseStore | null;
}

export class MessageReceiver {
  constructor(private deps: MessageReceiverDeps) {}

  /** Start subscribing to agent and Pulse subjects. */
  async start(): Promise<void> {
    this.deps.relay.subscribe('relay.agent.>', this.handleAgentMessage.bind(this));
    this.deps.relay.subscribe('relay.system.pulse.>', this.handlePulseMessage.bind(this));
  }

  private async handleAgentMessage(envelope: RelayEnvelope): Promise<void> {
    const sessionId = extractSessionId(envelope.subject);
    const payload = envelope.payload as {
      content: string;
      platformData?: { cwd?: string; permissionMode?: string };
    };

    this.deps.traceStore.updateSpan(envelope.id, { status: 'processing', processedAt: Date.now() });

    try {
      await this.deps.agentManager.ensureSession(sessionId, {
        cwd: payload.platformData?.cwd,
        permissionMode: payload.platformData?.permissionMode,
      });

      const stream = this.deps.agentManager.sendMessage(sessionId, payload.content, {
        cwd: payload.platformData?.cwd,
        permissionMode: payload.platformData?.permissionMode,
      });

      for await (const event of stream) {
        if (envelope.replyTo) {
          await this.deps.relay.publish(envelope.replyTo, {
            from: envelope.subject,
            payload: event,
            budget: { ...envelope.budget, hopCount: envelope.budget.hopCount + 1 },
          });
        }
      }

      this.deps.traceStore.updateSpan(envelope.id, {
        status: 'delivered',
        deliveredAt: Date.now(),
      });
    } catch (error) {
      this.deps.traceStore.updateSpan(envelope.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async handlePulseMessage(envelope: RelayEnvelope): Promise<void> {
    // Stub — full implementation in T8
    const payload = envelope.payload as PulseDispatchPayload;
    if (payload.type !== 'pulse_dispatch') {
      this.deps.traceStore.updateSpan(envelope.id, {
        status: 'dead_lettered',
        error: `Invalid payload type: expected pulse_dispatch`,
      });
      return;
    }
    this.deps.traceStore.updateSpan(envelope.id, { status: 'processing', processedAt: Date.now() });
  }
}

function extractSessionId(subject: string): string {
  const parts = subject.split('.');
  return parts[parts.length - 1];
}
```

**Tests:**

- handleAgentMessage extracts correct sessionId from subject `relay.agent.{sessionId}`
- handleAgentMessage calls agentManager.ensureSession and sendMessage with correct params
- handleAgentMessage publishes response events to replyTo subject with incremented hop count
- handleAgentMessage updates trace to 'processing' then 'delivered'
- handleAgentMessage updates trace to 'failed' when AgentManager throws
- handlePulseMessage validates payload type and rejects invalid types
- start() subscribes to both relay.agent.> and relay.system.pulse.> subjects

**Acceptance Criteria:**

- [ ] Subscribes to relay.agent.> and relay.system.pulse.> subjects
- [ ] Correctly extracts sessionId from relay.agent.{sessionId} subject
- [ ] Calls agentManager.ensureSession and sendMessage
- [ ] Publishes response chunks to replyTo subject with incremented hop count
- [ ] Updates trace status through lifecycle: processing -> delivered (or failed)
- [ ] Validates PulseDispatchPayload before processing
- [ ] All unit tests pass

---

### T4: Add trace and metrics API endpoints + MCP tools

**Blocked by:** T2
**Files:**

- `apps/server/src/routes/relay.ts` — Add GET /messages/:id/trace and GET /metrics
- `apps/server/src/services/core/mcp-tool-server.ts` — Add relay_get_trace and relay_get_metrics tools

**API Endpoints:**

```typescript
// GET /api/relay/messages/:id/trace
router.get('/messages/:id/trace', (req, res) => {
  if (!isRelayEnabled()) return res.status(404).json({ error: 'Relay not enabled' });
  const messageId = req.params.id;
  const span = traceStore.getSpanByMessageId(messageId);
  if (!span) return res.status(404).json({ error: 'Message not found' });

  const trace = traceStore.getTrace(span.traceId);
  res.json({ traceId: span.traceId, spans: trace });
});

// GET /api/relay/metrics
router.get('/metrics', (_req, res) => {
  if (!isRelayEnabled()) return res.status(404).json({ error: 'Relay not enabled' });
  const metrics = traceStore.getMetrics();
  res.json(metrics);
});
```

**MCP Tools (add to mcp-tool-server.ts):**

```typescript
tool('relay_get_trace', {
  description:
    'Get the full delivery trace for a message by ID. Returns all trace spans sharing the same traceId, showing the message delivery timeline.',
  parameters: z.object({ messageId: z.string().describe('The message ID to get trace for') }),
  handler: async ({ messageId }) => {
    if (!deps.traceStore) return { error: 'Tracing not enabled' };
    const span = deps.traceStore.getSpanByMessageId(messageId);
    if (!span) return { error: 'Message not found' };
    const trace = deps.traceStore.getTrace(span.traceId);
    return { traceId: span.traceId, spans: trace };
  },
});

tool('relay_get_metrics', {
  description:
    'Get aggregate delivery metrics including message counts, latency, DLQ depth, and budget rejection breakdown.',
  parameters: z.object({}),
  handler: async () => {
    if (!deps.traceStore) return { error: 'Tracing not enabled' };
    return deps.traceStore.getMetrics();
  },
});
```

**Update McpToolDeps interface:**

```typescript
export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  defaultCwd: string;
  pulseStore: PulseStore | null;
  relayCore: RelayCore | null;
  traceStore: TraceStore | null; // ADD THIS
}
```

**Acceptance Criteria:**

- [ ] GET /api/relay/messages/:id/trace returns 404 when Relay disabled
- [ ] GET /api/relay/messages/:id/trace returns 404 when message not found
- [ ] GET /api/relay/messages/:id/trace returns { traceId, spans[] } for valid message
- [ ] GET /api/relay/metrics returns DeliveryMetrics shape
- [ ] relay_get_trace MCP tool returns trace for valid messageId
- [ ] relay_get_metrics MCP tool returns metrics snapshot
- [ ] McpToolDeps includes traceStore field

---

### T5: Wire TraceStore and MessageReceiver into server initialization

**Blocked by:** T2, T3
**Files:**

- `apps/server/src/index.ts` — Initialization order
- `apps/server/src/services/relay/index.ts` — Re-export new services

**Initialization order (add after RelayCore initialization):**

```typescript
let traceStore: TraceStore | null = null;
let messageReceiver: MessageReceiver | null = null;

if (isRelayEnabled() && relayCore) {
  // 1. TraceStore — uses same SQLite database as Relay
  const relayDb = getRelayDatabase();
  traceStore = new TraceStore(relayDb);

  // 2. MessageReceiver — depends on RelayCore + AgentManager + TraceStore
  messageReceiver = new MessageReceiver({
    relay: relayCore,
    agentManager,
    traceStore,
  });
  await messageReceiver.start();

  // 3. SessionBroadcaster gets Relay reference for fan-in
  sessionBroadcaster.setRelay(relayCore);
}

// Pass traceStore to MCP tool server
const mcpToolServer = createDorkOsToolServer({
  transcriptReader,
  defaultCwd,
  pulseStore,
  relayCore,
  traceStore,
});

// Pass traceStore to relay routes
app.use('/api/relay', createRelayRoutes({ relayCore, traceStore }));
```

**Re-exports (apps/server/src/services/relay/index.ts):**

```typescript
export { TraceStore } from './trace-store';
export { MessageReceiver } from './message-receiver';
export type { MessageReceiverDeps, SchedulerAgentManager } from './message-receiver';
```

**Acceptance Criteria:**

- [ ] TraceStore initializes only when Relay is enabled
- [ ] MessageReceiver starts after RelayCore and AgentManager are available
- [ ] SessionBroadcaster.setRelay() called when Relay enabled
- [ ] traceStore passed to MCP tool server deps
- [ ] traceStore passed to relay routes
- [ ] New services re-exported from relay/index.ts
- [ ] Server starts correctly with Relay enabled and disabled

---

## Phase 2: Pulse Migration

### T6: Add optional RelayCore dependency to SchedulerService

**Blocked by:** T3
**Files:**

- `apps/server/src/services/pulse/scheduler-service.ts` — Add relay dep, branch executeRun

**Changes:**

1. Add optional `relay` to constructor deps:

```typescript
export interface SchedulerServiceDeps {
  agentManager: SchedulerAgentManager;
  pulseStore: PulseStore;
  relay?: RelayCore | null; // ADD THIS
}

export class SchedulerService {
  private relay: RelayCore | null;

  constructor(private deps: SchedulerServiceDeps) {
    this.relay = deps.relay ?? null;
  }
}
```

2. Branch executeRun:

```typescript
private async executeRun(schedule: PulseSchedule, run: PulseRun): Promise<void> {
  if (isRelayEnabled() && this.relay) {
    await this.executeRunViaRelay(schedule, run);
  } else {
    await this.executeRunDirect(schedule, run);
  }
}
```

3. Extract current `executeRun` body into `executeRunDirect()` — no changes to existing logic.

**Acceptance Criteria:**

- [ ] SchedulerService accepts optional `relay` in deps
- [ ] executeRun branches on isRelayEnabled() && this.relay
- [ ] Existing executeRun logic preserved in executeRunDirect()
- [ ] When Relay disabled, behavior is identical to current
- [ ] Existing tests still pass

---

### T7: Implement executeRunViaRelay with PulseDispatchPayload

**Blocked by:** T6
**Files:**

- `apps/server/src/services/pulse/scheduler-service.ts` — Add executeRunViaRelay method
- `apps/server/src/services/pulse/__tests__/scheduler-service.test.ts` — Add Relay path tests

**Implementation:**

```typescript
private async executeRunViaRelay(schedule: PulseSchedule, run: PulseRun): Promise<void> {
  const envelope = {
    subject: `relay.system.pulse.${schedule.id}`,
    from: 'relay.system.pulse',
    replyTo: `relay.system.pulse.${schedule.id}.response`,
    budget: createDefaultBudget({ maxHops: 3, ttlMs: schedule.maxRuntime ?? 3_600_000 }),
    payload: {
      type: 'pulse_dispatch' as const,
      scheduleId: schedule.id,
      runId: run.id,
      prompt: schedule.prompt,
      cwd: schedule.cwd,
      permissionMode: schedule.permissionMode ?? 'acceptEdits',
      scheduleName: schedule.name,
      cron: schedule.cron,
      trigger: run.trigger,
    } satisfies PulseDispatchPayload,
  };

  const result = await this.relay!.publish(envelope.subject, envelope);

  if (result.deliveredCount === 0) {
    this.deps.pulseStore.updateRun(run.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: 'No Relay receiver for Pulse dispatch',
    });
  }
}
```

**Tests:**

- executeRunViaRelay publishes envelope with correct subject `relay.system.pulse.{scheduleId}`
- Envelope contains all PulseDispatchPayload fields
- When deliveredCount is 0, run is marked as failed
- Budget has maxHops: 3 and ttlMs from schedule.maxRuntime
- Default ttlMs is 3_600_000 when schedule.maxRuntime is undefined

**Acceptance Criteria:**

- [ ] Publishes to `relay.system.pulse.{scheduleId}` subject
- [ ] Envelope contains complete PulseDispatchPayload
- [ ] replyTo set to `relay.system.pulse.{scheduleId}.response`
- [ ] Budget created with maxHops: 3 and schedule.maxRuntime (or 1hr default)
- [ ] Failed delivery updates run status to 'failed'
- [ ] All tests pass

---

### T8: Implement MessageReceiver.handlePulseMessage with full run lifecycle

**Blocked by:** T7
**Files:**

- `apps/server/src/services/relay/message-receiver.ts` — Enhance handlePulseMessage
- `apps/server/src/services/relay/__tests__/message-receiver.test.ts` — Add Pulse lifecycle tests

**Implementation:**

Replace the stub handlePulseMessage from T3 with full implementation:

```typescript
private async handlePulseMessage(envelope: RelayEnvelope): Promise<void> {
  const parseResult = PulseDispatchPayloadSchema.safeParse(envelope.payload);
  if (!parseResult.success) {
    this.deps.traceStore.updateSpan(envelope.id, {
      status: 'dead_lettered',
      error: `Invalid PulseDispatchPayload: ${parseResult.error.message}`,
    });
    return;
  }
  const payload = parseResult.data;

  this.deps.traceStore.updateSpan(envelope.id, { status: 'processing', processedAt: Date.now() });
  this.deps.pulseStore?.updateRun(payload.runId, { status: 'running' });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), envelope.budget?.ttlMs ?? 3_600_000);

  try {
    const sessionId = crypto.randomUUID();
    await this.deps.agentManager.ensureSession(sessionId, {
      cwd: payload.cwd ?? undefined,
      permissionMode: payload.permissionMode,
    });

    const stream = this.deps.agentManager.sendMessage(sessionId, payload.prompt, {
      cwd: payload.cwd ?? undefined,
      permissionMode: payload.permissionMode,
    });

    let outputSummary = '';
    for await (const event of stream) {
      if (abortController.signal.aborted) break;

      if (event.type === 'text_delta') {
        outputSummary += event.data?.text ?? '';
      }

      if (envelope.replyTo) {
        await this.deps.relay.publish(envelope.replyTo, {
          from: envelope.subject,
          payload: event,
          budget: { ...envelope.budget, hopCount: (envelope.budget?.hopCount ?? 0) + 1 },
        });
      }
    }

    this.deps.pulseStore?.updateRun(payload.runId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      output: outputSummary.slice(0, 1000),
    });
    this.deps.traceStore.updateSpan(envelope.id, { status: 'delivered', deliveredAt: Date.now() });
  } catch (error) {
    this.deps.pulseStore?.updateRun(payload.runId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    this.deps.traceStore.updateSpan(envelope.id, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}
```

**Tests:**

- Valid PulseDispatchPayload updates run to 'running', then 'completed' on success
- Invalid payload results in dead_lettered trace
- AbortController timeout respects budget TTL
- Output summary collected from text_delta events, truncated to 1000 chars
- Error during execution updates both PulseStore and trace to 'failed'
- Response events published to replyTo with incremented hop count

**Acceptance Criteria:**

- [ ] Validates payload with PulseDispatchPayloadSchema.safeParse
- [ ] Rejects invalid payloads to dead letter queue
- [ ] Updates PulseStore run lifecycle: running -> completed/failed
- [ ] AbortController timeout from budget TTL
- [ ] Output summary collected from text_delta events
- [ ] Trace updated through lifecycle
- [ ] All tests pass

---

## Phase 3: Console Migration (Server)

### T9: Modify POST /messages handler with Relay 202 receipt path

**Blocked by:** T3
**Files:**

- `apps/server/src/routes/sessions.ts` — Branch on isRelayEnabled
- `apps/server/src/routes/__tests__/sessions.test.ts` — Add Relay path tests

**Implementation:**

```typescript
router.post('/:id/messages', async (req, res) => {
  // ... existing validation and lock acquisition ...

  if (isRelayEnabled() && relay) {
    // NEW PATH: Publish to Relay, return receipt
    const traceId = crypto.randomUUID();
    const clientId = req.headers['x-client-id'] as string;
    const consoleSubject = `relay.human.console.${clientId}`;

    relay.registerEndpoint(consoleSubject);

    const result = await relay.publish(`relay.agent.${sessionId}`, {
      from: consoleSubject,
      replyTo: consoleSubject,
      budget: createDefaultBudget({ maxHops: 5, ttlMs: 300_000 }),
      payload: {
        content,
        platformData: { cwd, sessionId, clientId, traceId },
      },
    });

    // Return receipt immediately (202 Accepted)
    res.status(202).json({
      messageId: result.messageId,
      traceId,
      deliveredCount: result.deliveredCount,
    });
  } else {
    // EXISTING PATH: Stream SSE response on this connection (unchanged)
    initSSEStream(res);
    try {
      for await (const event of agentManager.sendMessage(sessionId, content, { cwd })) {
        sendSSEEvent(res, event);
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

**Tests:**

- Relay enabled: POST returns 202 with { messageId, traceId, deliveredCount }
- Relay enabled: relay.publish called with correct subject and payload
- Relay enabled: Console endpoint registered via relay.registerEndpoint
- Relay disabled: POST returns SSE stream (existing behavior unchanged)
- Lock acquisition still works in Relay path

**Acceptance Criteria:**

- [ ] Returns 202 with receipt when Relay enabled
- [ ] Returns SSE stream when Relay disabled
- [ ] Receipt contains messageId, traceId, deliveredCount
- [ ] Console endpoint registered on publish
- [ ] Budget set to maxHops: 5, ttlMs: 300_000
- [ ] All tests pass (new and existing)

---

### T10: Extend SessionBroadcaster with Relay subscription fan-in

**Blocked by:** T9
**Files:**

- `apps/server/src/services/session/session-broadcaster.ts` — Add setRelay and fan-in

**Implementation:**

```typescript
export class SessionBroadcaster {
  private relay: RelayCore | null = null;

  /** Inject Relay for fan-in event streaming. */
  setRelay(relay: RelayCore): void {
    this.relay = relay;
  }

  registerClient(sessionId: string, vaultRoot: string, res: Response): void {
    // ... existing client registration and watcher setup ...

    const clientId =
      (req.headers?.['x-client-id'] as string) ?? (res.getHeader?.('x-client-id') as string);
    if (this.relay && clientId) {
      const consoleSubject = `relay.human.console.${clientId}`;
      this.relay.subscribe(consoleSubject, (envelope) => {
        const eventData = JSON.stringify(envelope.payload);
        res.write(`event: relay_message\ndata: ${eventData}\n\n`);
      });
    }
  }
}
```

**Acceptance Criteria:**

- [ ] setRelay stores RelayCore reference
- [ ] When Relay enabled and clientId present, subscribes to relay.human.console.{clientId}
- [ ] Relay events written as SSE `event: relay_message` with JSON payload
- [ ] When Relay disabled, no subscription created
- [ ] Subscription cleaned up when SSE connection closes

---

### T11: Add new SSE event types documentation and implementation

**Blocked by:** T10
**Files:**

- `packages/shared/src/schemas.ts` — Add relay SSE event type schemas
- `apps/server/src/services/session/session-broadcaster.ts` — Emit relay_receipt and message_delivered events

**New SSE event types on GET /api/sessions/:id/stream:**

| Event Type          | Data                             | When                             |
| ------------------- | -------------------------------- | -------------------------------- |
| `sync_connected`    | `{ sessionId }`                  | On initial connection (existing) |
| `sync_update`       | `{ sessionId, timestamp }`       | JSONL file change (existing)     |
| `relay_message`     | StreamEvent                      | Agent response chunk via Relay   |
| `relay_receipt`     | `{ messageId, traceId }`         | Message accepted by Relay        |
| `message_delivered` | `{ messageId, subject, status }` | Delivery confirmation            |

**Schema additions:**

```typescript
export const RelayReceiptEventSchema = z
  .object({
    messageId: z.string(),
    traceId: z.string(),
  })
  .openapi('RelayReceiptEvent');

export const MessageDeliveredEventSchema = z
  .object({
    messageId: z.string(),
    subject: z.string(),
    status: z.enum(['delivered', 'failed', 'dead_lettered']),
  })
  .openapi('MessageDeliveredEvent');
```

**SessionBroadcaster fan-in event type detection:**

```typescript
if (envelope.payload?.type === 'relay_receipt') {
  res.write(`event: relay_receipt\ndata: ${JSON.stringify(envelope.payload)}\n\n`);
} else if (envelope.payload?.type === 'message_delivered') {
  res.write(`event: message_delivered\ndata: ${JSON.stringify(envelope.payload)}\n\n`);
} else {
  res.write(`event: relay_message\ndata: ${JSON.stringify(envelope.payload)}\n\n`);
}
```

**Acceptance Criteria:**

- [ ] RelayReceiptEventSchema and MessageDeliveredEventSchema added to schemas.ts
- [ ] SSE stream emits relay_message, relay_receipt, message_delivered events
- [ ] Existing sync_connected and sync_update events unchanged

---

## Phase 4: Console Migration (Client)

### T12: Extend Transport interface with sendMessageRelay

**Blocked by:** T10
**Files:**

- `packages/shared/src/transport.ts` — Add sendMessageRelay, getRelayTrace, getRelayDeliveryMetrics
- `apps/client/src/layers/shared/lib/transports/http-transport.ts` — Implement
- `apps/client/src/layers/shared/lib/transports/direct-transport.ts` — Stub
- `packages/test-utils/src/mock-transport.ts` — Add mocks

**Transport interface additions:**

```typescript
sendMessageRelay(
  sessionId: string,
  content: string,
  opts?: { cwd?: string }
): Promise<{ messageId: string; traceId: string; deliveredCount: number }>;

getRelayTrace(messageId: string): Promise<{ traceId: string; spans: TraceSpan[] }>;

getRelayDeliveryMetrics(): Promise<DeliveryMetrics>;
```

**HttpTransport implementation:**

```typescript
async sendMessageRelay(
  sessionId: string,
  content: string,
  opts?: { cwd?: string }
): Promise<{ messageId: string; traceId: string; deliveredCount: number }> {
  const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': this.clientId,
    },
    body: JSON.stringify({ content, cwd: opts?.cwd }),
  });
  if (!response.ok) throw new Error(`Failed to send message: ${response.statusText}`);
  return response.json();
}

async getRelayTrace(messageId: string): Promise<{ traceId: string; spans: TraceSpan[] }> {
  const response = await fetch(`${this.baseUrl}/api/relay/messages/${messageId}/trace`);
  if (!response.ok) throw new Error(`Failed to get trace: ${response.statusText}`);
  return response.json();
}

async getRelayDeliveryMetrics(): Promise<DeliveryMetrics> {
  const response = await fetch(`${this.baseUrl}/api/relay/metrics`);
  if (!response.ok) throw new Error(`Failed to get metrics: ${response.statusText}`);
  return response.json();
}
```

**DirectTransport stubs:**

```typescript
async sendMessageRelay(): Promise<never> {
  throw new Error('sendMessageRelay is not supported in DirectTransport');
}
async getRelayTrace(): Promise<never> {
  throw new Error('getRelayTrace is not supported in DirectTransport');
}
async getRelayDeliveryMetrics(): Promise<never> {
  throw new Error('getRelayDeliveryMetrics is not supported in DirectTransport');
}
```

**Mock transport:**

```typescript
sendMessageRelay: vi.fn().mockResolvedValue({
  messageId: 'mock-message-id',
  traceId: 'mock-trace-id',
  deliveredCount: 1,
}),
getRelayTrace: vi.fn().mockResolvedValue({
  traceId: 'mock-trace-id',
  spans: [],
}),
getRelayDeliveryMetrics: vi.fn().mockResolvedValue({
  totalMessages: 0, deliveredCount: 0, failedCount: 0, deadLetteredCount: 0,
  avgDeliveryLatencyMs: null, p95DeliveryLatencyMs: null, activeEndpoints: 0,
  budgetRejections: { hopLimit: 0, ttlExpired: 0, cycleDetected: 0, budgetExhausted: 0 },
}),
```

**Acceptance Criteria:**

- [ ] Transport interface has sendMessageRelay, getRelayTrace, getRelayDeliveryMetrics
- [ ] HttpTransport implements all three methods
- [ ] DirectTransport throws for all three methods
- [ ] Mock transport has mocks for all three methods
- [ ] npm run typecheck passes

---

### T13: Update use-chat-session to handle receipt+SSE protocol

**Blocked by:** T12
**Files:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Protocol branching

**Implementation:**

In handleSubmit, branch on relayEnabled:

```typescript
if (relayEnabled) {
  setIsStreaming(true);
  try {
    const receipt = await transport.sendMessageRelay(sessionId, content, { cwd });
    setCurrentTraceId(receipt.traceId);
    // Response events arrive on the existing EventSource via relay_message events
  } catch (error) {
    setIsStreaming(false);
    // Handle error
  }
} else {
  // Existing protocol: SSE stream on POST response
  await transport.sendMessage(sessionId, content, onEvent, signal, cwd);
}
```

Add EventSource listeners for relay events:

```typescript
eventSource.addEventListener('relay_message', (e) => {
  const event = JSON.parse(e.data) as StreamEvent;
  handleStreamEvent(event); // Same handler as the legacy SSE stream
});

eventSource.addEventListener('relay_receipt', (e) => {
  const receipt = JSON.parse(e.data);
  // Store receipt info
});

eventSource.addEventListener('message_delivered', (e) => {
  const delivered = JSON.parse(e.data);
  // Update delivery status
});
```

Key: `handleStreamEvent()` / `createStreamEventHandler()` is reused for both protocols. Same event processing, different transport.

**Acceptance Criteria:**

- [ ] handleSubmit branches on relayEnabled
- [ ] Relay path: POST returns JSON receipt (not SSE)
- [ ] Relay path: response events arrive via EventSource relay_message events
- [ ] Legacy path: unchanged SSE stream on POST response
- [ ] Both paths produce identical UI behavior
- [ ] handleStreamEvent() shared between both protocols
- [ ] Streaming state correctly managed in Relay path

---

### T14: Client tests for both chat protocols

**Blocked by:** T13
**Files:**

- `apps/client/src/layers/features/chat/model/__tests__/use-chat-session.test.ts` — Add Relay protocol tests

**Tests to add:**

```typescript
describe('use-chat-session Relay protocol', () => {
  it('sends via sendMessageRelay when relay enabled', async () => {
    // Mock useRelayEnabled to return true, trigger handleSubmit
    // Assert: transport.sendMessageRelay called, not transport.sendMessage
  });

  it('handles 202 receipt response', async () => {
    // Mock sendMessageRelay to return receipt
    // Assert: no error, isStreaming is true
  });

  it('processes relay_message events from EventSource', async () => {
    // Fire text_delta event via relay_message EventSource event
    // Assert: assistant message text updated
  });

  it('produces identical UI state as legacy protocol', async () => {
    // Same message content via both protocols
    // Assert: final message state is identical
  });

  it('falls back to legacy protocol when relay disabled', async () => {
    // Mock useRelayEnabled to return false
    // Assert: transport.sendMessage called
  });

  it('handles sendMessageRelay error', async () => {
    // Mock sendMessageRelay to reject
    // Assert: isStreaming false, error handled
  });
});
```

**Acceptance Criteria:**

- [ ] Tests verify sendMessageRelay called when relay enabled
- [ ] Tests verify sendMessage called when relay disabled
- [ ] Tests verify relay_message events processed correctly
- [ ] Tests verify identical UI state from both protocols
- [ ] Tests verify error handling in Relay path
- [ ] All existing tests still pass

---

## Phase 5: Trace UI

### T15: Create useMessageTrace and useDeliveryMetrics entity hooks

**Blocked by:** T4, T12
**Files:**

- `apps/client/src/layers/entities/relay/model/use-message-trace.ts` — New hook
- `apps/client/src/layers/entities/relay/model/use-delivery-metrics.ts` — New hook
- `apps/client/src/layers/entities/relay/index.ts` — Update barrel exports

**useMessageTrace:**

```typescript
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

**useDeliveryMetrics:**

```typescript
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

**Update barrel (apps/client/src/layers/entities/relay/index.ts):**

```typescript
export { useMessageTrace } from './model/use-message-trace';
export { useDeliveryMetrics } from './model/use-delivery-metrics';
```

**Acceptance Criteria:**

- [ ] useMessageTrace disabled when messageId is null, enabled otherwise
- [ ] useMessageTrace has 30s staleTime
- [ ] useDeliveryMetrics has 30s staleTime and 30s refetchInterval
- [ ] Both hooks use Transport interface for data fetching
- [ ] Hooks exported from entities/relay barrel

---

### T16: Build MessageTrace timeline component

**Blocked by:** T15
**Files:**

- `apps/client/src/layers/features/relay/ui/MessageTrace.tsx` — New component
- `apps/client/src/layers/features/relay/ui/__tests__/MessageTrace.test.tsx` — Tests
- `apps/client/src/layers/features/relay/index.ts` — Update barrel

**Component:**

Vertical timeline showing delivery path of a message. Status dots colored by state (green=delivered, red=failed, yellow=pending, gray=dead_lettered). Shows latency deltas between spans, budget consumption at each hop, error messages for failed spans.

```tsx
import { useMessageTrace } from '@/layers/entities/relay';
import type { TraceSpan } from '@dorkos/shared/relay-schemas';

interface MessageTraceProps {
  messageId: string;
  onClose: () => void;
}

const statusColors: Record<string, string> = {
  pending: 'text-yellow-500',
  delivered: 'text-green-500',
  processed: 'text-green-500',
  failed: 'text-red-500',
  dead_lettered: 'text-neutral-400',
};

const statusIcons: Record<string, string> = {
  pending: '○',
  delivered: '●',
  processed: '●',
  failed: '✗',
  dead_lettered: '◌',
};

export function MessageTrace({ messageId, onClose }: MessageTraceProps) {
  const { data, isLoading, error } = useMessageTrace(messageId);

  if (isLoading) return <div className="p-4 text-sm text-neutral-500">Loading trace...</div>;
  if (error) return <div className="p-4 text-sm text-red-500">Failed to load trace</div>;
  if (!data) return null;

  const { traceId, spans } = data;

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium">Message Trace: {traceId.slice(0, 8)}</h3>
        <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600">
          x
        </button>
      </div>
      <div className="space-y-0">
        {spans.map((span, i) => (
          <TraceSpanRow
            key={span.spanId}
            span={span}
            prevSpan={spans[i - 1]}
            isLast={i === spans.length - 1}
          />
        ))}
      </div>
      {spans.length > 0 && (
        <div className="mt-2 border-t pt-2 text-xs text-neutral-500">
          Total:{' '}
          {formatDuration(
            spans[spans.length - 1].deliveredAt ??
              spans[spans.length - 1].processedAt ??
              Date.now(),
            spans[0].sentAt
          )}
        </div>
      )}
    </div>
  );
}

function TraceSpanRow({
  span,
  prevSpan,
  isLast,
}: {
  span: TraceSpan;
  prevSpan?: TraceSpan;
  isLast: boolean;
}) {
  const delta = prevSpan ? formatDelta(span.sentAt, prevSpan.sentAt) : formatTimestamp(span.sentAt);
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className={statusColors[span.status]}>{statusIcons[span.status]}</span>
        {!isLast && <div className="w-px flex-1 bg-neutral-200 dark:bg-neutral-700" />}
      </div>
      <div className="pb-4">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium capitalize">{span.status}</span>
          <span className="text-xs text-neutral-500">{delta}</span>
        </div>
        <div className="text-xs text-neutral-500">
          {span.fromEndpoint} &rarr; {span.toEndpoint}
        </div>
        {span.budgetHopsUsed != null && (
          <div className="text-xs text-neutral-400">
            Hops: {span.budgetHopsUsed}, TTL remaining: {span.budgetTtlRemainingMs}ms
          </div>
        )}
        {span.error && <div className="text-xs text-red-500">{span.error}</div>}
      </div>
    </div>
  );
}

function formatDelta(ts: number, prevTs: number): string {
  const ms = ts - prevTs;
  return ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().split('T')[1].slice(0, 12);
}

function formatDuration(end: number, start: number): string {
  const ms = end - start;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
```

**Tests:**

- Renders trace spans with correct status colors
- Shows latency deltas between spans
- Shows error messages for failed spans
- Shows loading and error states
- Shows budget consumption info
- Handles empty spans array

**Acceptance Criteria:**

- [ ] Vertical timeline with colored status dots
- [ ] Latency deltas between spans
- [ ] Budget consumption shown at each hop
- [ ] Error messages for failed/dead_lettered spans
- [ ] Loading and error states handled
- [ ] Close button works
- [ ] All tests pass

---

### T17: Build DeliveryMetrics dashboard component

**Blocked by:** T15
**Files:**

- `apps/client/src/layers/features/relay/ui/DeliveryMetrics.tsx` — New component
- `apps/client/src/layers/features/relay/ui/__tests__/DeliveryMetrics.test.tsx` — Tests
- `apps/client/src/layers/features/relay/index.ts` — Update barrel

**Component:**

Compact metrics dashboard: DLQ depth (warning badge when > 0), delivery latency (avg/p95), message counts (delivered/failed), budget rejection breakdown, active endpoint count.

```tsx
import { useDeliveryMetrics } from '@/layers/entities/relay';
import { Badge } from '@/layers/shared/ui';

export function DeliveryMetrics() {
  const { data: metrics, isLoading, error } = useDeliveryMetrics();

  if (isLoading) return <div className="p-4 text-sm text-neutral-500">Loading metrics...</div>;
  if (error) return <div className="p-4 text-sm text-red-500">Failed to load metrics</div>;
  if (!metrics) return null;

  const totalRejections =
    metrics.budgetRejections.hopLimit +
    metrics.budgetRejections.ttlExpired +
    metrics.budgetRejections.cycleDetected +
    metrics.budgetRejections.budgetExhausted;

  return (
    <div className="space-y-4 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <h3 className="text-sm font-medium">Delivery Metrics</h3>
      <div className="grid grid-cols-2 gap-4">
        <MetricCard label="Total Messages" value={metrics.totalMessages} />
        <MetricCard label="Delivered" value={metrics.deliveredCount} />
        <MetricCard
          label="Failed"
          value={metrics.failedCount}
          variant={metrics.failedCount > 0 ? 'warning' : 'default'}
        />
        <MetricCard
          label="Dead Lettered"
          value={metrics.deadLetteredCount}
          variant={metrics.deadLetteredCount > 0 ? 'destructive' : 'default'}
          badge={metrics.deadLetteredCount > 0}
        />
        <MetricCard
          label="Avg Latency"
          value={
            metrics.avgDeliveryLatencyMs != null
              ? `${metrics.avgDeliveryLatencyMs.toFixed(1)}ms`
              : 'N/A'
          }
        />
        <MetricCard
          label="P95 Latency"
          value={
            metrics.p95DeliveryLatencyMs != null
              ? `${metrics.p95DeliveryLatencyMs.toFixed(1)}ms`
              : 'N/A'
          }
        />
        <MetricCard label="Active Endpoints" value={metrics.activeEndpoints} />
      </div>
      {totalRejections > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-neutral-500">Budget Rejections</h4>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {metrics.budgetRejections.hopLimit > 0 && (
              <span>Hop limit: {metrics.budgetRejections.hopLimit}</span>
            )}
            {metrics.budgetRejections.ttlExpired > 0 && (
              <span>TTL expired: {metrics.budgetRejections.ttlExpired}</span>
            )}
            {metrics.budgetRejections.cycleDetected > 0 && (
              <span>Cycle detected: {metrics.budgetRejections.cycleDetected}</span>
            )}
            {metrics.budgetRejections.budgetExhausted > 0 && (
              <span>Exhausted: {metrics.budgetRejections.budgetExhausted}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  variant = 'default',
  badge = false,
}: {
  label: string;
  value: string | number;
  variant?: 'default' | 'warning' | 'destructive';
  badge?: boolean;
}) {
  const colorClass =
    variant === 'destructive'
      ? 'text-red-500'
      : variant === 'warning'
        ? 'text-yellow-500'
        : 'text-neutral-900 dark:text-neutral-100';
  return (
    <div className="space-y-1">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`text-lg font-semibold ${colorClass}`}>
        {value}
        {badge && (
          <Badge variant="destructive" className="ml-2 text-xs">
            !
          </Badge>
        )}
      </div>
    </div>
  );
}
```

**Tests:**

- Renders all metric values
- DLQ warning badge when deadLetteredCount > 0
- Budget rejections section hidden when all zero
- Budget rejections shown when non-zero
- Loading and error states

**Acceptance Criteria:**

- [ ] Shows all metric values
- [ ] DLQ warning badge when depth > 0
- [ ] Latency display (avg/p95)
- [ ] Budget rejection breakdown when non-zero
- [ ] Loading and error states
- [ ] 30s auto-refresh via useDeliveryMetrics
- [ ] All tests pass

---

## Phase 6: Documentation & Cleanup

### T18: Update CLAUDE.md and contributing guides

**Blocked by:** T8, T11, T14, T16, T17
**Files:**

- `CLAUDE.md` — Update services list, session architecture, SSE protocol
- `contributing/architecture.md` — Add converged data flow diagram, receipt+SSE protocol
- `contributing/api-reference.md` — Document new endpoints and SSE events
- `contributing/data-fetching.md` — Add useMessageTrace, useDeliveryMetrics patterns

**CLAUDE.md changes:**

1. Add to services list (update count from twenty-three to twenty-five):

```
- **`services/relay/message-receiver.ts`** - Bridges Relay subscriptions to AgentManager. Subscribes to `relay.agent.>` (Console chat, inter-agent) and `relay.system.pulse.>` (Pulse dispatch). Translates Relay message arrival into `agentManager.sendMessage()` calls. Publishes response chunks back to sender via replyTo subject. Validates PulseDispatchPayload. Updates trace spans through lifecycle.
- **`services/relay/trace-store.ts`** - SQLite trace storage in `~/.dork/relay/index.db`. Records message delivery spans (pending -> delivered -> processed -> failed). Provides trace queries (by messageId, traceId) and aggregate delivery metrics (counts, latency percentiles, budget rejections). Used by MessageReceiver, relay routes, and MCP tools.
```

2. Update Session Architecture section:

```
When `DORKOS_RELAY_ENABLED=true`, Console chat messages flow through Relay: POST /messages returns a 202 receipt, and response events arrive via the SSE stream (session sync). Pulse dispatches also flow through Relay via `relay.system.pulse.{scheduleId}` subjects. When Relay is disabled, both paths use their original direct-call implementations.
```

3. Update SSE Streaming Protocol section:

```
Additional event types when Relay is enabled: `relay_message` (agent response chunk via Relay), `relay_receipt` (message accepted by Relay), `message_delivered` (delivery confirmation).
```

4. Update SchedulerService description to mention optional Relay path.

5. Update MCP tool server description to include relay_get_trace and relay_get_metrics.

6. Update relay routes description to include trace and metrics endpoints.

**contributing/architecture.md:** Add converged data flow diagram from spec, document receipt+SSE protocol, document MessageReceiver service role.

**contributing/api-reference.md:** Document POST /messages 202 response (when Relay enabled), GET /api/relay/messages/:id/trace, GET /api/relay/metrics, new SSE event types.

**contributing/data-fetching.md:** Add useMessageTrace and useDeliveryMetrics hook patterns.

**Acceptance Criteria:**

- [ ] CLAUDE.md services list updated
- [ ] CLAUDE.md Session Architecture describes Relay convergence
- [ ] CLAUDE.md SSE protocol lists new event types
- [ ] contributing/architecture.md has converged data flow diagram
- [ ] contributing/api-reference.md documents new endpoints
- [ ] contributing/data-fetching.md documents new hooks
