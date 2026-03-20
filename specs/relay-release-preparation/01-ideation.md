---
slug: relay-release-preparation
number: 60
created: 2026-02-25
status: ideation
---

# Relay & Mesh Release Preparation

**Slug:** relay-release-preparation
**Author:** Claude Code
**Date:** 2026-02-25
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Relay and Mesh implementation is complete on main. Before release, we need comprehensive documentation, website updates, and package publishing preparation. This ideation audits all gaps and provides detailed implementation plans for each.
- **Assumptions:**
  - All Relay/Mesh code is merged to main and working
  - Version bumping will be handled separately via `/system:release`
  - The `docs/` directory uses Fumadocs MDX format
  - The marketing site (`apps/web`) is deployed to Vercel
  - The CLI package (`packages/cli`) is the sole npm-published artifact
- **Out of scope:**
  - Version bumping (deferred to `/system:release`)
  - Implementing Relay advanced reliability (spec 52, future work)
  - Multi-region Mesh federation (future work)
  - Changesets adoption (future tooling improvement)

## 2) Pre-reading Log

- `docs/meta.json`: Top-level nav has 8 sections — no Relay/Mesh
- `docs/concepts/meta.json`: Only architecture, sessions, transport — no Relay/Mesh
- `docs/guides/meta.json`: 7 guides — no Relay/Mesh
- `docs/index.mdx`: Landing page cards — zero Relay/Mesh mentions
- `docs/changelog.mdx`: Only goes to v0.3.0, no unreleased section
- `CHANGELOG.md`: Unreleased section is completely empty
- `blog/dorkos-0-3-0.mdx`: Latest blog post covers Pulse, no Relay/Mesh
- `apps/web/src/layers/features/marketing/lib/modules.ts`: Pulse, Relay, Mesh all marked `coming-soon`
- `packages/shared/package.json`: Exports `relay-schemas` and `mesh-schemas` correctly
- `packages/cli/package.json`: Version 0.3.0, keywords don't mention relay/mesh
- `CONTRIBUTING.md`: Lists 4 apps, no mention of Relay/Mesh subsystems
- `contributing/relay-adapters.md`: Comprehensive adapter developer guide exists (22KB)
- `contributing/architecture.md`: Mentions Relay subsystem briefly, no Mesh section
- `apps/server/src/routes/relay.ts`: 14+ endpoints implemented
- `apps/server/src/routes/mesh.ts`: 8+ endpoints implemented
- `specs/manifest.json`: Several Relay/Mesh specs still marked "specified" despite being implemented
- `plans/relay-specs/`: 7 planning docs with comprehensive design details
- `plans/mesh-specs/`: 5 planning docs with comprehensive design details

## 3) Codebase Map

- **Primary areas needing updates:**
  - `docs/` — User-facing MDX documentation (Fumadocs)
  - `docs/concepts/meta.json` — Navigation config for concepts section
  - `docs/guides/meta.json` — Navigation config for guides section
  - `docs/index.mdx` — Documentation landing page
  - `blog/` — Release blog posts
  - `CHANGELOG.md` — Root changelog
  - `docs/changelog.mdx` — Website changelog
  - `apps/web/src/layers/features/marketing/lib/modules.ts` — Module status flags
  - `CONTRIBUTING.md` — Contributor guide
  - `contributing/architecture.md` — Internal architecture docs
  - `specs/manifest.json` — Spec status tracking
  - `packages/cli/package.json` — npm keywords

- **Source material for docs:**
  - `plans/relay-specs/` — 7 detailed design docs
  - `plans/mesh-specs/` — 5 detailed design docs
  - `contributing/relay-adapters.md` — Existing adapter guide
  - `packages/shared/src/relay-schemas.ts` — Zod schemas (12.6KB)
  - `packages/shared/src/mesh-schemas.ts` — Zod schemas (8KB)
  - `apps/server/src/routes/relay.ts` — Route implementations
  - `apps/server/src/routes/mesh.ts` — Route implementations
  - `apps/server/src/services/relay/` — Relay service internals
  - `apps/server/src/services/mesh/` — Mesh service internals
  - `apps/client/src/layers/features/relay/` — Client UI components
  - `apps/client/src/layers/features/mesh/` — Client UI components

