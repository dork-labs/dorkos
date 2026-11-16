# Implementation Summary: Fix Relay Agent-to-Agent Routing CWD Bug + Harden ClaudeCodeAdapter Pipeline

**Created:** 2026-03-04
**Last Updated:** 2026-03-05
**Spec:** specs/fix-relay-agent-routing-cwd/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 14 / 14

## Tasks Completed

### Session 1 - 2026-03-04

- Task #1: [fix-relay-agent-routing-cwd] [P1] Fix AdapterManagerDeps.meshCore type and buildContext() method
- Task #2: [fix-relay-agent-routing-cwd] [P1] Fix RELAY_TOOLS_CONTEXT doc labels in context-builder.ts
- Task #3: [fix-relay-agent-routing-cwd] [P1] Fix index.ts init order so meshCore is available when adapterManager starts
- Task #4: [fix-relay-agent-routing-cwd] [P1] Add buildContext() tests to adapter-manager.test.ts
- Task #5: [fix-relay-agent-routing-cwd] [P2] Create AgentSessionStore for persistent agentId-to-SDK-UUID mapping
- Task #6: [fix-relay-agent-routing-cwd] [P2] Add unit tests for AgentSessionStore
- Task #7: [fix-relay-agent-routing-cwd] [P2] Wire AgentSessionStore into AdapterManager and CCA
- Task #8: [fix-relay-agent-routing-cwd] [P2] Add session mapping integration tests to CCA test suite
- Task #9: [fix-relay-agent-routing-cwd] [P3] Add Agent-ID and Session-ID lines to relay_context block
- Task #13: [fix-relay-agent-routing-cwd] [P5] Naming audit in adapter-delivery.ts, relay-tools.ts, and interactive-handlers.ts (no changes needed — files were already clean)

### Session 2 - 2026-03-05

- Task #10: [fix-relay-agent-routing-cwd] [P4] Add per-agentId promise queue to CCA for concurrency safety
- Task #11: [fix-relay-agent-routing-cwd] [P4] Add concurrency serialization tests to CCA test suite
- Task #12: [fix-relay-agent-routing-cwd] [P5] Rename extractSessionId to extractAgentId and audit sessionId usages in CCA
- Task #14: [fix-relay-agent-routing-cwd] [P5] Update relay-cca-roundtrip test and run full test suite — 720 relay tests, 1125 server tests, typecheck clean

## Files Modified/Created

**Source files:**

- `apps/server/src/services/relay/adapter-manager.ts` - Added AdapterMeshCoreLike interface, fixed buildContext() to use getProjectPath()
- `apps/server/src/services/core/context-builder.ts` - Updated RELAY_TOOLS_CONTEXT labels from {sessionId} to {agentId}
- `apps/server/src/index.ts` - Split relay init into Phase A (RelayCore) and Phase C (AdapterManager after meshCore)
- `apps/server/src/services/relay/agent-session-store.ts` - Created new AgentSessionStore with atomic persistence
- `packages/relay/src/adapters/claude-code-adapter.ts` - Added AgentSessionStoreLike deps, getSdkSessionId to AgentManagerLike, session persistence in handleAgentMessage()
- `apps/server/src/services/relay/adapter-factory.ts` - Added agentSessionStore to AdapterFactoryDeps, pass-through to CCA
- `packages/relay/src/index.ts` - Exported AgentSessionStoreLike
- `packages/relay/src/types.ts` - Added queuedMessages?: number to AdapterStatus

**Test files:**

- `apps/server/src/services/core/__tests__/context-builder.test.ts` - Updated assertions for new agentId labels
- `apps/server/src/services/relay/__tests__/adapter-manager.test.ts` - Added 5 buildContext() tests
- `apps/server/src/services/relay/__tests__/agent-session-store.test.ts` - Created 20 unit tests
- `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` - Added getSdkSessionId to mock factories, 3 session mapping integration tests, updated relay_context format assertions, 2 concurrency serialization tests
- `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts` - Added getSdkSessionId to mock, added CWD propagation regression test

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

Phase 1 complete: all three wiring bugs fixed (AdapterMeshCoreLike interface, buildContext() method, index.ts init order) plus tests. AgentSessionStore created ahead of schedule.

### Session 2

Phases 2-5 complete. Session mapping integration (AgentSessionStore wired into CCA), dual-ID traceability (Agent-ID + Session-ID in relay_context blocks), per-agentId concurrency queue (prevents SDK "Already connected to transport" crash), and full naming audit (extractSessionId → extractAgentId). All 720 relay tests + 1125 server tests green. Typecheck clean.
