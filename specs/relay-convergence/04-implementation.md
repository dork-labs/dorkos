# Implementation Summary: Relay Convergence — Migrate Pulse & Console to Relay Transport

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
**Spec:** specs/relay-convergence/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 18 / 18
**Tests:** 2006 passing across 144 test files (no regressions)

## Tasks Completed

### Session 1 - 2026-02-25

| Task | Phase | Description                                                    | Status |
| ---- | ----- | -------------------------------------------------------------- | ------ |
| T1   | P1    | Add TraceSpan and DeliveryMetrics Zod schemas                  | Done   |
| T2   | P1    | Create TraceStore service with SQLite schema                   | Done   |
| T3   | P1    | Create MessageReceiver service                                 | Done   |
| T4   | P1    | Add trace and metrics API endpoints + MCP tools                | Done   |
| T5   | P1    | Wire TraceStore and MessageReceiver into server initialization | Done   |
| T6   | P2    | Add optional RelayCore dependency to SchedulerService          | Done   |
| T7   | P2    | Implement executeRunViaRelay with PulseDispatchPayload         | Done   |
| T8   | P2    | Implement handlePulseMessage with full run lifecycle           | Done   |
| T9   | P3    | Modify POST /messages handler with Relay 202 receipt path      | Done   |
| T10  | P3    | Extend SessionBroadcaster with Relay subscription fan-in       | Done   |
| T11  | P3    | Add new SSE event types for Relay                              | Done   |
| T12  | P4    | Extend Transport interface with sendMessageRelay               | Done   |
| T13  | P4    | Update use-chat-session to handle receipt+SSE protocol         | Done   |
| T14  | P4    | Client tests for both chat protocols                           | Done   |
| T15  | P5    | Create useMessageTrace and useDeliveryMetrics hooks            | Done   |
| T16  | P5    | Build MessageTrace timeline component                          | Done   |
| T17  | P5    | Build DeliveryMetrics dashboard component                      | Done   |
| T18  | P6    | Update AGENTS.md and contributing guides                       | Done   |

## Files Created

**Server:**

- `apps/server/src/services/relay/trace-store.ts` — SQLite trace storage (message_traces table)
- `apps/server/src/services/relay/message-receiver.ts` — Relay→AgentManager bridge
- `apps/server/src/services/relay/__tests__/trace-store.test.ts` — 7 tests
- `apps/server/src/services/relay/__tests__/message-receiver.test.ts` — 26 tests
- `apps/server/src/routes/__tests__/sessions-relay.test.ts` — 10 tests
- `apps/server/src/services/pulse/__tests__/scheduler-relay.test.ts` — 6 tests

**Client:**

- `apps/client/src/layers/entities/relay/model/use-message-trace.ts` — Trace data hook
- `apps/client/src/layers/entities/relay/model/use-delivery-metrics.ts` — Metrics hook
- `apps/client/src/layers/features/relay/ui/MessageTrace.tsx` — Trace timeline component
- `apps/client/src/layers/features/relay/ui/DeliveryMetrics.tsx` — Metrics dashboard
- `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts` — 6 tests

## Files Modified

**Shared:**

- `packages/shared/src/relay-schemas.ts` — Added TraceSpan, DeliveryMetrics, PulseDispatchPayload, RelayReceipt schemas
- `packages/shared/src/schemas.ts` — Added relay_receipt, message_delivered, relay_message event types
- `packages/shared/src/types.ts` — Exported new event types
- `packages/shared/src/transport.ts` — Added sendMessageRelay, getRelayTrace, getRelayDeliveryMetrics

**Server:**

- `apps/server/src/index.ts` — TraceStore + MessageReceiver initialization
- `apps/server/src/routes/relay.ts` — GET trace + metrics endpoints
- `apps/server/src/routes/sessions.ts` — POST 202 receipt path
- `apps/server/src/services/relay/index.ts` — Barrel exports
- `apps/server/src/services/core/mcp-tool-server.ts` — relay_get_trace, relay_get_metrics MCP tools
- `apps/server/src/services/pulse/scheduler-service.ts` — executeRunViaRelay path
- `apps/server/src/services/session/session-broadcaster.ts` — Relay SSE fan-in

**Client:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Receipt+SSE protocol
- `apps/client/src/layers/entities/relay/index.ts` — Barrel exports
- `apps/client/src/layers/features/relay/index.ts` — Barrel exports
- `apps/client/src/layers/shared/lib/http-transport.ts` — Relay transport methods
- `apps/client/src/layers/shared/lib/direct-transport.ts` — Relay transport stubs
- `packages/test-utils/src/mock-factories.ts` — Mock relay transport methods

**Docs:**

- `AGENTS.md` — Services list, session architecture, SSE protocol, FSD table
- `contributing/architecture.md` — Converged data flow section
- `contributing/api-reference.md` — New endpoint docs
- `contributing/data-fetching.md` — New hook docs

## Known Issues

### Deferred (acceptable at current scope)

- `budgetRejections` in `TraceStore.getMetrics()` returns hardcoded zeroes — requires RelayCore integration to track rejection types (hop limit, TTL expired, cycle detected, budget exhausted). UI conditionally hides the section when all zero.
- Multi-span traces cannot form — `parentSpanId` is always null. Creating child spans for response hops requires passing traceId/spanId through `publishResponse`. The trace UI is ready for multi-span data.
- `handlePulseMessage` AbortController does not propagate abort signal to the underlying AgentManager session — the agent continues running after TTL expiry until its own timeout triggers. The run is correctly marked as cancelled.

## Post-Implementation Verification Fixes

### Session 2 — Code Review & Verification (2026-02-25)

| Fix | Description                                                                                                   | Files                            |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| F1  | Missing `clientId` in EventSource URL — relay subscription never established                                  | `use-chat-session.ts`            |
| F2  | Missing `sessionBroadcaster.setRelay(relayCore)` — relay fan-in never wired                                   | `index.ts`                       |
| F3  | `relay_message` payload mismatch — client read `event.type` but server wraps as `{ payload: { type, data } }` | `use-chat-session.ts`            |
| F4  | EventSource torn down during streaming — `isStreaming` guard killed relay response path                       | `use-chat-session.ts`            |
| F5  | `deliveredAt` never set for agent messages — latency metrics were always null                                 | `message-receiver.ts`            |
| F6  | `relayCore` not passed to SchedulerService — Pulse Relay dispatch was never wired                             | `index.ts`                       |
| F7  | Test: `relay_message` event data format updated to match actual wire format                                   | `use-chat-session-relay.test.ts` |

## Implementation Notes

### Execution Strategy

- 9 batches with parallel agents per batch
- Dependency-aware ordering: schemas → storage → services → wiring → client → docs
- Total: 55 new tests added, all passing

### Key Design Decisions

- TraceStore shares SQLite database with Relay SqliteIndex (`~/.dork/relay/index.db`)
- MessageReceiver uses table existence check (not user_version) for migration since it shares the DB
- SQL SUM returns null for empty tables — coalesced with `?? 0` for DeliveryMetrics
- `useChatSession` hoists streamEventHandler to hook level via useMemo so it's shared between legacy SSE and Relay EventSource paths
- clientIdRef (crypto.randomUUID) is stable per tab via useRef
