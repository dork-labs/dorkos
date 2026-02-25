---
title: Relay Design
description: Design working document for DorkOS Relay — the universal message bus.
---

# DorkOS Relay — Design Working Document

**Date:** 2026-02-24
**Status:** In Progress — Brainstorming Phase
**Author:** Dorian Collier + Claude

---

## Overview

Relay is the universal message bus for DorkOS. It handles inboxes, outboxes, and message delivery for ALL endpoints — agent-to-agent, human-to-agent (Telegram, email, webhooks), and scheduled dispatches from Pulse.

**Core mental model:** Relay is kernel IPC. It doesn't know what agents are or what schedules exist. It just moves messages between endpoints reliably.

**OS Analog:** D-Bus / Mach ports — the kernel messaging layer that every higher-level service builds on.

---

## Role in the Module Architecture

| Module | Depends On | Provides |
|---|---|---|
| **Relay** | Nothing (foundation) | Message transport, delivery, inboxes/outboxes |
| **Mesh** | Relay | Agent discovery, topology, configures Relay routing for agents |
| **Pulse** | Relay | Scheduled dispatch of messages via Relay |

Relay is intentionally "dumb" about the higher-level concepts. It knows about endpoints and messages, not about agents, schedules, or projects.

---

## Inherited Decisions (from Mesh brainstorming)

### Transport: Hybrid Maildir + SQLite Index

- **Maildir** for message storage (source of truth)
- **SQLite** for indexing and queries (derived, rebuildable)
- Files are endpoint-native: consumers can `ls`, `cat`, `Glob`, `Read` their mailbox
- SQLite provides fast structured queries for rate limiting, budget tracking, history
- If index corrupts, rebuild from files (single source of truth principle)
- Aligns with DorkOS's existing pattern: JSONL files as truth, programmatic reading on top

### Safety: Budget Envelopes

Budget envelope propagated with every message (can only decrease):
```typescript
interface RelayBudget {
  hopCount: number;        // incremented at each hop
  maxHops: number;         // default: 5, cannot increase
  ancestorChain: string[]; // endpoint IDs that touched this message
  ttl: number;             // Unix timestamp expiry
  callBudgetRemaining: number; // decremented per call
  deadline: number;        // wall-clock deadline
}
```

---

## Decisions Made

### 1. Endpoint Model: Hierarchical Subjects (NATS-style)

Endpoints are dot-separated hierarchical paths with wildcard subscriptions:

```
# Subject structure:
relay.agent.{project}.{agent-id}
relay.human.{channel}.{user-id}
relay.system.{service}.{instance}

# Point-to-point:
send("relay.agent.myproject.backend", msg)

# Pub/sub via wildcards:
subscribe("relay.agent.myproject.*")   # all agents in project
subscribe("relay.human.telegram.>")    # all telegram users
subscribe("relay.agent.*.*.error")     # all agent errors
```

- `*` matches exactly one token, `>` matches rest of path (NATS convention)
- Enables both point-to-point and pub/sub in one model
- Subject matching is ~30 lines (no external dependency needed)
- Subscription registry is ~50 lines
- Subject taxonomy is convention, not enforced by Relay code
- Existing precedent: NATS (cloud-native standard), MQTT (IoT standard), D-Bus (Linux desktop)

**Library research:** No single library combines topic routing + persistence + embedding. NATS requires an external Go server. The routing primitives (subject matching, subscription fan-out) are small enough to implement inline (~80 lines). Persistence reuses existing `better-sqlite3` and Maildir patterns. Full Relay transport is estimated at 200-300 lines.

---

### 2. Message Envelope: Thin Envelope (routing + safety only)

Relay understands only routing and safety. Everything else is opaque payload that higher-level modules interpret.

```typescript
interface RelayEnvelope {
  id: string;              // unique message ID (ULID or UUID)
  subject: string;         // hierarchical destination
  from: string;            // sender subject
  replyTo?: string;        // where to send responses
  budget: RelayBudget;     // safety envelope (enforced by Relay)
  createdAt: string;       // ISO timestamp
  payload: unknown;        // opaque to Relay
}
```

- Relay enforces `budget` (hop count, TTL, deadline) and rejects messages that exceed limits
- Relay does NOT interpret `payload` — but all DorkOS components use the `StandardPayload` schema (see below)
- This keeps Relay maximally reusable — same transport for agent↔agent, human↔agent, system events
- Envelope is defined as a Zod schema in `@dorkos/shared` for runtime validation