- **Data flow:** Planning docs + source code -> MDX docs -> Fumadocs -> Website

- **Feature flags:** `DORKOS_RELAY_ENABLED`, `DORKOS_MESH_ENABLED`

- **Potential blast radius:** Documentation and marketing only — no code changes to core functionality

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

### Potential Solutions

**1. Comprehensive Documentation First**

- Description: Write all docs before any release activities
- Pros: Users have full reference material on day one
- Cons: Delays release, large writing effort
- Complexity: High
- Maintenance: Low (docs are stable once written)

**2. Ship Fast, Docs Later**

- Description: Minimal changelog + blog, fill docs incrementally
- Pros: Fastest path to release
- Cons: Users discover features without guidance, support burden
- Complexity: Low
- Maintenance: High (ongoing doc debt)

**3. Tiered Documentation Approach (Selected)**

- Description: Comprehensive docs organized by priority tier, all completed before release
- Pros: Full coverage, organized work, nothing slips through
- Cons: More upfront work than minimal approach
- Complexity: Medium
- Maintenance: Low

### Security Considerations

- No new secrets or credentials involved
- Docs should note that Relay adapter configs (Telegram tokens, webhook URLs) are sensitive

### Performance Considerations

- OpenAPI spec regeneration is needed — `npm run docs:export-api`
- Fumadocs nav changes require no rebuild (meta.json only)

### Recommendation

**Recommended Approach:** Tiered documentation with full implementation plans. The planning docs in `plans/relay-specs/` and `plans/mesh-specs/` provide excellent source material that can be adapted into user-facing docs. The research agent identified the Diataxis framework as best practice for structuring docs (tutorials, how-to guides, concepts, reference).

## 6) Decisions

| #   | Decision            | Choice                     | Rationale                                                                        |
| --- | ------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| 1   | Version number      | Defer to `/system:release` | The release command handles version bumps, git tags, and npm publish in one flow |
| 2   | Documentation scope | Comprehensive              | All guides, concepts, API docs, integration guide, contributing updates, README  |
| 3   | Spec cleanup        | Update to 'implemented'    | Keeps project tracking accurate for specs 50-59                                  |
| 4   | Ideation scope      | Full implementation plans  | Each item gets detailed file paths, content outlines, and draft structures       |

---

## 7) Implementation Plans

### Tier 1: CRITICAL — Must complete before release

---

#### 1.1 CHANGELOG Updates

**Files:**

- `CHANGELOG.md` (root)
- `docs/changelog.mdx`

**Plan:**
Both files should contain identical content for the new release section. Add an `[Unreleased]` section (or the version number if bumped) with the following structure:

```
### Added
- Relay message bus for inter-agent communication
  - Subject-based pub/sub architecture (NATS-inspired)
  - Budget envelopes to prevent message loop runaway
  - Message tracing with SQLite persistence and delivery metrics
  - Built-in adapters: Telegram, Webhook, Claude Code runtime
  - REST API (14+ endpoints) and MCP tools
  - Client UI: RelayPanel, ActivityFeed, MessageTrace, DeliveryMetrics

- Mesh agent discovery and network topology
  - Agent registry with manifest-based discovery
  - Network topology visualization with live health data
  - Agent health monitoring via heartbeats
  - Lifecycle event tracking (register, deregister, heartbeat)
  - Access control rules with denial lists
  - REST API (8+ endpoints) and MCP tools
  - Client UI: MeshPanel, TopologyGraph, AgentCard, AgentHealthDetail

- Relay Convergence: Session messaging and Pulse dispatch via Relay transport
  - Relay-backed session messaging with receipt and tracing
  - Pulse schedule execution dispatched through Relay
  - Seamless fallback when Relay is disabled

### Changed
- Session messaging supports Relay-backed transport when DORKOS_RELAY_ENABLED=true
- Pulse scheduler dispatches jobs through Relay when enabled
- Config schema expanded for Relay adapter configuration

### Fixed
- Support array subjectPrefix in Relay adapter context builder
- Fix mesh topology type mismatches in health aggregation
- Wire live health data into topology graph correctly
- Fix aggregate SQL boundary conditions for mesh agent counts
```

