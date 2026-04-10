---
slug: relay-server-client-integration
number: 51
created: 2026-02-24
status: ideation
---

# Relay Server & Client Integration

**Slug:** relay-server-client-integration
**Author:** Claude Code
**Date:** 2026-02-24
**Branch:** preflight/relay-server-client-integration
**Related:** [Relay Core Library (Spec 50)](../relay-core-library/) | [Relay Litepaper](../../meta/modules/relay-litepaper.md) | [Relay Design Doc](../../plans/2026-02-24-relay-design.md)

---

## 1) Intent & Assumptions

- **Task brief:** Integrate the existing `@dorkos/relay` core library into the DorkOS server and client — adding HTTP routes for message sending/inbox reading, MCP tools for agent participation, SSE streaming for real-time activity feeds, server lifecycle management with feature flag support, and a client-side Relay panel.
- **Assumptions:**
  - `packages/relay/` exists as a working library with `RelayCore`, `MaildirStore`, `SqliteIndex`, `EndpointRegistry`, `SubjectMatcher`, `BudgetEnforcer`, `AccessControl`, `SignalEmitter`, and `DeadLetterQueue`
  - `packages/shared/src/relay-schemas.ts` exists with Zod schemas for `RelayEnvelope`, `RelayBudget`, `StandardPayload`, `Signal`, and `RelayAccessRule`
  - The Pulse integration (routes, MCP tools, feature flags, client UI) is the 1:1 pattern reference
  - ADRs 0010-0013 (Maildir storage, NATS-style subjects, budget enforcement, SQLite index) are accepted decisions
- **Out of scope:**
  - Changes to the `@dorkos/relay` library itself (already built in Spec 50)
  - Rate limiting, circuit breakers (Spec 3)
  - External adapters — Slack, Discord, email (Spec 4)
  - Pulse/Console migration to Relay (Spec 5)
  - Client UI for endpoint creation/management (deferred — agents and server bootstrap handle this initially)

## 2) Pre-reading Log

- `contributing/architecture.md`: Transport abstraction (HttpTransport/DirectTransport), hexagonal architecture, dependency injection pattern, FSD layer rules
- `contributing/data-fetching.md`: TanStack Query patterns used for server state, SSE streaming integration with React Query cache
- `contributing/api-reference.md`: Zod schema validation, OpenAPI spec generation via `openapi-registry.ts`, Scalar docs UI
- `meta/modules/relay-litepaper.md`: Relay as "kernel IPC for agents", D-Bus analog, message + signal modes, budget envelopes, Console-as-endpoint vision
- `plans/2026-02-24-relay-design.md`: HTTP routes spec (lines 306-330), MCP tool patterns, Console activity feed design (lines 458-476), observability section
- `apps/server/src/routes/pulse.ts` (136 lines): CRUD router with Zod `safeParse()`, boundary checking, error handling — exact pattern for Relay routes
- `apps/server/src/services/mcp-tool-server.ts` (289 lines): `McpToolDeps` injection, `requirePulse()` guard pattern, `jsonContent()` helper, conditional tool registration
- `apps/server/src/services/pulse-store.ts` (375 lines): Dual storage (SQLite for runs, JSON for schedules), WAL mode, CRUD operations, atomic writes
- `apps/server/src/services/pulse-state.ts`: Boolean feature flag state holder — `setPulseEnabled()`/`isPulseEnabled()` pattern
- `apps/server/src/services/scheduler-service.ts`: Cron lifecycle, concurrent run cap, AbortController, graceful shutdown
- `apps/server/src/index.ts` (144 lines): Feature flag resolution from env + config, service composition, conditional route mounting, graceful shutdown handlers
- `apps/server/src/app.ts` (56 lines): Express app factory, route composition at `/api/` prefix
- `apps/server/src/services/stream-adapter.ts`: `initSSEStream()`, `sendSSEEvent()`, `endSSEStream()` helpers for SSE wire protocol
- `apps/server/src/services/session-broadcaster.ts`: File watching + SSE broadcasting, debounce (100ms), incremental offset reading, client registration/cleanup on `close`
- `packages/relay/src/relay-core.ts` (200+ lines): Main entry point, `publish()`/`subscribe()`/`signal()` pipeline, envelope validation
- `packages/relay/src/types.ts`: `MessageHandler`, `SignalHandler`, `EndpointInfo`, `MetricsInfo` interfaces
- `packages/relay/src/endpoint-registry.ts`: Subject → mailbox mapping, persistent config
- `packages/relay/src/maildir-store.ts`: Atomic POSIX rename delivery (tmp → new → cur → failed)
- `packages/relay/src/sqlite-index.ts`: Derived queryable index, rebuild capability
- `packages/relay/src/budget-enforcer.ts`: Hop count, ancestor chain, TTL, call budget validation
- `packages/relay/src/dead-letter-queue.ts`: Failed message tracking + reason logging
- `packages/relay/src/signal-emitter.ts`: Ephemeral event distribution (no storage)
- `apps/client/src/layers/entities/pulse/`: Entity hooks — `usePulseEnabled`, `useSchedules`, `useRuns`, `useCancelRun`, `useCompletedRunBadge`
- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx`: Main panel — disabled state, loading skeleton, empty state, schedule list
- `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx`: Expandable card with run history
- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`: Run history, filtering, timestamps
- `apps/client/src/App.tsx`: Top-level layout, conditional panel rendering
- `turbo.json`: `globalPassThroughEnv` includes `DORKOS_PULSE_ENABLED` — pattern for `DORKOS_RELAY_ENABLED`
- `packages/shared/src/config-schema.ts`: `UserConfigSchema` with Zod, defaults, sensitive key list
- `packages/shared/src/relay-schemas.ts` (133 lines): Existing Zod schemas for RelayEnvelope, RelayBudget, StandardPayload, Signal, RelayAccessRule
- `research/20260224_relay_core_library_typescript.md`: Deep research on Maildir, NATS subjects, ULID, SQLite WAL, TypeScript EventEmitter patterns

