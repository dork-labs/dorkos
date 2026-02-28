---
slug: adapter-agent-routing
number: 71
created: 2026-02-28
status: ideation
---

# Adapter-Agent Routing & Visual Configuration

**Slug:** adapter-agent-routing
**Author:** Claude Code
**Date:** 2026-02-28
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Design a system for binding external communication adapters (Telegram bots, Slack, Discord, Webhooks) to specific agents, with support for multiple concurrent bindings and visual configuration via a topology graph. Each adapter instance maps 1:1 to an agent. The UI should be world-class and hide complexity.

- **Assumptions:**
  - Builds on existing adapter catalog, mesh topology, and relay messaging systems
  - DorkOS is pre-launch — all existing systems are open to refactoring
  - React Flow v12 is already in the dependency tree (used by TopologyGraph)
  - The relay subject hierarchy (`relay.human.*`, `relay.agent.*`) is the underlying transport
  - Bug #70 (publish pipeline early return) will be fixed as a prerequisite
  - Single-user local CLI tool — no multi-tenant auth needed for MVP

- **Out of scope:**
  - Building new platform adapters (Slack, Discord) — focus is on the routing/binding architecture and UI
  - Multi-tenant authorization model
  - Token encryption at rest (adequate for single-user local use)
  - Content-based routing rules (n8n/Node-RED style)

## 2) Pre-reading Log