---

#### 1.2 User Guide: Relay Messaging

**File:** `docs/guides/relay-messaging.mdx`

**Content outline (~2000 words):**

```
---
title: Relay Messaging
description: Send messages between agents, humans, and external systems using subject-based pub/sub.
---

# Relay Messaging

## What is Relay?
- Inter-agent message bus built into DorkOS
- Subject-based pub/sub (inspired by NATS)
- Connects agents, humans, and external channels (Telegram, webhooks)

## Enabling Relay
- Set DORKOS_RELAY_ENABLED=true in .env
- Restart server
- Relay tab appears in sidebar

## Core Concepts (brief, link to concepts/relay)
- Subjects: hierarchical routing keys (e.g., relay.agent.{sessionId})
- Envelopes: message wrappers with metadata, budget, and payload
- Budget envelopes: prevent runaway message loops (maxHops, maxReplies, ttlMs)
- Adapters: bridge external channels into the Relay bus

## Sending Messages
- Via the RelayPanel UI
- Via REST API: POST /api/relay/messages
- Via MCP tools: relay_send, relay_inbox

## Built-in Adapters
- Claude Code: Routes messages to/from agent sessions
- Telegram: Bridge a Telegram bot into the Relay bus
- Webhook: HTTP POST/GET callbacks for integrations

## Message Tracing
- Every message gets a traceId
- View delivery traces in the MessageTrace panel
- Metrics dashboard shows delivery rates and latency

## Relay + Pulse Integration
- When Relay is enabled, Pulse dispatches jobs through Relay
- Session messaging routes through Relay pub/sub
- Full observability across both systems

## Configuration Reference
- DORKOS_RELAY_ENABLED
- Adapter config in ~/.dork/config.json
- Subject prefix conventions
```

**Also update:** `docs/guides/meta.json` — add `"relay-messaging"` to the pages array.

---

#### 1.3 User Guide: Agent Discovery (Mesh)

**File:** `docs/guides/agent-discovery.mdx`

**Content outline (~2000 words):**

```
---
title: Agent Discovery
description: Discover, register, and coordinate agents across your network with Mesh.
---

# Agent Discovery

## What is Mesh?
- Agent registry and discovery system
- Network topology visualization
- Health monitoring and lifecycle tracking

## Enabling Mesh
- Set DORKOS_MESH_ENABLED=true in .env
- Restart server
- Mesh tab appears in sidebar

## Discovering Agents
- POST /api/mesh/discover scans for agents
- CandidateCard UI for reviewing discovered agents
- Accept or deny agents from the discovery panel

## Agent Manifests
- JSON manifest format: name, description, capabilities, subjects
- How DorkOS agents advertise themselves
- Manifest schema reference

## Registering Agents
- Via MeshPanel UI
- Via REST API: POST /api/mesh/agents
- Via MCP tools: mesh_register, mesh_discover

## Network Topology
- TopologyGraph visualizes agent connections
- Live health data overlays (green/yellow/red)
- Edge weights show message frequency

## Health Monitoring
- Heartbeat-based health checks
- Agent states: healthy, degraded, unreachable
- AgentHealthDetail panel for drill-down

## Access Control
- Denial lists prevent unwanted agents
- Access rules for subject-based filtering
- POST /api/mesh/deny to block agents

## Configuration Reference
- DORKOS_MESH_ENABLED
- Agent manifest format
- Health check intervals
```

**Also update:** `docs/guides/meta.json` — add `"agent-discovery"` to the pages array.

---

#### 1.4 Concept: Relay Architecture

**File:** `docs/concepts/relay.mdx`

**Content outline (~1000 words):**