## 3) Codebase Map

**Primary Components/Modules:**

_Server Layer (new/modified):_

- `apps/server/src/routes/relay.ts` (NEW) — HTTP routes: POST /messages, GET /messages, GET /endpoints, POST /endpoints, GET /endpoints/:subject/inbox, GET /dead-letters, GET /metrics, GET /stream (SSE)
- `apps/server/src/services/relay-state.ts` (NEW) — Feature flag holder: `setRelayEnabled()`/`isRelayEnabled()`, same as `pulse-state.ts`
- `apps/server/src/services/mcp-tool-server.ts` (MODIFY) — Add `relay_send`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint` tools with `requireRelay()` guard
- `apps/server/src/index.ts` (MODIFY) — Initialize RelayCore if enabled, mount routes, inject into MCP deps, graceful shutdown
- `apps/server/src/app.ts` (MODIFY) — Mount `/api/relay` router conditionally

_Client Layer (new):_

- `apps/client/src/layers/entities/relay/` (NEW) — Entity hooks: `useRelayEnabled`, `useRelayMessages`, `useRelayEndpoints`, `useRelayMetrics`, `useSendMessage`, `useRelayEventStream`
- `apps/client/src/layers/features/relay/` (NEW) — UI components: `RelayPanel` (tabs: Activity Feed + Endpoints), `ActivityFeed`, `MessageRow`, `EndpointList`, `InboxView`

_Shared (modified):_

- `packages/shared/src/relay-schemas.ts` (MODIFY) — Add request/response schemas for HTTP routes (SendMessageRequest, InboxQuery, etc.)
- `packages/shared/src/config-schema.ts` (MODIFY) — Add `relay` config section
- `turbo.json` (MODIFY) — Add `DORKOS_RELAY_ENABLED` to `globalPassThroughEnv`

**Shared Dependencies:**

- `packages/relay/` — RelayCore singleton, injected into routes and MCP tools
- `packages/shared/src/relay-schemas.ts` — Zod schemas shared between server routes, client types, MCP tools
- `apps/server/src/services/stream-adapter.ts` — SSE helpers reused for Relay event stream
- `apps/server/src/services/openapi-registry.ts` — Register Relay route schemas for API docs
- `apps/client/src/layers/shared/model/` — TransportContext for HTTP calls

**Data Flow:**

```
Agent MCP tool call (relay_send)
  → mcp-tool-server.ts handler
    → RelayCore.publish(subject, payload, options)
      → AccessControl.check() → BudgetEnforcer.validate()
      → MaildirStore.deliver() (atomic POSIX rename)
      → SqliteIndex.insert() (queryable index)
      → SignalEmitter.emit() (notify subscribers)

HTTP POST /api/relay/messages
  → routes/relay.ts handler
    → Zod validation (SendMessageRequestSchema)
    → RelayCore.publish(subject, payload, options)
    → Return { id, deliveredTo, warnings }

SSE GET /api/relay/stream?subject=pattern
  → routes/relay.ts handler
    → initSSEStream(res)
    → RelayCore.subscribe(pattern, handler)
    → handler emits SSE events on each message/signal
    → req.on('close') → unsubscribe + cleanup

Client RelayPanel
  → useRelayEnabled() → GET /api/config (check relay.enabled)
  → useRelayEventStream(pattern) → EventSource('/api/relay/stream')
  → useRelayMessages(filters) → GET /api/relay/messages?cursor=X
  → useRelayEndpoints() → GET /api/relay/endpoints
```

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` env var (default: false) — added to `turbo.json` `globalPassThroughEnv`
- `~/.dork/config.json` → `relay.enabled` (boolean, default: false)
- Precedence: env var > config file > default (false)
- Server: `isRelayEnabled()` from `relay-state.ts` consumed by config route (for client) and app.ts (for route mounting)
- Client: `usePulseEnabled()` pattern → `useRelayEnabled()` queries server config

**Potential Blast Radius:**

