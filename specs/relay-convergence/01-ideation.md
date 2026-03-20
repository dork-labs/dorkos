---
slug: relay-convergence
number: 55
created: 2026-02-25
status: ideation
---

# Relay Convergence — Migrate Pulse & Console to Relay Transport

**Slug:** relay-convergence
**Author:** Claude Code
**Date:** 2026-02-25
**Branch:** preflight/relay-convergence
**Related:** [Relay Design](../../plans/2026-02-24-relay-design.md), [Relay Litepaper](../../meta/modules/relay-litepaper.md), [Convergence Spec](../../plans/relay-specs/05-relay-convergence.md)

---

## 1) Intent & Assumptions

- **Task brief:** Migrate Pulse scheduled dispatch and Console chat messaging to flow through Relay, completing the convergence where all DorkOS communication uses a single message bus transport. Add delivery metrics, message tracing with a client-side trace UI, and update all documentation.
- **Assumptions:**
  - Relay core library (`packages/relay`) is implemented and stable (Spec 50 = implemented)
  - Relay server/client integration exists — routes mounted, feature flag active, MCP tools registered
  - External adapters (Telegram, webhook) exist from Spec 53
  - `DORKOS_RELAY_ENABLED` is the single feature flag controlling whether Relay is active
  - Console migration is a full protocol change — POST returns receipt, responses arrive on SSE
  - DorkOS is single-user (clientId, not userId)
  - Relay is enabled by default once this spec lands
- **Out of scope:**
  - Additional external adapters beyond Spec 4
  - Additional runtime adapters (Codex, OpenCode) — save for Spec 6
  - AgentRuntimeAdapter interface extraction — save for Spec 6
  - Multi-user support
  - Relay core library changes (packages/relay is stable)

## 2) Pre-reading Log