```
---
title: Relay
description: How the subject-based pub/sub message bus works under the hood.
---

# Relay

## Architecture Overview
- RelayCore: in-process message router
- Subject-based routing with wildcards
- Subscriber registry with pattern matching

## Subject Hierarchy
- relay.agent.{sessionId} — agent sessions
- relay.human.console.{clientId} — human clients
- relay.system.pulse.{scheduleId} — scheduler dispatch
- relay.external.{adapter}.{channel} — external adapters

## Message Envelopes
- Envelope schema (from relay-schemas.ts)
- Budget fields: maxHops, maxReplies, ttlMs
- Metadata: traceId, parentId, timestamps

## Adapter Architecture
- AdapterRegistry: plugin system for external channels
- Adapter lifecycle: initialize, subscribe, publish, shutdown
- Built-in adapters vs custom adapters

## Message Tracing
- SQLite trace store (message_traces table)
- Span model: publish -> route -> deliver
- Metrics aggregation (delivery rate, latency)

## Convergence
- How Relay unifies session messaging and Pulse dispatch
- Fallback behavior when Relay is disabled
```

**Also update:** `docs/concepts/meta.json` — add `"relay"` to the pages array.

---

#### 1.5 Concept: Mesh

**File:** `docs/concepts/mesh.mdx`

**Content outline (~1000 words):**

```
---
title: Mesh
description: Agent discovery, network topology, and coordination in DorkOS.
---

# Mesh

## Architecture Overview
- MeshCore: agent registry and discovery engine
- In-memory registry with SQLite persistence
- Network topology calculation

## Agent Manifests
- Manifest schema (from mesh-schemas.ts)
- Required fields: name, capabilities
- Optional: subjects, healthEndpoint, metadata

## Discovery Flow
1. POST /discover triggers scan
2. Candidates presented for review
3. Accept -> registered in registry
4. Deny -> added to denial list

## Network Topology
- Graph model: agents as nodes, message routes as edges
- Health overlays: aggregate from heartbeat data
- Topology types and visualization

## Health Monitoring
- Heartbeat protocol: POST /agents/:id/heartbeat
- Health states: healthy, degraded, unreachable
- Configurable check intervals and thresholds

## Lifecycle Events
- Event types: registered, deregistered, heartbeat, health_changed
- Event store for audit trail
- SSE streaming for real-time updates

## Access Control
- Denial records with reason tracking
- Subject-based access rules
- GET /denied to audit blocked agents
```

**Also update:** `docs/concepts/meta.json` — add `"mesh"` to the pages array.

---

#### 1.6 Blog Post: Release Announcement

**File:** `blog/dorkos-0-4-0.mdx`

**Content outline (~1200 words):**

```
---
title: DorkOS 0.4.0
description: Relay message bus and Mesh agent discovery bring multi-agent coordination to DorkOS.
date: [RELEASE_DATE]
author: DorkOS Team
category: release
tags: [release, relay, mesh, messaging, agent-discovery, topology]
---

DorkOS 0.4.0 introduces two major subsystems: Relay and Mesh. Together, they
transform DorkOS from a single-agent interface into a multi-agent coordination
platform.

## Highlights

**Relay Message Bus** — Subject-based pub/sub messaging for agents, humans,
and external channels. Built-in adapters for Telegram, webhooks, and Claude Code
runtime. Full message tracing and delivery metrics.

**Mesh Agent Discovery** — Register, discover, and monitor agents across your
network. Network topology visualization with live health data. Access control
via denial lists.

**Relay Convergence** — Session messaging and Pulse scheduler dispatch now
route through Relay when enabled, providing unified observability.

## All Changes
[Mirror CHANGELOG content]

## Install / Update
npm install -g dorkos@0.4.0
```

---

#### 1.7 Homepage Module Status Fix

**File:** `apps/web/src/layers/features/marketing/lib/modules.ts`

**Change:** Update status fields:

- `pulse`: `'coming-soon'` -> `'available'` (shipped in 0.3.0)
- `relay`: `'coming-soon'` -> `'available'`
- `mesh`: `'coming-soon'` -> `'available'`

---

### Tier 2: HIGH — Should complete before release

