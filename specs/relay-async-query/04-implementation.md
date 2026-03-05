# Implementation Summary: Relay Async Dispatch + CCA Streaming Progress

**Created:** 2026-03-05
**Last Updated:** 2026-03-05
**Spec:** specs/relay-async-query/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 7 / 7

## Tasks Completed

### Session 1 - 2026-03-05

- Task #1: [relay-async-query] [P1] Add RelayProgressPayload and RelayAgentResultPayload schemas to relay-schemas.ts
- Task #2: [relay-async-query] [P1] Add relay_dispatch and relay_unregister_endpoint tools to relay-tools.ts
- Task #3: [relay-async-query] [P1] Export new handlers from mcp-tools/index.ts and add to RELAY_TOOLS in tool-filter.ts
- Task #4: [relay-async-query] [P1] Update mcp-tool-server tests and tool-filter tests for new tools
- Task #5: [relay-async-query] [P2] Refactor handleAgentMessage in ClaudeCodeAdapter to stream progress to dispatch inboxes
- Task #6: [relay-async-query] [P2] Add CCA dispatch streaming integration tests to relay-cca-roundtrip.test.ts
- Task #7: [relay-async-query] [P3] Update RELAY_TOOLS_CONTEXT in context-builder.ts with relay_dispatch workflow and subagent MCP constraint

## Files Modified/Created

**Source files:**

- `packages/shared/src/relay-schemas.ts` — Added `RelayProgressPayloadSchema` and `RelayAgentResultPayloadSchema` with `.openapi()` metadata and exported TypeScript types
- `apps/server/src/services/core/mcp-tools/relay-tools.ts` — Added `createRelayDispatchHandler` and `createRelayUnregisterEndpointHandler` exports; registered both tools in `getRelayTools()`; raised `relay_query` timeout cap from 120,000ms to 600,000ms
- `apps/server/src/services/core/mcp-tools/index.ts` — Added new handlers to barrel export
- `apps/server/src/services/core/tool-filter.ts` — Added `mcp__dorkos__relay_dispatch` and `mcp__dorkos__relay_unregister_endpoint` to `RELAY_TOOLS` constant
- `packages/relay/src/adapters/claude-code-adapter.ts` — Refactored `handleAgentMessage()`: split `isInboxReplyTo` into `isDispatchInbox`/`isQueryInbox`; added streaming progress to dispatch inboxes; added `publishDispatchProgress()` private helper; updated `publishAgentResult()` to include `done: true`
- `apps/server/src/services/core/context-builder.ts` — Replaced `RELAY_TOOLS_CONTEXT` with updated version documenting relay_dispatch fire-and-poll workflow, timeout_ms=600000, and subagent MCP constraint warning

**Test files:**

- `apps/server/src/services/core/__tests__/mcp-tool-server.test.ts` — Updated tool count 14→16; added `makeRelayCoreMock` factory; full test suites for both new handlers
- `apps/server/src/services/core/__tests__/tool-filter.test.ts` — Added new relay tools to exclusion/inclusion tests; two new dedicated feature-gate tests
- `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts` — Added 3 integration tests: dispatch inbox streaming, query inbox backward compat, step_type field validation

## Known Issues

_(None)_

## Implementation Notes

### Session 1

Both parallel agents exceeded their assigned task scope and together implemented all 7 tasks in a single session. All 1,133 server tests and 723 relay tests pass. TypeScript compiles without errors across all packages.