**StandardPayload — shared content schema (in `@dorkos/shared`, not enforced by Relay):**

All adapters and modules normalize their content into this schema to prevent "lost in translation" between platforms:

```typescript
interface StandardPayload {
  // Content (required):
  content: string;                    // the actual message text

  // Sender context:
  senderName?: string;                // human-readable: "Bob Smith", "Finance Agent"
  senderAvatar?: string;              // URL or local path

  // Channel context:
  channelName?: string;               // "Deploys", "birthday-planning"
  channelType?: 'dm' | 'group' | 'channel' | 'thread';

  // Attachments (standardized):
  attachments?: Array<{
    path: string;                     // local file path
    filename: string;
    mimeType: string;
    size?: number;
  }>;

  // Response instructions (adapter-injected):
  responseContext?: {
    platform: string;                 // 'telegram', 'slack', 'console'
    maxLength?: number;               // platform message limit
    supportedFormats?: string[];      // ['text', 'markdown', 'html']
    instructions?: string;            // platform-specific guidance for the agent
  };

  // Agent-to-agent fields (Mesh layer):
  performative?: Performative;        // 'request', 'inform', 'query', etc.
  conversationId?: string;
  correlationId?: string;

  // Escape hatch:
  platformData?: unknown;             // adapter-specific data (Telegram message_id, Slack thread_ts, etc.)
}
```

Relay passes `payload` through without inspecting it. But all DorkOS components validate payloads against `StandardPayload` via Zod. This gives standardization without making Relay opinionated.

### 3. Dual Communication Modes: Messages + Signals

Relay supports two modes of communication:

**Messages** — persistent, store-and-forward via Maildir + SQLite. For actual content.

**Signals** — ephemeral, in-memory only via EventEmitter. For real-time state. Never touch disk.

```typescript
// Messages (persistent):
relay.publish('relay.agent.myproject.backend', envelope)   // → Maildir + SQLite

// Signals (ephemeral):
relay.signal('relay.human.telegram.dorian', {
  type: 'typing',         // or 'presence', 'read_receipt', 'progress'
  state: 'active'
})                         // → EventEmitter only, zero storage
```

Both modes use the same subject hierarchy and wildcard matching. Signals enable:
- **Typing indicators** (Telegram, iMessage, Slack)
- **Read receipts** ("I've seen your message")
- **Delivery receipts** (auto-emitted by Relay on successful delivery)
- **Presence** (online/offline/busy)
- **Progress updates** ("50% complete")

Adapters translate between Relay signals and platform-native presence APIs. Implementation: ~30-40 lines on top of the existing subject matching logic.

---

### 4. Agent Execution: Engine Orchestrates via Agent SDK

When a message arrives at an agent endpoint, **DorkOS Engine (AgentManager) handles execution**. No adapter needed for Claude Code — the Engine IS the agent runtime.

**Flow:**
1. Message arrives at `relay.agent.myproject.backend`
2. Relay delivers to endpoint's mailbox
3. Engine subscribes to `relay.agent.>` (all agent messages)
4. Engine creates Agent SDK session: `query({ prompt: message.payload, cwd: projectDir })`
5. Agent runs with full Claude Code capabilities in the project directory
6. Agent produces response → Engine publishes reply back to Relay

**Claude Code:** TypeScript Agent SDK (already integrated in `agent-manager.ts`). Not the CLI — SDK gives programmatic control, streaming, tool approval.

**Other agent runtimes** (Codex, OpenCode, Cursor, etc.): Future agent runtime adapters that implement a simple interface:
```typescript
interface AgentRuntimeAdapter {
  id: string;                                       // 'codex', 'opencode'
  canHandle(manifest: AgentManifest): boolean;       // check agent type
  execute(cwd: string, prompt: string, budget: RelayBudget): AsyncIterable<string>;
}
```
Mesh would select the runtime based on the agent's manifest (`runtime: 'codex'`). Phase 1 is Claude Code only.

---

## Other Decisions Made

### 5. Directory Structure: Flat Mailboxes + Subject-Keyed Index

```
~/.dork/relay/
  mailboxes/
    {endpoint-hash}/          # one per registered endpoint
      tmp/                    # in-flight writes (not yet delivered)
      new/                    # delivered, unclaimed
      cur/                    # being processed
      failed/                 # dead letter queue
  subscriptions.json          # subject pattern → endpoint mapping (config)
  index.db                    # SQLite: messages, routing, metrics (derived)
```