---

#### 2.1 API Documentation

**Approach:** The OpenAPI spec is auto-generated from Zod schemas via `npm run docs:export-api`. Verify that all Relay/Mesh endpoints appear in the generated spec.

**Steps:**

1. Run `npm run docs:export-api` to regenerate `docs/api/openapi.json`
2. Verify Relay endpoints (14+) appear in the spec
3. Verify Mesh endpoints (8+) appear in the spec
4. If any are missing, check that the routes register with `openapi-registry.ts`

**Note:** The OpenAPI spec is gitignored and generated at build time for the website. If routes properly use Zod validation, they should auto-appear.

---

#### 2.2 Documentation Landing Page

**File:** `docs/index.mdx`

**Changes:**

- Add a "Features" section with Relay and Mesh cards:

```mdx
## Features

<Cards>
  <Card title="Relay Messaging" href="/docs/guides/relay-messaging">
    Subject-based pub/sub for inter-agent communication and external channels.
  </Card>
  <Card title="Agent Discovery" href="/docs/guides/agent-discovery">
    Register, discover, and monitor agents with Mesh.
  </Card>
  <Card title="Pulse Scheduler" href="/docs/guides/pulse-scheduler">
    Autonomous cron-based agent jobs.
  </Card>
</Cards>
```

- Add Relay/Mesh to the Concepts section cards
- Add Relay adapters to the Integrations section cards

---

#### 2.3 Integration Guide: Building Relay Adapters

**File:** `docs/integrations/relay-adapters.mdx`

**Content outline (~1500 words):**

```
---
title: Building Relay Adapters
description: Create custom adapters to bridge external channels into the Relay message bus.
---

# Building Relay Adapters

## What is an Adapter?
- Bridges external systems into Relay's subject-based pub/sub
- Examples: Telegram, Slack, Discord, webhooks, email

## Adapter Interface
- AdapterConfig type
- Required methods: initialize, subscribe, publish, shutdown
- Lifecycle hooks

## Built-in Adapters Reference
- Claude Code Adapter: routes to/from agent sessions
- Telegram Adapter: Telegram Bot API bridge
- Webhook Adapter: HTTP POST/GET callbacks

## Creating a Custom Adapter
- Step-by-step walkthrough
- Register with AdapterRegistry
- Handle incoming messages (external -> Relay)
- Handle outgoing messages (Relay -> external)
- Error handling and retry patterns

## Configuration
- Adapter config in ~/.dork/config.json
- Subject prefix conventions
- Budget settings for external adapters

## Testing Adapters
- Mock RelayCore for unit tests
- Integration test patterns
```

**Source material:** `contributing/relay-adapters.md` (22KB internal guide) — adapt for external audience.

**Also update:** `docs/integrations/meta.json` — add `"relay-adapters"` to the pages array.

---

#### 2.4 SSE Protocol Update

**File:** `docs/integrations/sse-protocol.mdx`

**Changes:** Add the new Relay event types to the SSE protocol documentation:

- `relay_message` — Relay response chunk containing a nested StreamEvent
- `relay_receipt` — Delivery confirmation for a Relay message
- `message_delivered` — Message delivery notification

---

#### 2.5 Contributing Guide Updates

**Files:**

- `CONTRIBUTING.md` — Add Relay/Mesh to monorepo structure table, mention new packages
- `contributing/architecture.md` — Expand Relay section, add dedicated Mesh section

**CONTRIBUTING.md changes:**

- Add `packages/relay` and `packages/mesh` to the monorepo structure table
- Mention `DORKOS_RELAY_ENABLED` and `DORKOS_MESH_ENABLED` env vars
- Reference new Relay/Mesh docs

**contributing/architecture.md changes:**

- Expand the Relay subsystem section with data flow diagrams
- Add a new Mesh subsystem section covering:
  - MeshCore architecture
  - Agent registry internals
  - Topology calculation
  - Health monitoring system
  - Access control enforcement

---

#### 2.6 README Update

**File:** `README.md` (root)

**Changes:**