- `plans/relay-specs/05-relay-convergence.md`: Full spec prompt — goals, migration strategy, codebase areas, risks, verification criteria
- `plans/2026-02-24-relay-design.md`: Pulse migration path (lines 344-360), Engine→Relay migration (lines 479-484), Agent Runtime Adapter (lines 487-496), observability (lines 306-330)
- `meta/modules/relay-litepaper.md`: "What Relay Enables" — Console as endpoint, Pulse through Relay, activity feeds, Phase 5 roadmap
- `apps/server/src/services/pulse/scheduler-service.ts`: Current Pulse dispatch — `SchedulerAgentManager` interface with `ensureSession()` and `sendMessage()`. `executeRun()` calls `this.agentManager.sendMessage()` directly. `buildPulseAppend()` injects schedule context into system prompt.
- `apps/server/src/services/core/agent-manager.ts`: Session creation flow — `ensureSession()`, `sendMessage()`, session locking via `SessionLockManager`. Entry point for all message dispatch currently.
- `apps/server/src/services/core/sdk-event-mapper.ts`: Pure async generator `mapSdkMessage()` transforms SDK messages → DorkOS `StreamEvent` types. The mapping boundary where trace metadata would be injected.
- `apps/server/src/routes/sessions.ts`: POST /api/sessions/:id/messages → `agentManager.sendMessage()` → SSE streaming response on same HTTP connection. This is the Console flow that migrates to Relay.
- `apps/server/src/services/session/session-broadcaster.ts`: Cross-client session sync via chokidar JSONL file watching. SSE connections with `sync_update` events. This SSE stream will carry Relay events after convergence.
- `apps/server/src/routes/relay.ts`: Existing Relay API — POST /messages, GET /messages, GET /endpoints, POST /endpoints, DELETE /endpoints, GET inbox, GET dead-letters, GET metrics, GET stream SSE. Feature-flag guarded.
- `apps/server/src/services/relay/relay-state.ts`: Lightweight singleton — `setRelayEnabled()`/`isRelayEnabled()`. Set once at startup.
- `apps/server/src/services/relay/adapter-manager.ts`: External adapter lifecycle management, hot-reload, persistence.
- `apps/server/src/services/core/mcp-tool-server.ts`: MCP tools including `relay_send`, `relay_inbox`, `relay_register_endpoint`. Needs trace/metrics tools.
- `packages/relay/src/relay-core.ts`: RelayCore — `publish()`, `readInbox()`, `registerEndpoint()`, subject matching, budget enforcement, dead letter queue, signal emission. The bus itself.
- `packages/shared/src/relay-schemas.ts`: Zod schemas — RelayEnvelope, RelayBudget, StandardPayload, Signal, EndpointInfo.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Client message sending — `transport.sendMessage(sessionId, content)` → HTTP POST → SSE stream. Must handle new receipt+SSE protocol.
- `apps/client/src/layers/features/relay/ui/`: RelayPanel, ActivityFeed, MessageRow, InboxView, EndpointList. Needs trace view enhancement.
- `apps/client/src/layers/entities/relay/`: useRelayMessages, useSendRelayMessage, useRelayEndpoints, useRelayMetrics, useRelayEventStream.
- `research/20260224_relay_convergence.md`: Full research report — strangler fig patterns, SSE fan-in, OpenTelemetry trace model, SQLite metrics, feature flag strategies.
- `contributing/architecture.md`: Hexagonal architecture, Transport interface, dependency injection patterns.

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                             | Role                                      | Lines |
| ---------------------------------------------------------------- | ----------------------------------------- | ----- |
| `apps/server/src/services/pulse/scheduler-service.ts`            | Cron orchestration, dispatches agent runs | ~267  |
| `apps/server/src/services/core/agent-manager.ts`                 | Session creation, SDK integration         | ~300  |
| `apps/server/src/services/core/sdk-event-mapper.ts`              | SDK message → StreamEvent transform       | ~139  |
| `apps/server/src/routes/sessions.ts`                             | Console HTTP endpoints, POST /messages    | ~299  |
| `apps/server/src/routes/relay.ts`                                | Relay HTTP API                            | ~242  |
| `apps/server/src/services/session/session-broadcaster.ts`        | Cross-client SSE sync                     | ~150  |
| `apps/server/src/services/relay/adapter-manager.ts`              | External adapter lifecycle                | ~290  |
| `apps/server/src/services/relay/relay-state.ts`                  | Feature flag singleton                    | ~33   |
| `apps/server/src/services/core/mcp-tool-server.ts`               | Agent-facing MCP tools                    | ~524  |
| `packages/relay/src/relay-core.ts`                               | Core message bus                          | ~400  |
| `packages/shared/src/relay-schemas.ts`                           | Zod schemas for Relay types               | ~200  |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts` | Client chat session hook                  | ~80+  |
| `apps/client/src/layers/features/relay/ui/`                      | Relay UI components                       | ~500  |

**Shared Dependencies:**

- `apps/server/src/index.ts` — Server orchestration: Relay init (lines 63-76), MCP tool registration (79-86), route mounting (103-107), shutdown (170-176)
- Transport interface (`packages/shared/src/transport.ts`) — Abstracts HTTP/Direct for client
- Session locking (`apps/server/src/services/session/session-lock.ts`) — Prevents concurrent writes
- StreamEvent types (`packages/shared/src/types.ts`) — SSE event union type
- TanStack Query (`apps/client/src/layers/entities/`) — Server state management

**Data Flow (Current State):**

```
Pulse (cron timer) ──→ agentManager.sendMessage() ──→ Claude SDK
Console (HTTP POST) ──→ agentManager.sendMessage() ──→ Claude SDK ──→ SSE response
External Adapters ──→ relay.publish() ──→ Relay bus (separate from Console/Pulse)
```

**Data Flow (Target State):**

```
Pulse (cron timer) ──→ relay.publish('relay.system.pulse.{scheduleId}') ──┐
Console (HTTP POST) ──→ relay.publish('relay.agent.{sessionId}') ──────────┤
External Adapters ──→ relay.publish('relay.human.{platform}.{id}') ────────┤
                                                                           │
                        ┌──────────────────────────────────────────────────┘
                        ▼
                   RelayCore (subject matching, budget check, trace)
                        │
                        ▼
                   Agent endpoint receiver
                        │
                        ▼
                   agentManager.sendMessage() → Claude SDK
                        │
                        ▼
                   Response published back to sender's Relay endpoint
                        │
                        ▼
                   Console: SSE stream with relay_message events
                   Pulse: Run status updated via PulseStore
                   External: Adapter delivers via platform API
```

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` — Single flag. When true: Pulse dispatches via Relay, Console routes via Relay. When false: both fall back to direct AgentManager calls (current behavior).
- `relay.enabled` in config — Mirrors the env var via `relay-state.ts`

**Potential Blast Radius:**

- **Direct changes (high impact):** scheduler-service.ts, routes/sessions.ts, sdk-event-mapper.ts, session-broadcaster.ts, mcp-tool-server.ts, relay-schemas.ts, use-chat-session.ts
- **New files:** Message trace API endpoint, trace UI components, delivery metrics hooks
- **Test files:** scheduler-service.test.ts, sessions.test.ts, use-chat-session.test.tsx, new trace tests
- **Indirect changes:** index.ts (initialization order), types.ts (StreamEvent extensions), app-store.ts (optional metrics state)
- **No changes:** RelayCore library, existing Relay routes, external adapters, existing tests for Relay core