- Subject hierarchy lives in the SQLite index, NOT mirrored on the filesystem
- Subject → mailbox resolution: `"relay.agent.myproject.backend"` → index lookup → mailbox ID `"a1b2c3"` → `mailboxes/a1b2c3/new/`
- Each endpoint gets its own Maildir, so agents can `ls`/`Read` their own inbox
- `subscriptions.json` is the config source of truth for who subscribes to what patterns
- `index.db` is derived and rebuildable from scanning all mailbox files

### 4. External Channel Adapters: Plugin Interface

Each external channel is a plugin implementing a simple `RelayAdapter` interface:

```typescript
interface RelayAdapter {
  id: string;                    // e.g. 'telegram'
  subjectPrefix: string;         // e.g. 'relay.human.telegram'

  // Lifecycle:
  start(relay: RelayCore): Promise<void>;  // begin listening for external messages
  stop(): Promise<void>;

  // Relay → External delivery:
  deliver(subject: string, msg: RelayEnvelope): Promise<void>;
}
```

- Adapters translate between external protocols (Telegram API, webhooks, SMTP) and Relay subjects
- Adapter config: `~/.dork/relay/adapters.json` (token, enabled flag, channel-specific settings)
- Loaded at startup, hot-reloadable via config watch
- Adapters call `relay.publish(subject, envelope)` to inject external messages into the subject hierarchy
- Relay calls `adapter.deliver()` when a message targets the adapter's `subjectPrefix`
- Phase 1 ships with no adapters (internal only). Telegram + webhook adapters in Phase 3.

### 5. Delivery Guarantees: At-Most-Once

Relay delivers once and does not retry. Failed deliveries go to the dead letter queue. Consumers handle retries.

**Send flow:**
1. Write message JSON to `tmp/{ulid}` (fail → return error to sender)
2. `rename(tmp/{id}, new/{id})` — atomic POSIX delivery (fail → dead letter + error)
3. Insert index row in SQLite
4. Done. No automatic retries.

**Consumer crash recovery:**
- Message stays in `cur/` until consumer restarts
- Consumer resumes processing from `cur/` on restart
- No automatic re-delivery by Relay

**Dead letter queue (`failed/`) receives:**
- Messages with expired TTL
- Messages exceeding budget limits
- Messages that fail the delivery write
- Messages explicitly rejected by consumers

**Message ordering:** Per-endpoint FIFO (messages within a single mailbox are ordered by ULID/timestamp). No global ordering guarantee across endpoints.

### 6. Access Control: Default-Allow, Configurable Deny

Relay ships with default-allow (any registered endpoint can message any other). Higher-level modules (Mesh) layer restrictions via pattern-based rules.

```typescript
interface RelayAccessRule {
  from: string;     // subject pattern (supports wildcards)
  to: string;       // subject pattern (supports wildcards)
  action: 'allow' | 'deny';
  priority: number; // higher priority = evaluated first
}
```

- Rules stored in `~/.dork/relay/access-rules.json`, hot-reloaded via chokidar
- Evaluation: highest priority first, first match wins, default-allow if no match
- Mesh configures cross-project deny rules (e.g., `relay.agent.projectA.*` → `relay.agent.projectB.*` = deny)
- Matches D-Bus session bus model: everything on the same bus can communicate unless restricted
- Budget envelope enforcement is separate and always active (TTL, hop count, etc.)

### 7. Observability: SQLite Queries + SSE Stream

Reuses existing DorkOS patterns — SQLite for historical queries, SSE for real-time events.

**Metrics** (aggregate queries on `index.db`):
- Message counts by status (delivered, failed, pending)
- Volume by subject pattern
- Dead letter queue depth
- Budget rejection counts

**Real-time stream** (SSE, same pattern as session sync):
```
GET /api/relay/events
  → event: message_delivered  { subject, from, id }
  → event: message_failed     { subject, from, error }
  → event: budget_exceeded    { subject, from, budget }
  → event: endpoint_registered { subject }
```

**Message tracing:**
```
GET /api/relay/messages?from=relay.agent.myproject.*
GET /api/relay/messages/:id/trace
```

---

## Research Applicable from Mesh

The four research reports in `research/mesh/` contain directly applicable material:

