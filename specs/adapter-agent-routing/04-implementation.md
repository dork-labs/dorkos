# Implementation Summary: Adapter-Agent Routing & Visual Binding Configuration

**Created:** 2026-02-28
**Last Updated:** 2026-02-28
**Spec:** specs/adapter-agent-routing/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 13 / 13

## Tasks Completed

### Session 1 - 2026-02-28

- Task #2: [P1] Add AdapterBinding and SessionStrategy schemas to relay-schemas.ts
- Task #3: [P1] Verify Bug #70 relay publish pipeline fix (already applied in commit 081c95b)
- Task #4: [P1] Implement BindingStore with JSON persistence and resolution logic
- Task #5: [P2] Implement BindingRouter with inbound interception and session management
- Task #7: [P2] Add Transport interface methods and implement in all transports
- Task #10: [P3] Create AdapterNode and BindingEdge React Flow components
- Task #11: [P3] Create BindingDialog for connection configuration
- Task #6: [P2] Wire BindingRouter into AdapterManager startup and add HTTP routes
- Task #9: [P3] Create entities/binding FSD entity with TanStack Query hooks
- Task #8: [P2] Add MCP tools for binding management (binding_list, binding_create, binding_delete)
- Task #12: [P3] Extend TopologyGraph with adapter nodes, binding edges, and connection validation
- Task #13: [P4] Handle edge cases: orphaned bindings, stale sessions, and empty states
- Task #14: [P4] Update documentation (CLAUDE.md, architecture.md, api-reference.md)

## Files Modified/Created

**Source files:**

- `packages/shared/src/relay-schemas.ts` — Added SessionStrategySchema, AdapterBindingSchema, CreateBindingRequestSchema, BindingListResponseSchema, BindingResponseSchema
- `packages/shared/src/transport.ts` — Added getBindings(), createBinding(), deleteBinding() to Transport interface
- `apps/server/src/services/relay/binding-store.ts` — BindingStore class with JSON persistence, CRUD, most-specific-first resolution, chokidar hot-reload, atomic writes
- `apps/server/src/services/relay/binding-router.ts` — BindingRouter service: subscribes to relay.human.*, resolves bindings, manages sessions, republishes to relay.agent.*
- `apps/client/src/layers/shared/lib/http-transport.ts` — Added getBindings, createBinding, deleteBinding HTTP methods
- `apps/client/src/layers/shared/lib/direct-transport.ts` — Added binding stubs (not supported in embedded mode)
- `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx` — React Flow custom node for adapters (icon, status, binding count)
- `apps/client/src/layers/features/mesh/ui/BindingEdge.tsx` — React Flow custom edge for bindings (bezier, label, delete button)
- `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx` — BindingDialog component with session strategy selector
- `apps/client/src/layers/features/mesh/index.ts` — Added barrel exports for all new components
- `packages/test-utils/src/mock-factories.ts` — Added binding methods to createMockTransport()
- `apps/server/src/services/relay/adapter-manager.ts` — Wired BindingStore + BindingRouter initialization, added getBindingStore() getter
- `apps/server/src/index.ts` — Passed relayCore to AdapterManager deps for binding subsystem
- `apps/server/src/routes/relay.ts` — Added GET/POST/DELETE /api/relay/bindings routes
- `apps/server/src/services/relay/index.ts` — Added barrel exports for BindingStore, BindingRouter
- `apps/client/src/layers/entities/binding/model/use-bindings.ts` — TanStack Query hook for binding list
- `apps/client/src/layers/entities/binding/model/use-create-binding.ts` — Mutation hook for creating bindings
- `apps/client/src/layers/entities/binding/model/use-delete-binding.ts` — Mutation hook for deleting bindings
- `apps/client/src/layers/entities/binding/index.ts` — Barrel exports for binding entity
- `apps/server/src/services/core/mcp-tool-server.ts` — Added binding_list, binding_create, binding_delete MCP tools
- `apps/server/src/services/core/index.ts` — Added barrel exports for binding tool handlers
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` — Extended with adapter nodes, binding edges, drag-to-connect, BindingDialog integration, ELK layout update
- `apps/client/src/layers/features/mesh/ui/AgentNode.tsx` — Added agentDir field to AgentNodeData interface
- `CLAUDE.md` — Updated service count (28), added binding services, routes, FSD entity, MCP tools
- `contributing/architecture.md` — Added binding services to module layout, updated Transport method count
- `contributing/api-reference.md` — Added binding endpoint documentation

**Test files:**

- `packages/shared/src/__tests__/relay-binding-schemas.test.ts` — 13 schema validation tests
- `apps/server/src/services/relay/__tests__/binding-store.test.ts` — 24 tests (CRUD, resolution scoring, orphan detection, persistence)
- `apps/server/src/services/relay/__tests__/binding-router.test.ts` — 16 tests (subscription, routing, session strategies, persistence, cleanup)
- `apps/client/src/layers/shared/lib/__tests__/transport-bindings.test.ts` — 11 tests (HTTP + Direct transport binding methods)
- `apps/client/src/layers/features/mesh/ui/__tests__/AdapterNode.test.tsx` — 13 component tests
- `apps/client/src/layers/features/mesh/ui/__tests__/BindingEdge.test.tsx` — 9 component tests
- `apps/client/src/layers/features/mesh/ui/__tests__/BindingDialog.test.tsx` — 10 component tests
- `apps/server/src/routes/__tests__/relay.test.ts` — 8 binding route tests added
- `apps/client/src/layers/entities/binding/__tests__/use-bindings.test.tsx` — 9 entity hook tests
- `apps/server/src/services/core/__tests__/mcp-binding-tools.test.ts` — 10 MCP tool tests
- `apps/client/src/layers/features/mesh/ui/__tests__/TopologyGraph.test.tsx` — 17 integration tests

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- Bug #70 fix verified as already applied — no code changes needed
- BindingStore was implemented alongside schemas (tasks #2 + #4 combined by agent)
- BindingRouter adapted to actual RelayCore API (uses subscribe() not on(), no public deadLetter())
- Session map persisted to ~/.dork/relay/sessions.json as requested
- Transport binding methods follow existing patterns (HttpTransport wraps REST, DirectTransport throws)
- AdapterNode follows AgentNode memo pattern; BindingEdge uses getBezierPath + EdgeLabelRenderer
- AdapterManager wiring: BindingStore + BindingRouter initialized in initBindingSubsystem(), non-fatal on failure
- Binding routes added inside existing `if (adapterManager)` guard in relay.ts
- Entity hooks follow existing TanStack Query patterns (useRelayMessages, etc.)
- MCP tools use `requireBindingStore()` guard pattern, conditionally registered when bindingStore is available
- TopologyGraph: adapters in FIRST ELK layer, agents in LAST when adapters present; indigo color in MiniMap
- Connection validation: only adapter→agent connections allowed; `nodesConnectable` enabled only when adapters exist
- AgentNodeData extended with `agentDir` for binding creation context
- Orphan detection wired on adapter delete (warns but doesn't auto-delete)
- Session cleanup wired on binding delete via cleanupOrphanedSessions()
- Empty state UI hints added: "Add adapters..." and "Drag to connect..." overlays
