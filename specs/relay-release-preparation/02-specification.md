---
slug: relay-release-preparation
number: 60
created: 2026-02-25
status: specified
---

# Specification: Relay & Mesh Release Preparation

**Status:** Specified
**Authors:** Claude Code, 2026-02-25
**Spec:** 60

---

## 1. Overview

Prepare DorkOS for its next release by completing all documentation, website updates, and package metadata for the Relay and Mesh subsystems. This is a documentation-and-configuration-only spec — no runtime code changes.

The work covers: user-facing MDX docs (guides, concepts), marketing website updates, SSE protocol additions, contributing guide expansion, README/CONTRIBUTING updates, CLI package metadata, blog post draft, and spec manifest cleanup.

## 2. Background / Problem Statement

Relay (inter-agent message bus) and Mesh (agent discovery/registry) are fully implemented on main. However:

- **Zero user-facing documentation** exists for either subsystem in `docs/`
- The marketing homepage still marks Pulse, Relay, and Mesh as `coming-soon`
- The SSE protocol docs don't cover Relay event types
- The README and CONTRIBUTING.md don't mention Relay or Mesh
- The CLI package keywords don't include relay/mesh terms
- Six specs in `specs/manifest.json` are still marked "specified" or "ideation" despite being implemented
- No blog post exists for the upcoming release

The CHANGELOG `[Unreleased]` section has already been backfilled and is up to date.

## 3. Goals

- Every Relay and Mesh feature is documented for end users
- The marketing homepage reflects current feature availability
- The SSE protocol reference covers all event types including Relay
- Contributors can understand the Relay/Mesh architecture from contributing docs
- The CLI npm package has discoverable keywords
- Spec manifest accurately reflects implementation status
- A blog post draft is ready for the release

## 4. Non-Goals

- Version bumping, git tagging, npm publish (handled by `/system:release`)
- Runtime code changes to Relay or Mesh
- Implementing Relay advanced reliability (spec 52, future work)
- Multi-region Mesh federation
- New Fumadocs sections (no new top-level nav entries — content goes under existing sections)

## 5. Technical Dependencies

- **Fumadocs MDX**: All docs use Fumadocs components (`Cards`, `Card`, `Callout`, `TypeTable`, `Steps`, `Tabs`)
- **meta.json navigation**: Each docs section uses `meta.json` to control page order
- **OpenAPI auto-generation**: `npm run docs:export-api` regenerates `docs/api/openapi.json` from Zod schemas

## 6. Detailed Design

### 6.1 Spec Manifest Cleanup

**File:** `specs/manifest.json`

Update statuses for implemented specs:

| Spec # | Slug                            | Current Status | New Status  |
| ------ | ------------------------------- | -------------- | ----------- |
| 51     | relay-server-client-integration | ideation       | implemented |
| 53     | relay-external-adapters         | specified      | implemented |
| 54     | mesh-core-library               | specified      | implemented |
| 56     | mesh-server-client-integration  | specified      | implemented |
| 58     | mesh-network-topology           | specified      | implemented |
| 59     | mesh-observability-lifecycle    | specified      | implemented |

Specs 50 and 57 are already `implemented`. Spec 52 (relay-advanced-reliability) stays `specified` — it's not fully implemented.

### 6.2 Homepage Module Status

**File:** `apps/web/src/layers/features/marketing/lib/modules.ts`

Change the `status` field for three modules:

- `pulse`: `'coming-soon'` → `'available'` (shipped in 0.3.0)
- `relay`: `'coming-soon'` → `'available'`
- `mesh`: `'coming-soon'` → `'available'`

### 6.3 Concept Pages

#### 6.3.1 Relay Concept

**File:** `docs/concepts/relay.mdx`

Frontmatter:

```yaml
title: Relay
description: How the subject-based pub/sub message bus works under the hood.
```

Sections:

1. **Architecture Overview** — RelayCore as in-process message router, subject-based routing with wildcards, subscriber registry with pattern matching
2. **Subject Hierarchy** — `relay.agent.{sessionId}`, `relay.human.console.{clientId}`, `relay.system.pulse.{scheduleId}`, `relay.external.{adapter}.{channel}`
3. **Message Envelopes** — Envelope schema (from relay-schemas.ts), budget fields (maxHops, maxReplies, ttlMs), metadata (traceId, parentId, timestamps)
4. **Adapter Architecture** — AdapterRegistry plugin system, adapter lifecycle (initialize, subscribe, publish, shutdown), built-in vs custom adapters
5. **Message Tracing** — SQLite trace store (message_traces table), span model (publish → route → deliver), metrics aggregation
6. **Convergence** — How Relay unifies session messaging and Pulse dispatch, fallback behavior when disabled