1. **`communication-protocols.md`** — FIPA ACL performatives, message envelope patterns, Maildir mechanics, loop prevention
2. **`architecture-analogies.md`** — D-Bus, Mach ports, NATS subject hierarchy, service mesh patterns
3. **`access-control-coordination.md`** — Budget envelopes, circuit breakers, rate limiting, capability-based access
4. **`discovery-patterns.md`** — Less directly applicable (more Mesh-relevant), but chokidar watching pattern applies to mailbox monitoring

---

## Pulse Migration Path

Pulse currently dispatches directly to AgentManager. With Relay, Pulse publishes messages instead:

```typescript
// Today: scheduler-service.ts
this.agentManager.createSession(schedule.cwd, prompt, ...)

// With Relay:
relay.publish(schedule.targetSubject, {
  from: 'relay.system.pulse',
  budget: { maxHops: 5, ttl: oneHourFromNow, ... },
  payload: { scheduleId: schedule.id, prompt: schedule.prompt }
})
```

**Gradual migration:** Phase 1 Pulse keeps calling AgentManager directly. Phase 2 routes through Relay. Same behavior, but gains audit trail and dead-letter handling.

---

## Budget Enforcement Explained

The "budget" is a safety mechanism preventing agent communication loops and runaway resource consumption.

**The problem:** Agent A → Agent B → Agent C → Agent A → ... infinite loop. Each hop is an LLM call costing money and time.

**The solution:** Every message carries a budget envelope that can only shrink, never grow:

```
1. Scheduling agent sends: { hopCount: 0, maxHops: 5, callBudgetRemaining: 10, ttl: +1hr }
2. Finance agent receives: { hopCount: 1, callBudgetRemaining: 9 } → approves, forwards
3. Purchasing agent receives: { hopCount: 2, callBudgetRemaining: 8 } → orders flowers, replies
4. If purchasing accidentally re-messages scheduling → ancestorChain cycle detected → REJECTED
5. If buggy A→B→A→B loop → hopCount hits maxHops → REJECTED → dead letter queue
6. If chain runs too long → ttl expired → REJECTED → dead letter queue
```

Relay enforces automatically before every delivery:
- `hopCount < maxHops`? No → reject
- Sender already in `ancestorChain`? Yes → cycle, reject
- `Date.now() > ttl`? Yes → expired, reject
- `callBudgetRemaining > 0`? No → exhausted, reject

---

## Group Messages & Channels

**External groups** (Telegram groups, Slack channels, Discord channels): Handled entirely by adapters. Each external group maps to a single Relay subject. The adapter handles group membership natively.

```
Telegram group "birthday-planning" → relay.human.telegram.group.birthday-planning
Slack channel #deploys             → relay.human.slack.channel.deploys
```

**Internal groups** (agent broadcast, coordination channels): Native Relay pub/sub via wildcards. No adapter needed.

```
relay.agent.billing.*              # all agents in the billing project
relay.channel.deploy-notifications # explicit channel, any subscriber
```

**Multi-agent conversations:** Tracked via `conversationId` in Mesh payload. Each agent sends to others' subjects, all sharing the same conversation ID. Mesh handles coordination; Relay just delivers.

---

## File Attachments & Message Editing

Both are **payload conventions**, not Relay features. Relay delivers envelopes; content semantics belong to Mesh or adapters.

**Attachments:** Reference files by path (local-only system, no need to embed binary):
```typescript
payload: { content: "Here's the report", attachments: [{ path: '/path/to/report.pdf', mimeType: 'application/pdf' }] }
```

**Editing:** New message with `replaces` field:
```typescript
payload: { replaces: 'msg-001', content: "Deploy succeeded — 3 warnings" }
```

Adapters translate these to platform APIs (Telegram `editMessageText`, Slack `chat.update`, etc.).

---

## Package Architecture Decision

**Decision: Separate npm packages, composed by server (Option B)**

```
packages/
  relay/             # @dorkos/relay — RelayCore, Maildir, SQLite, subject matching
  mesh/              # @dorkos/mesh — MeshRegistry, discovery, manifests
  pulse/             # @dorkos/pulse — SchedulerService, PulseStore, cron engine (extract from apps/server)
  shared/            # @dorkos/shared — Zod schemas, types (already exists)
apps/
  server/            # Express routes, composes packages, HTTP layer
```