## 4) Root Cause Analysis

N/A — this is a migration/convergence task, not a bug fix.

## 5) Research

Research report: [`research/20260224_relay_convergence.md`](../../research/20260224_relay_convergence.md)

**Potential Solutions:**

1. **Strangler Fig with Feature Flag** — Thin dispatcher function checks `isRelayEnabled()` and routes to either Relay publish (new) or direct AgentManager call (old). Both paths stay functional during migration. Instant rollback via flag flip.
   - Pros: Matches existing patterns, instant rollback, low cognitive overhead
   - Cons: Two code paths to maintain temporarily
   - Complexity: Low

2. **Shadow Mode Before Cutover** — Dual-write: call AgentManager directly AND publish to Relay, discard Relay result. Validates wiring before cutover.
   - Pros: Catches bugs silently, zero user impact during validation
   - Cons: Third code path state, shadow mode for Console is impractical (can't discard streaming responses)
   - Complexity: Medium

3. **Adapter Interface Extraction First** — Extract `AgentRuntimeAdapter` interface, then Relay becomes another caller. No if/else branching.
   - Pros: Architecturally cleanest long-term
   - Cons: Premature abstraction (only one adapter exists), higher upfront work
   - Complexity: High

4. **SSE Fan-In for Stream Merging** — Use typed SSE events on a single connection to carry both session sync and Relay events. Browser's `EventSource` API natively supports `addEventListener('event-name', handler)`.
   - Pros: Reduces connection count, backwards-compatible (existing sync_update events unchanged)
   - Cons: None significant
   - Used by: MDN reference, industry standard

5. **SQLite Trace Storage** — Minimal trace table in existing `index.db` with OpenTelemetry-inspired fields (traceId, spanId, parentSpanId, status, timing). Live aggregate queries rather than pre-computed counters.
   - Pros: Lightweight, uses existing better-sqlite3 infrastructure, rebuildable
   - Cons: ~0.1-0.5ms per message overhead (negligible vs LLM response times)
   - Complexity: Low

**Security Considerations:**

- Console endpoint registration must be scoped to authenticated sessions — use existing `X-Client-Id` UUID
- Trace data should capture metadata only, not payload content
- Dead letter queue access gated behind boundary check
- Budget envelopes must be immutable — no forging higher budgets on re-publish

**Performance Considerations:**

- SQLite WAL mode trace writes add ~0.1-0.5ms per message (negligible)
- SSE stream merging reduces browser connections (better than separate streams)
- Console protocol change: POST returns immediately → may feel slightly faster
- Live SQL aggregates sufficient at DorkOS scale (single user, tens of msg/min)

**Recommendation:** Strangler fig with `DORKOS_RELAY_ENABLED` as the single controlling flag. Pulse migration first (lower risk, no client changes). Console migration second (requires coordinated server+client protocol change). SQLite trace storage with full trace UI.

## 6) Decisions

| #   | Decision                      | Choice                                   | Rationale                                                                                                                                                                                                                                                          |
| --- | ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Console migration approach    | Full Relay endpoint migration            | POST returns receipt (202), response chunks arrive on existing SSE stream. Results in one pattern for all communication (Console, Pulse, external adapters). DRY — no duplicate streaming pathways. Consistent with architecture vision.                           |
| 2   | Message tracing scope         | Full tracing with trace UI               | Server-side trace fields in SQLite + client-side trace viewer component. Click any Relay message to see sender → budget check → delivery → runtime adapter → response timeline. Comprehensive observability from day one.                                          |
| 3   | Pulse migration strategy      | Direct cutover via DORKOS_RELAY_ENABLED  | When Relay is enabled, Pulse dispatches through it automatically. When disabled, falls back to direct AgentManager call. No separate shadow mode or RELAY_PULSE_DISPATCH flag. No functionality lost — AgentManager still called, just triggered by Relay message. |
| 4   | Feature flag strategy         | Single DORKOS_RELAY_ENABLED flag         | Controls everything: Pulse dispatch, Console endpoint, trace collection. No independent per-subsystem flags. Simpler config surface. Relay becomes the default transport.                                                                                          |
| 5   | AgentRuntimeAdapter interface | Defer to Spec 6                          | Direct AgentManager call for now. "Refactor when the second adapter is needed, not prematurely." YAGNI. Relay message receiver calls AgentManager.sendMessage() directly.                                                                                          |
| 6   | SSE stream strategy           | Fan-in typed events on existing endpoint | Merge Relay events into existing `GET /api/sessions/:id/stream`. New event types (`relay_message`, `message_delivered`, `budget_exceeded`) are additive. Existing `sync_update` unchanged.                                                                         |