- Direct: ~12-15 new/modified files across server, client, shared
- Server routes: 1 new file (relay.ts)
- Server services: 1 new file (relay-state.ts), 2 modified (mcp-tool-server.ts, index.ts)
- Client entities: 1 new directory with ~4-5 hook files
- Client features: 1 new directory with ~5-6 UI component files
- Shared: 2 modified files (relay-schemas.ts, config-schema.ts)
- Config: 1 modified file (turbo.json)
- Docs: AGENTS.md update, API reference update
- Tests: ~4-6 new test files (route tests, MCP tool tests, entity hook tests, UI component tests)

## 4) Root Cause Analysis

N/A — this is a feature integration, not a bug fix.

## 5) Research

Research saved to `research/20260224_relay_server_client_integration.md` (17 sources, deep depth).

**Potential solutions:**

**1. Dedicated Relay Panel (Activity Feed Only)**

- Single-purpose panel in sidebar showing real-time message events
- Pros: Lowest complexity, exact Pulse pattern reuse, fast to ship
- Cons: No inbox browsing, no endpoint management, limited utility
- Complexity: Low | Maintenance: Low

**2. Integrated into Session View**

- Relay messages shown inline with chat messages
- Pros: Maximum context — see relay activity alongside agent conversation
- Cons: FSD layer violations, clutters chat, hard to view without active session
- Complexity: High | Maintenance: High

**3. Notification Drawer from Status Bar**

- Slide-out overlay triggered by Relay icon in status bar
- Pros: Non-intrusive, accessible from anywhere
- Cons: New UI primitive (no existing pattern), overlay disrupts work, unsuitable as sole inbox UI
- Complexity: Medium | Maintenance: Medium

**4. Split Panel with Tabs — Activity Feed + Endpoints/Inbox (RECOMMENDED)**

- Dedicated panel with "Activity" tab (real-time feed) + "Endpoints" tab (inbox browser)
- Pros: Clean separation of monitoring vs management, follows Pulse pattern, incremental delivery (ship Activity tab first, Endpoints tab next)
- Cons: More initial design surface, tabs may feel heavyweight for early usage
- Complexity: Medium | Maintenance: Low

**REST API recommendations:**

- Cursor-based pagination using ULIDs as opaque cursors — immune to insert/delete races
- Return `deliveredTo: 0` with warning (not 4xx) when no endpoints match
- Accept optional `idempotencyKey` header on send for safe MCP retries
- Endpoint structure: `/api/relay/messages`, `/api/relay/endpoints/:subject/inbox`, `/api/relay/stream`, `/api/relay/dead-letters`, `/api/relay/metrics`

**SSE streaming recommendations:**

- Reuse `initSSEStream`/`sendSSEEvent`/`endSSEStream` from `stream-adapter.ts`
- Register one `RelayCore.subscribe(pattern)` per SSE connection (not global fan-out)
- Send keepalive comments every 15 seconds to prevent proxy drops
- Include ULID as `id:` field in SSE events for `Last-Event-ID` replay
- 5 event types: `relay_connected`, `relay_message`, `relay_delivery`, `relay_dead_letter`, `relay_metrics`

**Activity feed UI recommendations:**

- Flat chronological list (newest-first), compact rows by default
- Status indicators: `new` → clock icon, `cur` → check icon, `failed` → alert-triangle + destructive color, `dead_letter` → mail-x + warning color
- Expand on click for full payload + budget details
- Subject combobox + status multi-select for filtering
- "Load more" button (not infinite scroll) to avoid virtual list complexity initially

**MCP tool recommendations:**

- All responses wrapped via `jsonContent()` helper (Pulse pattern)
- Error handling: `isError: true` with `{ error, code, hint }` so agents can self-correct
- Distinct error codes: `ACCESS_DENIED`, `BUDGET_EXCEEDED`, `INVALID_SUBJECT`, `ENDPOINT_NOT_FOUND`

## 6) Decisions

| #   | Decision                | Choice                                                                                     | Rationale                                                                                                                                                                                       |
| --- | ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Client panel structure  | Split panel with tabs (Activity Feed + Endpoints/Inbox)                                    | Clean separation of monitoring vs management, follows Pulse panel pattern, supports incremental delivery — ship Activity Feed first, add Endpoints tab next                                     |
| 2   | MCP tool scope          | Core 3 + register (relay_send, relay_inbox, relay_list_endpoints, relay_register_endpoint) | The register tool is essential for agents to self-provision endpoints without manual setup. Metrics and dead-letter tools deferred to avoid scope creep                                         |
| 3   | SSE event filtering     | Server-side subject pattern filter via query param                                         | `GET /api/relay/stream?subject=relay.agent.*` — uses `RelayCore.subscribe(pattern)` internally, prevents flooding clients with irrelevant events, scales better than client-side filtering      |
| 4   | Endpoint creation model | Server bootstrap + MCP tool                                                                | Server auto-registers system endpoints (`relay.system.*`) on startup. Agents create their own endpoints via `relay_register_endpoint` MCP tool. No client UI for endpoint creation in this spec |