- Add Relay and Mesh to the feature list
- Mention `DORKOS_RELAY_ENABLED` and `DORKOS_MESH_ENABLED`
- Update the "What is DorkOS?" description to mention multi-agent coordination

---

#### 2.7 CLI Package Keywords

**File:** `packages/cli/package.json`

**Changes:** Add to keywords array:

- `"relay"`, `"mesh"`, `"agent-mesh"`, `"pub-sub"`, `"agent-discovery"`, `"message-bus"`

---

### Tier 3: MEDIUM — Nice to have, can follow release

---

#### 3.1 Relay Observability Guide

**File:** `docs/guides/relay-observability.mdx`

- How to read message traces
- Understanding delivery metrics
- Debugging failed deliveries
- Using the MessageTrace and DeliveryMetrics UI

#### 3.2 Pulse Scheduler Guide

**File:** `docs/guides/pulse-scheduler.mdx`

- Was missing since 0.3.0, should be created
- How to create/manage schedules
- Cron syntax reference
- Run history and observability

#### 3.3 Agent Coordination Patterns

**File:** `docs/guides/agent-coordination.mdx`

- Best practices for multi-agent workflows
- Pattern: supervisor-worker
- Pattern: peer-to-peer messaging
- Pattern: broadcast coordination

#### 3.4 Configuration Guide Update

**File:** `docs/getting-started/configuration.mdx`

- Add Relay and Mesh configuration sections
- Document all new env vars
- Document adapter config in ~/.dork/config.json

---

### Tier 4: Spec Cleanup

**File:** `specs/manifest.json`

**Update the following spec statuses to `"implemented"`:**

| Spec # | Slug                            | Current Status | New Status                     |
| ------ | ------------------------------- | -------------- | ------------------------------ |
| 50     | relay-core-library              | implemented    | (already correct)              |
| 51     | relay-server-client-integration | ideation       | implemented                    |
| 52     | relay-advanced-reliability      | specified      | (keep — not fully implemented) |
| 53     | relay-external-adapters         | specified      | implemented                    |
| 54     | mesh-core-library               | specified      | implemented                    |
| 56     | mesh-server-client-integration  | specified      | implemented                    |
| 57     | relay-runtime-adapters          | implemented    | (already correct)              |
| 58     | mesh-network-topology           | specified      | implemented                    |
| 59     | mesh-observability-lifecycle    | specified      | implemented                    |

---

## 8) Work Estimate

| Tier              | Items                                                                                          | Est. Effort     |
| ----------------- | ---------------------------------------------------------------------------------------------- | --------------- |
| Tier 1 (Critical) | 7 items: CHANGELOG, 2 guides, 2 concepts, blog post, homepage fix                              | 8-12 hours      |
| Tier 2 (High)     | 7 items: API docs, landing page, integration guide, SSE update, contributing, README, keywords | 6-10 hours      |
| Tier 3 (Medium)   | 4 items: observability guide, Pulse guide, coordination patterns, config update                | 4-6 hours       |
| Tier 4 (Cleanup)  | 1 item: spec manifest updates                                                                  | 15 minutes      |
| **Total**         | **19 items**                                                                                   | **18-28 hours** |

## 9) Recommended Execution Order

1. Spec manifest cleanup (Tier 4) — quick win, do first
2. CHANGELOG updates (Tier 1.1) — captures all changes while fresh
3. Homepage module status fix (Tier 1.7) — one-line changes
4. Concept pages (Tier 1.4, 1.5) — establish vocabulary before guides
5. User guides (Tier 1.2, 1.3) — reference concepts, most user-facing value
6. API docs verification (Tier 2.1) — run export, verify coverage
7. Documentation landing page (Tier 2.2) — surfaces new content
8. Integration guide (Tier 2.3) — adapts existing internal docs
9. Contributing/README/SSE updates (Tier 2.4-2.6) — incremental updates
10. Blog post (Tier 1.6) — write last, references all other docs
11. CLI keywords (Tier 2.7) — quick, do alongside version bump
12. Tier 3 items — post-release or as time allows