**Source material:** `plans/relay-specs/`, `packages/shared/src/relay-schemas.ts`, `apps/server/src/services/relay/`

#### 6.3.2 Mesh Concept

**File:** `docs/concepts/mesh.mdx`

Frontmatter:

```yaml
title: Mesh
description: Agent discovery, network topology, and coordination in DorkOS.
```

Sections:

1. **Architecture Overview** — MeshCore as agent registry and discovery engine, in-memory registry with SQLite persistence
2. **Agent Manifests** — Schema (from mesh-schemas.ts), required fields (name, capabilities), optional fields (subjects, healthEndpoint, metadata)
3. **Discovery Flow** — POST /discover → candidates presented → accept/deny → registry or denial list
4. **Network Topology** — Graph model (agents as nodes, message routes as edges), health overlays, topology types
5. **Health Monitoring** — Heartbeat protocol (POST /agents/:id/heartbeat), health states (healthy, degraded, unreachable), configurable intervals
6. **Lifecycle Events** — Event types (registered, deregistered, heartbeat, health_changed), event store, SSE streaming
7. **Access Control** — Denial records with reason tracking, subject-based access rules

**Source material:** `plans/mesh-specs/`, `packages/shared/src/mesh-schemas.ts`, `apps/server/src/services/mesh/`

#### 6.3.3 Update concepts/meta.json

Add `"relay"` and `"mesh"` to the pages array:

```json
{
  "title": "Concepts",
  "pages": ["architecture", "sessions", "transport", "relay", "mesh"]
}
```

### 6.4 User Guides

#### 6.4.1 Relay Messaging Guide

**File:** `docs/guides/relay-messaging.mdx`

Frontmatter:

```yaml
title: Relay Messaging
description: Send messages between agents, humans, and external systems using subject-based pub/sub.
```

Sections:

1. **What is Relay?** — Brief intro, link to concepts/relay for deep dive
2. **Enabling Relay** — Set `DORKOS_RELAY_ENABLED=true`, restart, Relay tab appears
3. **Sending Messages** — Via RelayPanel UI, REST API (POST /api/relay/messages), MCP tools (relay_send, relay_inbox)
4. **Built-in Adapters** — Claude Code (routes to agent sessions), Telegram (Bot API bridge), Webhook (HTTP callbacks)
5. **Message Tracing** — Using traceId, viewing traces in MessageTrace panel, metrics dashboard
6. **Relay + Pulse Integration** — When enabled, Pulse dispatches through Relay, session messaging routes through Relay
7. **Configuration Reference** — `DORKOS_RELAY_ENABLED`, adapter config in `~/.dork/config.json`, subject prefix conventions

#### 6.4.2 Agent Discovery Guide

**File:** `docs/guides/agent-discovery.mdx`

Frontmatter:

```yaml
title: Agent Discovery
description: Discover, register, and coordinate agents across your network with Mesh.
```

Sections:

1. **What is Mesh?** — Brief intro, link to concepts/mesh for deep dive
2. **Enabling Mesh** — Set `DORKOS_MESH_ENABLED=true`, restart, Mesh tab appears
3. **Discovering Agents** — POST /api/mesh/discover, CandidateCard UI, accept/deny flow
4. **Agent Manifests** — JSON format, required and optional fields, schema reference
5. **Registering Agents** — Via MeshPanel UI, REST API, MCP tools
6. **Network Topology** — TopologyGraph visualization, live health overlays, edge weights
7. **Health Monitoring** — Heartbeat-based checks, agent states, AgentHealthDetail drill-down
8. **Access Control** — Denial lists, POST /api/mesh/deny, auditing blocked agents
9. **Configuration Reference** — `DORKOS_MESH_ENABLED`, manifest format, health check intervals

#### 6.4.3 Relay Observability Guide

**File:** `docs/guides/relay-observability.mdx`

Frontmatter:

```yaml
title: Relay Observability
description: Monitor message delivery, trace failures, and understand Relay metrics.
```

Sections:

1. **Message Tracing** — How traces work, traceId propagation, span model
2. **Delivery Metrics Dashboard** — Reading the metrics UI, key indicators
3. **Debugging Failed Deliveries** — Dead letter queue, common failure modes, resolution steps
4. **Using MCP Tools** — `relay_get_trace`, `relay_get_metrics` for programmatic access

