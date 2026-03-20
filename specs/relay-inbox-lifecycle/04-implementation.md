# Implementation Summary: Relay Inbox Lifecycle — Endpoint Types, Dispatch TTL, relay_query Streaming

**Created:** 2026-03-05
**Last Updated:** 2026-03-05
**Spec:** specs/relay-inbox-lifecycle/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 11 / 11

## Tasks Completed

### Session 1 - 2026-03-05

- Task #1: [P1] Add EndpointType and inferEndpointType to packages/relay/src/types.ts
- Task #2: [P1] Extend RelayOptions with TTL fields in packages/relay/src/types.ts
- Task #5: [P3] Update createRelayQueryHandler to accumulate progress events
- Task #3: [P2] Add TTL sweeper and getDispatchInboxTtlMs to RelayCore
- Task #6: [P3] Write relay_query progress unit tests in relay-tools.test.ts

## Files Modified/Created

**Source files:**

- `packages/relay/src/types.ts` — Added EndpointType union type and inferEndpointType() function
- `packages/relay/src/index.ts` — Added EndpointType and inferEndpointType exports
- `apps/server/src/services/core/mcp-tools/relay-tools.ts` — Updated createRelayQueryHandler with progress accumulation, updated return shape and tool description
- `packages/relay/src/relay-core.ts` — Added TTL sweeper (startTtlSweeper, dispatchInboxTtlMs/ttlSweepIntervalMs fields, getDispatchInboxTtlMs accessor, close() teardown)
- `apps/server/src/services/core/mcp-tools/index.ts` — Added createRelayQueryHandler to exports

**Test files:**

- `apps/server/src/services/core/__tests__/mcp-relay-tools.test.ts` — New tests for relay_query progress accumulation and relay_list_endpoints type metadata

## Files Modified/Created (continued)

- `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts` — Added TTL sweeper integration test (real timers, 10ms TTL), relay_query e2e test; updated backward-compat test for unified streaming
- `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` — Updated inbox replyTo test for unified streaming behavior
- `apps/server/src/services/core/context-builder.ts` — Updated RELAY_TOOLS_CONTEXT: relay_query progress[] field, dispatch inbox auto-expiry note, relay_list_endpoints type/expiresAt note

## Known Issues

_(None — all tests pass)_

## Implementation Notes

### Session 1

All 11 tasks completed across 6 implementation batches. Key decisions:

- TTL sweeper test uses real timers (not fake timers) to avoid chokidar conflicts
- `inferEndpointType` inlined in relay-tools.ts (stale dist workaround; resolves after `pnpm build`)
- CCA unified streaming: replaced `isDispatchInbox`/`isQueryInbox` branches with single `isInboxReplyTo` check