**Composition:**
```typescript
import { RelayCore } from '@dorkos/relay'
import { MeshRegistry } from '@dorkos/mesh'
import { SchedulerService } from '@dorkos/pulse'

const relay = new RelayCore({ dataDir: '~/.dork/relay' })
const mesh = new MeshRegistry({ relay })
const scheduler = new SchedulerService({ relay })
```

**Why:** Clean module boundaries, independently testable, composable (Obsidian plugin, CLI, future integrations can import directly). Follows existing monorepo pattern (`packages/shared`, `packages/cli`).

**Migration:** Build `@dorkos/relay` as a new package from day one. Extract Pulse to `@dorkos/pulse` when convenient. Mesh goes into `@dorkos/mesh`. Server becomes a thin composition + HTTP routing layer.

---

## Console Activity Feed (via Relay SSE)

The marketing site's `ACTIVITY_POOL` in `ActivityFeedHero.tsx` is a simulated version of what Relay enables for real. The Console can subscribe to Relay's SSE stream and display a live activity feed:

```typescript
// Console subscribes:
const events = new EventSource('/api/relay/events')
events.onmessage = (e) => {
  const event = JSON.parse(e.data)
  addToFeed({
    module: extractModule(event.subject),  // 'agent', 'pulse', 'relay', etc.
    text: summarizeEvent(event),            // human-readable from structured data
    timestamp: event.createdAt
  })
}
```

Signals add real-time presence: "Agent is thinking...", progress updates, delivery confirmations. A true real-time view of everything happening in the system.

---

## Engine → Relay Migration (Phased)

**Phase 1:** Console → HTTP POST → AgentManager → SDK (current flow unchanged). Inter-agent messages go through Relay.

**Phase 2:** Console becomes `relay.human.console.{userId}` — just another endpoint. All messages (Console, Pulse, agent-to-agent, Telegram) use the same Relay envelope. Unified message log, one SSE stream for everything.

---

## Agent Runtime Adapter Readiness

Current `AgentManager` is tightly coupled to Claude Agent SDK (`query()`, `SDKMessage`, SDK `Options`). No adapter interface exists. To support multiple runtimes:

1. Extract `AgentRuntimeAdapter` interface
2. Current SDK code → `ClaudeCodeAdapter implements AgentRuntimeAdapter`
3. `AgentManager` dispatches to adapter selected by agent manifest
4. Other adapters (Codex, OpenCode) implement the same interface

**The natural interface point already exists:** `sdk-event-mapper.ts` maps SDK messages to `StreamEvent`. That mapping boundary is where the adapter interface would go. Refactor when the second adapter is needed, not prematurely.

---

## Litepaper Updates Needed

The litepaper needs updates to reflect the Relay/Mesh responsibility split:
- **Relay section**: "Outbound communication" → "Universal message bus (internal + external)"
- **Mesh section**: Remove "structured message passing" → "Discovery + topology + access control"
- **Architecture diagram**: Show Relay as foundational, Mesh/Pulse building on top
- **Workflow example**: Route inter-agent messages through Relay

**Recommendation:** Update after design is finalized to avoid multiple revisions.

---

## Open Questions

- ~~Should Relay support pub/sub?~~ **Answered:** Yes, via hierarchical subjects.
- How does Relay handle backpressure when an endpoint is overwhelmed?
- How does voice streaming interact with the message + signal model?
- Should the Console activity feed be a core Relay feature or a Console-only concern?

---

## Implementation Phases (Draft)

**Phase 1 — Core Transport (`packages/relay`):**
- Endpoint registry (in-memory + config persistence)
- Maildir message store + SQLite index
- Message envelope schema (Zod in `@dorkos/shared`)
- Subject matching with NATS-style wildcards
- Send/receive flow with atomic delivery
- Dead letter queue
- Signal mode (ephemeral EventEmitter)
- HTTP routes in `apps/server`: send, inbox, message history, SSE stream

**Phase 2 — Safety + Reliability:**
- Budget envelope enforcement
- Circuit breakers per endpoint pair
- Rate limiting per sender
- Message TTL enforcement

**Phase 3 — External Adapters + Console Integration:**
- Adapter plugin interface
- Telegram adapter (messages + typing signals)
- Webhook adapter (inbound + outbound)
- Console activity feed (SSE subscription)

**Phase 4 — Observability + Advanced:**
- Delivery metrics (SQLite queries)
- Message tracing
- Agent runtime adapter interface (extract from AgentManager)
- Pulse → Relay migration
- Console → Relay endpoint migration