#### 6.4.4 Pulse Scheduler Guide

**File:** `docs/guides/pulse-scheduler.mdx`

Frontmatter:

```yaml
title: Pulse Scheduler
description: Autonomous cron-based agent jobs that work while you sleep.
```

Sections:

1. **What is Pulse?** — Cron scheduling for AI agents, autonomous execution
2. **Enabling Pulse** — `DORKOS_PULSE_ENABLED=true` (default), Pulse tab in sidebar
3. **Creating Schedules** — Via PulsePanel UI, REST API, MCP tools
4. **Cron Syntax** — Visual cron builder, presets, timezone selection
5. **Run History** — Viewing past runs, success/failure states, run details
6. **Pulse + Relay** — When Relay enabled, schedule dispatch routes through message bus
7. **Configuration** — Max concurrent runs, approval modes, schedule states

#### 6.4.5 Building Relay Adapters Guide

**File:** `docs/guides/building-relay-adapters.mdx`

Frontmatter:

```yaml
title: Building Relay Adapters
description: Create custom adapters to bridge external channels into the Relay message bus.
```

Sections:

1. **What is an Adapter?** — Bridges external systems into Relay's pub/sub
2. **Adapter Interface** — RelayAdapter type, required methods (id, name, subjectPatterns, start, stop, deliver)
3. **Built-in Adapters Reference** — Claude Code, Telegram, Webhook
4. **Creating a Custom Adapter** — Step-by-step walkthrough with code examples
5. **Plugin Loading** — Built-in, npm packages, local file paths, adapters.json config
6. **Configuration** — `~/.dork/relay/adapters.json` format, subject prefix conventions
7. **Testing Adapters** — Mock RelayCore patterns, integration testing

**Source material:** `contributing/relay-adapters.md` (22KB internal guide) — adapt key content for external audience.

#### 6.4.6 Agent Coordination Patterns Guide

**File:** `docs/guides/agent-coordination.mdx`

Frontmatter:

```yaml
title: Agent Coordination Patterns
description: Best practices for multi-agent workflows using Relay and Mesh.
```

Sections:

1. **Overview** — Why coordinate agents, when to use patterns
2. **Supervisor-Worker** — One agent dispatches tasks, collects results
3. **Peer-to-Peer** — Agents communicate directly via subjects
4. **Broadcast Coordination** — One-to-many messaging for announcements
5. **Budget Management** — Preventing runaway loops, setting appropriate limits

#### 6.4.7 Update guides/meta.json

Add new pages to the array:

```json
{
  "title": "Guides",
  "pages": [
    "cli-usage",
    "obsidian-plugin",
    "tool-approval",
    "slash-commands",
    "keyboard-shortcuts",
    "tunnel-setup",
    "relay-messaging",
    "agent-discovery",
    "pulse-scheduler",
    "relay-observability",
    "building-relay-adapters",
    "agent-coordination"
  ]
}
```

### 6.5 SSE Protocol Update

**File:** `docs/integrations/sse-protocol.mdx`

Add a new "Relay Events" section after the existing "Control Events" TypeTable:

```mdx
### Relay Events

When `DORKOS_RELAY_ENABLED` is true, the SSE stream includes additional event types:

<TypeTable
  type={{
    relay_message: {
      type: '{ streamEvent: StreamEvent, messageId: string }',
      description: 'Relay response chunk containing a nested StreamEvent from the message bus',
    },
    relay_receipt: {
      type: '{ messageId: string, traceId: string }',
      description: 'Delivery confirmation for a Relay-routed message',
    },
    message_delivered: {
      type: '{ messageId: string, subject: string }',
      description: 'Message delivery notification from the Relay transport',
    },
  }}
/>
```

Also add a note in the Session Sync Protocol section:

```mdx
<Callout type="info">
  When Relay is enabled, the SSE stream also carries `relay_message`, `relay_receipt`, and
  `message_delivered` events alongside standard sync events.
</Callout>
```

### 6.6 Documentation Landing Page

**File:** `docs/index.mdx`

Add Relay and Mesh cards to existing sections:

**In the "Guides" section**, add after the existing cards:

```mdx
<Card title="Relay Messaging" href="/docs/guides/relay-messaging">
  Send messages between agents via subject-based pub/sub.
</Card>
<Card title="Agent Discovery" href="/docs/guides/agent-discovery">
  Register, discover, and monitor agents with Mesh.
</Card>
<Card title="Pulse Scheduler" href="/docs/guides/pulse-scheduler">
  Autonomous cron-based agent jobs.
</Card>
```