- `docs/plans/2026-02-28-telegram-adapter-investigation.md`: Current state of Telegram adapter — working end-to-end except for routing layer (Gap #2). Identified four design options for routing, recommended Option B (chat-to-agent mapping)
- `packages/relay/src/types.ts`: RelayAdapter interface with `subjectPrefix`, `deliver()`, `testConnection()`. AdapterContext already has `agent` field for passing directory/runtime info
- `packages/relay/src/adapters/telegram-adapter.ts`: Telegram adapter with echo guard, testConnection(), grammY polling. Publishes to `relay.human.telegram.{chatId}`
- `packages/relay/src/adapters/claude-code-adapter.ts`: Handles `relay.agent.*` and `relay.system.pulse.*`. Creates AgentManager sessions from relay messages
- `packages/relay/src/adapter-registry.ts`: Routes messages to adapters by `subject.startsWith(prefix)` matching
- `packages/relay/src/relay-core.ts`: Publish pipeline. Bug #70 at lines 300-350 — early returns when no Maildir endpoints match, skipping adapter delivery
- `apps/server/src/services/relay/adapter-manager.ts` (843 lines): Adapter lifecycle, config persistence (`~/.dork/relay/adapters.json`), hot-reload via chokidar, plugin loading, multi-instance support
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`: React Flow v12 + ELK layout. AgentNode, NamespaceGroupNode, CrossNamespaceEdge, DenyEdge
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`: Multi-step form driven by `ConfigField[]` from adapter manifest
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx`: Status display with enable/disable, configure, remove actions
- `packages/shared/src/relay-schemas.ts`: AdapterManifestSchema with `multiInstance: boolean`, ConfigFieldSchema for form generation
- `packages/shared/src/mesh-schemas.ts`: AgentManifestSchema with persona, color, icon fields
- `specs/adapter-catalog-management/02-specification.md`: Adapter metadata and UI management (draft)
- `specs/agents-first-class-entity/02-specification.md`: Agents elevated to first-class entities (specified)
- `contributing/architecture.md`: Hexagonal architecture, Transport interface, dependency injection patterns
- `research/20260228_adapter_agent_routing.md`: Full research findings — OpenClaw reference architecture, React Flow patterns, security model, phased implementation plan

## 3) Codebase Map

**Primary Components/Modules:**

- `packages/relay/src/types.ts` — RelayAdapter interface, AdapterContext, AdapterConfig, DeliveryResult
- `packages/relay/src/adapter-registry.ts` — Routes messages to adapters by subject prefix match
- `packages/relay/src/relay-core.ts` — Publish pipeline with Maildir + adapter delivery
- `packages/relay/src/adapters/telegram-adapter.ts` — Telegram grammY bridge
- `packages/relay/src/adapters/webhook-adapter.ts` — Generic HTTP webhook bridge
- `packages/relay/src/adapters/claude-code-adapter.ts` — Agent SDK session bridge
- `apps/server/src/services/relay/adapter-manager.ts` — Adapter lifecycle, config, CRUD
- `apps/server/src/routes/relay.ts` — HTTP endpoints for adapters, messages, endpoints
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` — React Flow topology canvas
- `apps/client/src/layers/features/relay/ui/` — Adapter UI components (Card, Catalog, Wizard)
- `apps/client/src/layers/entities/relay/` — TanStack Query hooks for adapter data
- `apps/client/src/layers/entities/agent/` — Agent identity hooks
- `packages/shared/src/relay-schemas.ts` — Adapter manifest and config schemas
- `packages/shared/src/mesh-schemas.ts` — Agent manifest schema

**Shared Dependencies:**

- React Flow v12 (`@xyflow/react`) — already in client dependencies
- ELK layout (`elkjs`) — already in client dependencies
- TanStack Query — all entity hooks
- Zustand — app-store for UI state
- shadcn/ui — all UI primitives
- Zod — schema validation

**Data Flow (Current — Broken):**

```
Telegram User → TelegramAdapter.handleInboundMessage()
  → relay.publish('relay.human.telegram.{chatId}', payload)
  → RelayCore.publish():
      1. findMatchingEndpoints() → [] (no Maildir endpoints)
      2. BUG #70: early-return, dead-letter
      3. adapter delivery UNREACHABLE
  → Message silently dead-lettered
```

**Data Flow (Desired — With BindingRouter):**

```
Telegram User → TelegramAdapter publishes to relay.human.telegram.{chatId}
  → BindingRouter intercepts (subscribed to relay.human.>)
  → Resolves binding: adapterId='telegram-bot-a' → agentId='my-agent'
  → Resolves/creates session: chatId → sessionId
  → Republishes to relay.agent.{sessionId} with AdapterContext.agent
  → ClaudeCodeAdapter.deliver() creates/resumes AgentManager session
  → Agent responds → published to relay.human.telegram.{chatId}
  → TelegramAdapter.deliver() sends response back to Telegram
```

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` — gates entire Relay subsystem
- `DORKOS_MESH_ENABLED` — gates Mesh discovery (independent of agents)
- Agent routes (`/api/agents/*`) work regardless of feature flags
- Adapter config persisted at `~/.dork/relay/adapters.json`

**Potential Blast Radius:**

- Direct: ~8 files (new BindingRouter, BindingStore, schemas, routes, UI components)
- Indirect: ~5 files (relay-core Bug #70 fix, adapter-manager wiring, TopologyGraph extension)
- Tests: ~6 new test files + updates to existing adapter tests

## 4) Root Cause Analysis

N/A — this is a feature, not a bug fix.

## 5) Research

Full research at `research/20260228_adapter_agent_routing.md`.

**Potential Solutions:**

**1. Binding Table + Central BindingRouter (Recommended)**

A new `BindingStore` persists adapter-to-agent bindings. A `BindingRouter` service subscribes to `relay.human.*`, resolves the binding, and republishes to `relay.agent.*`. Adapters remain dumb protocol bridges. Visual topology UI manages bindings via CRUD API.

- Pros: Build once, all adapters get routing for free. Deterministic, auditable. Clean separation of concerns. Works with existing Mesh registry. Proven by OpenClaw.
- Cons: Adds one hop in message pipeline (~1ms). Two-phase delivery slightly complicates tracing.
- Complexity: Medium
- Maintenance: Low

**2. Adapter-Level Agent Injection**

Pass `agentId` in `AdapterConfig`. Each adapter publishes directly to `relay.agent.{agentId}.*`.

- Pros: Simpler initially. Zero-latency resolution.
- Cons: Every adapter reimplements routing. Can't rebind at runtime. Breaks transport/routing separation. Harder to visualize.
- Complexity: Low initially, scales poorly
- Maintenance: High (per-adapter duplication)

**3. Relay Routing Rules Engine**

Full condition/action rules engine in RelayCore (like n8n's Switch node).

- Pros: Maximum flexibility, future-proof.
- Cons: Massive scope increase. Complex visual configuration. Overkill for 1:1 binding.
- Complexity: Very High
- Maintenance: High

**Recommendation:** Option 1 (Binding Table + Central BindingRouter). Industry-standard pattern used by OpenClaw, Microsoft Bot Framework, and Botpress. Threads the needle between simplicity and power. The binding table is visually representable as edges in the topology graph.

**Reference Architecture:** OpenClaw's binding resolution order (most-specific-first): `adapterId + chatId + channelType` > `adapterId + chatId` > `adapterId + channelType` > `adapterId` (wildcard) > no match (dead-letter).

**Key Research Sources:**

- OpenClaw multi-agent routing: https://docs.openclaw.ai/concepts/multi-agent
- React Flow + shadcn/ui: https://xyflow.com/blog/react-flow-components
- React Flow AI Workflow Editor template: https://reactflow.dev/ui/templates/ai-workflow-editor

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Architecture | Central BindingRouter service | Build routing once, all adapters get it for free. Proven by OpenClaw. Clean separation — adapters bridge protocols, router handles business logic. |
| 2 | Visual UX | Unified topology canvas with adapters as nodes | One canvas shows entire system — agents, adapters, connections. Leverages existing React Flow v12 + ELK layout. No separate view to learn. |
| 3 | Binding model | 1:1 binding with multi-instance support | Simplest mental model. Want 3 Telegram bots for 3 agents? Create 3 adapter instances. `multiInstance: true` already supported in adapter manifests. |
| 4 | Session strategy | Configurable per binding, default stateful | Each binding specifies `sessionStrategy: 'per-chat' | 'per-user' | 'stateless'`. Default: `per-chat` (auto-create persistent session per chat ID). Most intuitive for conversational agents. |
