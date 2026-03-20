# Task Breakdown: Relay & Mesh Release Preparation

**Spec:** `specs/relay-release-preparation/02-specification.md`
**Generated:** 2026-02-25
**Mode:** Full decomposition
**Total Tasks:** 8 (across 7 phases)

---

## Phase 1: Foundation

### Task 1.1 — Update spec manifest statuses, homepage module statuses, and CLI keywords

- **Size:** Small | **Priority:** High
- **Dependencies:** None

Three quick-win changes:

1. Update `specs/manifest.json` — change 6 specs (51, 53, 54, 56, 58, 59) from `ideation`/`specified` to `implemented`
2. Update `apps/web/src/layers/features/marketing/lib/modules.ts` — change `pulse`, `relay`, `mesh` status from `'coming-soon'` to `'available'`
3. Update `packages/cli/package.json` — add 8 keywords: `relay`, `mesh`, `agent-mesh`, `pub-sub`, `agent-discovery`, `message-bus`, `scheduler`, `pulse`

---

## Phase 2: Concept Pages

### Task 2.1 — Write Relay and Mesh concept pages and update concepts meta.json

- **Size:** Large | **Priority:** High
- **Dependencies:** 1.1

Create two new MDX files and update navigation:

- `docs/concepts/relay.mdx` — 6 sections: Architecture Overview, Subject Hierarchy, Message Envelopes, Adapter Architecture, Message Tracing, Convergence
- `docs/concepts/mesh.mdx` — 7 sections: Architecture Overview, Agent Manifests, Discovery Flow, Network Topology, Health Monitoring, Lifecycle Events, Access Control
- Update `docs/concepts/meta.json` — add `relay` and `mesh` to pages array

---

## Phase 3: User Guides

### Task 3.1 — Write Relay messaging and observability guides

- **Size:** Large | **Priority:** High
- **Dependencies:** 2.1 | **Parallel with:** 3.2, 3.3

- `docs/guides/relay-messaging.mdx` — 7 sections: What is Relay, Enabling Relay, Sending Messages, Built-in Adapters, Message Tracing, Relay + Pulse Integration, Configuration Reference
- `docs/guides/relay-observability.mdx` — 4 sections: Message Tracing, Delivery Metrics Dashboard, Debugging Failed Deliveries, Using MCP Tools

### Task 3.2 — Write Agent Discovery and Pulse Scheduler guides

- **Size:** Large | **Priority:** High
- **Dependencies:** 2.1 | **Parallel with:** 3.1, 3.3

- `docs/guides/agent-discovery.mdx` — 9 sections: What is Mesh, Enabling Mesh, Discovering Agents, Agent Manifests, Registering Agents, Network Topology, Health Monitoring, Access Control, Configuration Reference
- `docs/guides/pulse-scheduler.mdx` — 7 sections: What is Pulse, Enabling Pulse, Creating Schedules, Cron Syntax, Run History, Pulse + Relay, Configuration

### Task 3.3 — Write Building Relay Adapters and Agent Coordination guides

- **Size:** Large | **Priority:** High
- **Dependencies:** 2.1 | **Parallel with:** 3.1, 3.2

- `docs/guides/building-relay-adapters.mdx` — 7 sections: What is an Adapter, Adapter Interface, Built-in Adapters Reference, Creating a Custom Adapter, Plugin Loading, Configuration, Testing Adapters
- `docs/guides/agent-coordination.mdx` — 5 sections: Overview, Supervisor-Worker, Peer-to-Peer, Broadcast Coordination, Budget Management
- Update `docs/guides/meta.json` — add 6 new guide slugs

---

## Phase 4: Integration Updates

### Task 4.1 — Update SSE protocol docs, docs landing page, and configuration guide

- **Size:** Medium | **Priority:** High
- **Dependencies:** 3.1, 3.2, 3.3

- `docs/integrations/sse-protocol.mdx` — add Relay Events TypeTable and Callout note
- `docs/index.mdx` — add 6 new Card components (3 guides, 2 concepts, 1 integration)
- `docs/getting-started/configuration.mdx` — add Relay and Mesh env var sections

---

## Phase 5: Project Files

### Task 5.1 — Update README, CONTRIBUTING, and contributing/architecture docs

- **Size:** Medium | **Priority:** Medium
- **Dependencies:** 1.1 | **Parallel with:** 6.1

- `README.md` — update intro paragraph and features list
- `CONTRIBUTING.md` — change "four apps" to "five apps", add roadmap row, add Subsystems section
- `contributing/architecture.md` — add/expand Relay and Mesh subsystem sections

---

## Phase 6: Marketing

### Task 6.1 — Write release blog post draft

- **Size:** Medium | **Priority:** Medium
- **Dependencies:** 1.1 | **Parallel with:** 5.1

- `blog/dorkos-VERSION.mdx` — 6 sections: Intro, Relay Message Bus, Mesh Agent Discovery, Relay Convergence, All Changes (placeholder), Install/Update

---

## Phase 7: Verification

### Task 7.1 — Verify API docs export and cross-link integrity

- **Size:** Medium | **Priority:** High
- **Dependencies:** 4.1, 5.1, 6.1

- Run `npm run docs:export-api` and verify Relay/Mesh endpoints appear
- Check all cross-links in new MDX files point to valid pages
- Run `npm run build` and `npm run typecheck`
- Verify meta.json consistency

---

## Dependency Graph

```
1.1 (Foundation)
 ├── 2.1 (Concept Pages)
 │    ├── 3.1 (Relay guides)     ─┐
 │    ├── 3.2 (Mesh/Pulse guides) ├── 4.1 (Integration updates)
 │    └── 3.3 (Adapter guides)   ─┘         │
 ├── 5.1 (Project files) ──────────────────── ├── 7.1 (Verification)
 └── 6.1 (Blog post) ─────────────────────── ┘
```

## Parallelization Opportunities

- **Phase 3** tasks (3.1, 3.2, 3.3) can all run in parallel
- **Phase 5** (5.1) and **Phase 6** (6.1) can run in parallel