**In the "Concepts" section**, add:

```mdx
<Card title="Relay" href="/docs/concepts/relay">
  The subject-based pub/sub message bus architecture.
</Card>
<Card title="Mesh" href="/docs/concepts/mesh">
  Agent discovery, registry, and network topology.
</Card>
```

**In the "Integrations" section**, add:

```mdx
<Card title="Building Relay Adapters" href="/docs/guides/building-relay-adapters">
  Create custom adapters for external channels.
</Card>
```

### 6.7 Configuration Guide Update

**File:** `docs/getting-started/configuration.mdx`

Add new sections for Relay and Mesh environment variables:

**Relay Configuration:**

- `DORKOS_RELAY_ENABLED` — Enable/disable Relay message bus (default: false)
- Adapter configuration in `~/.dork/config.json`
- Subject prefix conventions

**Mesh Configuration:**

- `DORKOS_MESH_ENABLED` — Enable/disable Mesh agent discovery (default: false)
- Agent manifest format
- Health check intervals

### 6.8 Contributing Guide Updates

#### 6.8.1 CONTRIBUTING.md

**File:** `CONTRIBUTING.md`

Updates:

1. Change "four apps" to "five apps" in the intro paragraph
2. Add `apps/roadmap` row to the monorepo structure table:
   ```
   | `apps/roadmap` | `@dorkos/roadmap` | Roadmap manager (Express + React 19 SPA) |
   ```
3. Add a "Subsystems" section after the monorepo table:

   ```markdown
   ### Subsystems

   DorkOS includes three optional subsystems that extend the core platform:

   | Subsystem | Enable                                | Description                  |
   | --------- | ------------------------------------- | ---------------------------- |
   | Pulse     | `DORKOS_PULSE_ENABLED=true` (default) | Cron-based agent scheduling  |
   | Relay     | `DORKOS_RELAY_ENABLED=true`           | Inter-agent message bus      |
   | Mesh      | `DORKOS_MESH_ENABLED=true`            | Agent discovery and registry |

   Server-side services live in `apps/server/src/services/`. Shared schemas in `packages/shared/src/` (`relay-schemas.ts`, `mesh-schemas.ts`). Client UI in `apps/client/src/layers/features/`.
   ```

#### 6.8.2 contributing/architecture.md

**File:** `contributing/architecture.md`

Add or expand these sections:

1. **Relay Subsystem** — Expand existing brief mention with:
   - RelayCore architecture and data flow
   - Service map: `relay-state.ts`, `trace-store.ts`, `adapter-manager.ts`
   - Route group: `routes/relay.ts` (14+ endpoints)
   - Client features: `features/relay/` (RelayPanel, ActivityFeed, MessageTrace, etc.)

2. **Mesh Subsystem** (new section):
   - MeshCore architecture
   - Service map: `mesh-state.ts`, `mesh/` directory
   - Route group: `routes/mesh.ts` (8+ endpoints)
   - Client features: `features/mesh/` (MeshPanel, TopologyGraph, AgentCard, etc.)

### 6.9 README Update

**File:** `README.md`

Updates:

1. Change the "What is DorkOS?" paragraph to mention multi-agent coordination:

   ```
   DorkOS gives Claude Code a browser-based chat UI with tool approval flows, slash command discovery, cross-client session synchronization, inter-agent messaging via Relay, and agent discovery via Mesh.
   ```

2. Add to the Features list:
   ```markdown
   - Relay message bus for inter-agent communication (subject-based pub/sub)
   - Mesh agent discovery with network topology visualization
   - Pulse scheduler for autonomous cron-based agent jobs
   ```

### 6.10 CLI Package Keywords

**File:** `packages/cli/package.json`

Add to the `keywords` array:

```json
"relay", "mesh", "agent-mesh", "pub-sub", "agent-discovery", "message-bus", "scheduler", "pulse"
```

### 6.11 Blog Post Draft

**File:** `blog/dorkos-[VERSION].mdx`

Use placeholder `[VERSION]` and `[DATE]` — filled in during `/system:release`.

Frontmatter:

```yaml
title: DorkOS [VERSION]
description: Relay message bus and Mesh agent discovery bring multi-agent coordination to DorkOS.
date: [DATE]
author: DorkOS Team
category: release
tags: [release, relay, mesh, messaging, agent-discovery, topology]
```

Content structure:

