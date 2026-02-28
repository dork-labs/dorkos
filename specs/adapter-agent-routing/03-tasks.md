# Task Breakdown: Adapter-Agent Routing & Visual Binding Configuration

**Spec:** `specs/adapter-agent-routing/02-specification.md`
**Generated:** 2026-02-28
**Mode:** Full

---

## Phase 1: Foundation (3 tasks)

### 1.1 Add AdapterBinding and SessionStrategy schemas to relay-schemas.ts
**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.2

Add `SessionStrategySchema`, `AdapterBindingSchema`, `CreateBindingRequestSchema`, `BindingListResponseSchema`, and `BindingResponseSchema` to `packages/shared/src/relay-schemas.ts`. All schemas include `.openapi()` metadata. Includes unit tests for schema validation, defaults, and edge cases.

---

### 1.2 Verify Bug #70 relay publish pipeline fix
**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.1

Verify the relay publish pipeline fix is in place — the early-return at `relay-core.ts:308-315` that skips adapter delivery when no Maildir endpoints match must be removed. Messages published to `relay.human.*` must always reach the adapter delivery path. Run existing relay tests to confirm no regressions.

---

### 1.3 Implement BindingStore with JSON persistence and resolution logic
**Size:** Large | **Priority:** High | **Dependencies:** 1.1 | **Parallel:** None

Create `apps/server/src/services/relay/binding-store.ts` — a JSON file-backed store at `~/.dork/relay/bindings.json` with CRUD operations, most-specific-first resolution scoring (adapterId + chatId + channelType = score 7, down to adapterId-only wildcard = score 1), chokidar hot-reload, and atomic write via temp+rename. Includes comprehensive unit tests for CRUD, resolution scoring, and edge cases.

---

## Phase 2: Core Routing (4 tasks)

### 2.1 Implement BindingRouter with inbound interception and session management
**Size:** Large | **Priority:** High | **Dependencies:** 1.3 | **Parallel:** None

Create `apps/server/src/services/relay/binding-router.ts` — subscribes to `relay.human.*`, resolves bindings via BindingStore, manages session lifecycle based on strategy (per-chat reuses sessions, per-user groups by userId, stateless always creates new), persists session map to `~/.dork/relay/sessions.json`, and republishes to `relay.agent.*`. Includes unit tests for routing, session strategies, and dead-lettering.

---

### 2.2 Wire BindingRouter into AdapterManager startup and add HTTP routes
**Size:** Medium | **Priority:** High | **Dependencies:** 2.1 | **Parallel:** 2.3

Initialize BindingStore and BindingRouter inside AdapterManager.init(), expose `getBindingStore()` getter, add shutdown calls. Add HTTP routes to `routes/relay.ts`: GET/POST/DELETE `/api/relay/bindings` and GET `/api/relay/bindings/:id` with Zod validation and appropriate error responses.

---

### 2.3 Add Transport interface methods and implement in all transports
**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel:** 2.2

Extend the Transport interface with `getBindings()`, `createBinding()`, `deleteBinding()`. Implement in HttpTransport (fetch to `/api/relay/bindings`), DirectTransport (passthrough to BindingStore), and MockTransport (in-memory with vi.fn() defaults).

---

### 2.4 Add MCP tools for binding management
**Size:** Small | **Priority:** Medium | **Dependencies:** 1.3, 2.2 | **Parallel:** None

Add `binding_list`, `binding_create`, `binding_delete` MCP tools to the tool server. Add `bindingStore` to `McpToolDeps`. Tools allow agents to manage their own bindings programmatically.

---

## Phase 3: Visual Configuration (4 tasks)

### 3.1 Create entities/binding FSD entity with TanStack Query hooks
**Size:** Small | **Priority:** High | **Dependencies:** 2.3 | **Parallel:** 3.2

Create `apps/client/src/layers/entities/binding/` with `useBindings()`, `useCreateBinding()`, `useDeleteBinding()` hooks following TanStack Query patterns. All hooks use `useTransport()` and invalidate the `['relay', 'bindings']` query key on mutations. Includes barrel exports and hook tests.

---

### 3.2 Create AdapterNode and BindingEdge React Flow components
**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel:** 3.1

Create `AdapterNode.tsx` — displays adapter name, type icon (Telegram/Webhook/Bot), status indicator, binding count badge, and right-side Handle for connections. Create `BindingEdge.tsx` — bezier path with label (binding label or session strategy) and delete button. Both are memoized and follow existing React Flow component patterns. Includes component tests.

---

### 3.3 Create BindingDialog for connection configuration
**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel:** 3.1, 3.2

Create `BindingDialog.tsx` — a modal dialog for configuring new bindings when dragging from adapter to agent. Includes session strategy selector (per-chat/per-user/stateless with descriptions), optional label input, confirm/cancel buttons. Uses existing shadcn/ui Dialog, Select, Input, and Button components. Includes component tests.

---

### 3.4 Extend TopologyGraph with adapter nodes, binding edges, and connection validation
**Size:** Large | **Priority:** High | **Dependencies:** 3.1, 3.2, 3.3 | **Parallel:** None

Modify `TopologyGraph.tsx` to register AdapterNode and BindingEdge types, fetch bindings/adapters data, convert adapters to nodes and bindings to edges, add connection validation (only adapter-to-agent), handle `onConnect` by opening BindingDialog, update ELK layout for left-right positioning (adapters left, agents right), and enable `nodesConnectable={true}`.

---

## Phase 4: Polish (2 tasks)

### 4.1 Handle edge cases: orphaned bindings, stale sessions, and empty states
**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.4 | **Parallel:** 4.2

Add `getOrphaned()` to BindingStore, filter out invalid binding edges in TopologyGraph, add `cleanupOrphanedSessions()` to BindingRouter, and implement empty state UI when no adapters/agents/bindings exist. Includes tests for orphan detection and cleanup.

---

### 4.2 Update documentation with BindingStore, BindingRouter, and binding entity
**Size:** Small | **Priority:** Low | **Dependencies:** 3.4 | **Parallel:** 4.1

Update CLAUDE.md (service inventory, route descriptions, FSD layer table, MCP tools), contributing/architecture.md (BindingRouter in service inventory), and contributing/api-reference.md (binding endpoint documentation).

---

## Dependency Graph

```
Phase 1:  [1.1] ──┐     [1.2]
                   │
Phase 2:  [1.3] ──→ [2.1] ──→ [2.2] ──→ [2.4]
          [1.1] ──→ [2.3]       │
                                │
Phase 3:  [2.3] ──→ [3.1] ──┐  │
                    [3.2] ──┼──→ [3.4]
                    [3.3] ──┘
                                │
Phase 4:           [3.4] ──→ [4.1]
                   [3.4] ──→ [4.2]
```

## Summary

| Phase | Tasks | Sizes |
|-------|-------|-------|
| 1. Foundation | 3 | 1 small, 1 small, 1 large |
| 2. Core Routing | 4 | 1 large, 1 medium, 1 medium, 1 small |
| 3. Visual Configuration | 4 | 1 small, 1 medium, 1 medium, 1 large |
| 4. Polish | 2 | 1 medium, 1 small |
| **Total** | **13** | 4 small, 4 medium, 3 large |