1. **Intro** — DorkOS [VERSION] introduces Relay and Mesh, transforming DorkOS into a multi-agent coordination platform
2. **Relay Message Bus** — Subject-based pub/sub, built-in adapters (Telegram, Webhook, Claude Code), message tracing, delivery metrics
3. **Mesh Agent Discovery** — Agent registry, network topology visualization, live health data, access control
4. **Relay Convergence** — Session messaging and Pulse dispatch via Relay transport
5. **All Changes** — Mirror CHANGELOG [Unreleased] content
6. **Install / Update** — `npm install -g dorkos@[VERSION]`

### 6.12 API Documentation Verification

Run `npm run docs:export-api` to regenerate the OpenAPI spec. Verify:

- All 14+ Relay endpoints appear (messages, endpoints, inbox, dead-letters, metrics, stream, traces)
- All 8+ Mesh endpoints appear (discover, agents CRUD, deny, denied, status, health, heartbeat)
- Request/response schemas match Zod definitions

If endpoints are missing, check that routes register with `openapi-registry.ts`.

## 7. User Experience

After implementation:

- New users visiting docs find Relay/Mesh guides in the sidebar navigation
- The docs landing page surfaces Relay, Mesh, and Pulse as primary features
- The marketing homepage shows all three subsystems as "available"
- The SSE protocol page documents all event types including Relay
- npm search for "relay", "mesh", "agent-discovery" surfaces the dorkos package

## 8. Testing Strategy

This spec involves documentation and configuration only — no runtime code changes. Testing consists of:

1. **Build verification**: `npm run build` succeeds (catches MDX syntax errors, broken imports)
2. **Typecheck**: `npm run typecheck` passes (catches TypeScript issues in modules.ts)
3. **Link verification**: All internal `href` links in MDX files point to valid pages
4. **OpenAPI export**: `npm run docs:export-api` completes without errors
5. **Dev server spot check**: `npm run dev --filter=@dorkos/web` renders new docs pages correctly

## 9. Performance Considerations

No runtime performance impact. Adding MDX pages to Fumadocs has negligible build time impact. The OpenAPI spec regeneration is a build-time-only operation.

## 10. Security Considerations

- Documentation should note that Relay adapter configs (Telegram bot tokens, webhook URLs) are sensitive and should not be committed to version control
- The blog post should not include real API keys or tokens in examples

## 11. Documentation

This spec IS the documentation effort. All files created/modified are documentation artifacts.

## 12. Implementation Phases

### Phase 1: Quick Wins (Spec Cleanup + Homepage)

- Update spec manifest statuses (6 specs)
- Update homepage module statuses (3 modules)
- Update CLI package keywords

### Phase 2: Concept Pages

- Write `docs/concepts/relay.mdx`
- Write `docs/concepts/mesh.mdx`
- Update `docs/concepts/meta.json`

### Phase 3: User Guides

- Write `docs/guides/relay-messaging.mdx`
- Write `docs/guides/agent-discovery.mdx`
- Write `docs/guides/pulse-scheduler.mdx`
- Write `docs/guides/relay-observability.mdx`
- Write `docs/guides/building-relay-adapters.mdx`
- Write `docs/guides/agent-coordination.mdx`
- Update `docs/guides/meta.json`

### Phase 4: Integration & Reference Updates

- Update `docs/integrations/sse-protocol.mdx` with Relay events
- Update `docs/index.mdx` landing page
- Update `docs/getting-started/configuration.mdx`
- Verify API docs: run `npm run docs:export-api`

### Phase 5: Contributing & README

- Update `CONTRIBUTING.md`
- Update `contributing/architecture.md`
- Update `README.md`

### Phase 6: Blog Post

- Write `blog/dorkos-[VERSION].mdx` draft

## 13. Open Questions

None — all decisions resolved during ideation and this spec workflow.

## 14. Related ADRs

No existing ADRs directly relate to documentation infrastructure. This spec does not introduce architectural decisions requiring ADRs.

## 15. References

- Ideation: `specs/relay-release-preparation/01-ideation.md`
- Relay planning docs: `plans/relay-specs/`
- Mesh planning docs: `plans/mesh-specs/`
- Existing adapter guide: `contributing/relay-adapters.md`
- Relay schemas: `packages/shared/src/relay-schemas.ts`
- Mesh schemas: `packages/shared/src/mesh-schemas.ts`
- Research: `research/20260225_post_feature_release_preparation.md`
- Fumadocs docs: https://fumadocs.dev
