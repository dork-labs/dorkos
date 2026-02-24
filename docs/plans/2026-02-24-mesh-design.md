---
title: Mesh Design
description: Design working document for DorkOS Mesh — agent discovery and network topology.
---

# DorkOS Mesh — Design Working Document

**Date:** 2026-02-24
**Status:** In Progress — Brainstorming Phase (paused, designing Relay first)
**Author:** Dorian Collier + Claude

---

## Overview

Mesh is the agent discovery and network topology layer for DorkOS. It discovers agents, manages their identities and capabilities, and configures Relay's routing for the agent network.

**Core mental model:** Every project directory is an agent. Mesh makes these agents aware of each other. Relay handles the actual message delivery.

---

## Architectural Decision: Module Separation (Relay / Mesh / Pulse)

**Decision:** Messaging infrastructure belongs in Relay, not Mesh. The three modules have distinct responsibilities:

| Module | Role | OS Analog |
|---|---|---|
| **Relay** | Universal message bus — inboxes, outboxes, delivery for ALL endpoints (agent↔agent, human↔agent, external↔agent) | Kernel IPC (D-Bus, Mach ports) |
| **Mesh** | Agent discovery + network topology + configures Relay routing for the agent network | Service discovery + network config (DNS + iptables) |
| **Pulse** | Scheduled tasks/prompts, dispatches messages via Relay at designated times | cron / systemd timers |

**Why this is better than Mesh owning messaging:**
- One message format everywhere (agent-to-agent and human-to-agent use the same envelope)
- Correct dependency direction: Mesh → Relay, Pulse → Relay (no circular deps)
- Relay can exist without Mesh (ship human↔agent messaging first, add agent network later)
- Each module is independently useful with a single clear responsibility

**What moves from Mesh to Relay:**
- Maildir + SQLite message storage → Relay
- Message envelope schema + budget fields → defined by Relay, policies configured by Mesh
- Dead letter queue, retries, rate limiting → Relay (delivery infrastructure)
- Circuit breakers → Relay (per-endpoint delivery safety)

**What stays in Mesh:**
- Agent discovery (filesystem scanning for `.dork/agent.json`, `.claude/` fallback)
- Network topology (who can talk to who)
- Access control rules (Mesh writes them, Relay enforces them)
- Agent lifecycle management

**Design sequencing:** Relay first (foundation), then Mesh on top. See `docs/plans/2026-02-24-relay-design.md`.

**Package architecture:** Each module is a separate npm package composed by the server:
- `@dorkos/relay` — message bus (foundation)
- `@dorkos/mesh` — agent discovery + topology
- `@dorkos/pulse` — scheduling (extracted from `apps/server`)

---

## Decisions Made

### 1. Primary Use Case: Project-as-Agent Coordination

The primary use case is projects discovering each other and coordinating autonomously. This should work identically whether triggered by a human or by Pulse (trigger-agnostic). Within-project agent teams are a special case of the same primitive.

**Example:** Scheduling project detects a birthday → messages finance project for a budget → finance project approves $50 → purchasing project orders flowers.

### 2. Discovery Mechanism: Filesystem Convention Scanning

- **Primary:** Scan for `.dork/agent.json` — full DorkOS agent manifest (any runtime)
- **Fallback:** Scan for `.claude/` directory — infer basic agent from `CLAUDE.md` (zero-config for existing Claude Code projects)
- DorkOS files live in `.dork/`, NOT `.claude/` (agent-agnostic principle — `.claude/` is Claude Code specific)
- Rich metadata via `.dork/agent.json` manifest
- chokidar watches for new/changed agents (DorkOS already uses this pattern)
- User configures scan roots (e.g., `~/projects/`, `~/work/`)

### 3. Communication Transport: Hybrid Maildir + SQLite Index (→ Relay)

> **Note:** This decision now applies to Relay's transport layer, not Mesh directly. Mesh will use Relay's APIs.

- **Maildir** for message storage (source of truth)
- **SQLite** for indexing and queries (derived, rebuildable)
- Files are agent-native: agents can `ls`, `cat`, `Glob`, `Read` their mailbox
- SQLite provides fast structured queries for rate limiting, budget tracking, history
- If index corrupts, rebuild from files (single source of truth principle)
- Aligns with DorkOS's existing pattern: JSONL files as truth, programmatic reading on top

---

## Decisions Pending

### 4. Agent Manifest Format (`.dork/agent.json`)

How should `.dork/agent.json` be structured? Draft schema:

```json
{
  "$schema": "https://dorkos.dev/schemas/agent.json",
  "id": "my-backend",
  "name": "Backend API Agent",
  "description": "Manages the Express API server",
  "runtime": "claude-code",
  "capabilities": ["code", "test", "deploy"],
  "skills": ["api-development", "database-management"],
  "behavior": {
    "groups": "mentions-only",
    "dm": "always-respond"
  },
  "budget": {
    "maxHops": 3,
    "maxCallsPerHour": 10
  }
}
```

Key questions still open:
- Should it align with A2A Agent Card format (Google/Linux Foundation standard)?
- How are capabilities/skills declared? Freeform strings or a defined vocabulary?
- Should `runtime` be a required field? (Claude Code is the default)
- How does behavior policy interact with adapter-level filtering?
- Should the manifest include response instructions that adapters inject into messages?

### 5. Payload Schema (StandardPayload + Mesh fields)

> **Resolved:** Relay owns the envelope (routing + budget). All DorkOS components use `StandardPayload` (defined in `@dorkos/shared`) for the payload content. Mesh-specific fields (performatives, conversation tracking) are part of `StandardPayload`.

Agent-to-agent messages use `StandardPayload` with these Mesh-specific fields populated:
- `performative`: request, inform, query, answer, delegate, result, failure, cancel
- `conversationId`: groups messages in a multi-agent conversation
- `correlationId`: links a response to its request

All messages (agent-to-agent, human-to-agent, Pulse dispatches) share the same `StandardPayload` structure. Common fields like `content`, `senderName`, `attachments`, `responseContext` are standardized to prevent "lost in translation" between platforms.

See Relay design doc for the full `StandardPayload` schema.

### 6. Access Control Model

Research recommends three-layer system:
1. **Declared capabilities** (manifest) — what agent CAN do
2. **Scoped tokens** (invocation time) — subset for this specific task
3. **Runtime policy** — context-aware enforcement

Key question: Default-allow within same project, default-deny across projects?

Visibility scoping options:
- `.gitignore`-style visibility config
- Allowlist vs blocklist per agent
- "NOT_FOUND" rather than "FORBIDDEN" for hidden agents (Microsoft Teams pattern)

### 7. Loop Prevention & Coordination Safety (→ split Relay/Mesh)

> **Note:** Budget envelope enforcement moves to Relay. Mesh configures budget policies per agent/project.

Budget envelope (propagated with every message, can only decrease):
```typescript
interface RelayBudget {
  hopCount: number;        // incremented at each hop
  maxHops: number;         // default: 5, cannot increase
  ancestorChain: string[]; // endpoint IDs that touched this message
  ttl: number;             // Unix timestamp expiry
  callBudgetRemaining: number; // decremented per call
  deadline: number;        // wall-clock deadline
}
```

**Relay owns:** circuit breakers, rate limiting, dead letter queue, budget enforcement
**Mesh owns:** budget policies per agent, supervision trees, cycle detection rules

### 8. Agent Identity

Options (not yet decided):
- Declared ID in manifest (user-controlled, portable)
- Directory path hash (stable, automatic)
- Git remote URL (globally unique, git-dependent)
- Recommendation from research: manifest ID if present, path hash as fallback

### 9. Namespace / Project Isolation

- Projects as namespaces (like Linux namespaces)
- Agents within same project: default-allow communication
- Cross-project: requires explicit configuration
- Subject naming (via Relay): `relay.agent.{project}.{agent-id}` (decided in Relay design)
- Mesh configures Relay access rules per namespace (cross-project deny by default)

### 10. Integration with Existing DorkOS Systems

- **Relay:** Mesh configures Relay's routing for agent endpoints (inboxes, outboxes, access rules)
- **Pulse:** Pulse dispatches scheduled messages via Relay (not directly to AgentManager)
- **MCP Tool Server:** Expose mesh_discover, mesh_topology as MCP tools; Relay exposes relay_send, relay_inbox
- **AgentManager:** Auto-register agents when sessions are created
- **Session Broadcaster:** Reuse chokidar pattern for mailbox watching
- **Console UI:** Topology view, agent status, message log

### 11. API Surface (revised — messaging routes moved to Relay)

Mesh routes (discovery + topology only):
```
GET  /api/mesh/agents                  — all registered agents
GET  /api/mesh/agents?project=backend  — filter by project
GET  /api/mesh/agents/:id              — single agent detail
GET  /api/mesh/topology                — agent relationship graph
SSE  /api/mesh/events                  — real-time mesh event stream (discovery, topology changes)
```

Messaging routes (now in Relay):
```
POST /api/relay/send                   — send a message (was /api/mesh/agents/:id/messages)
GET  /api/relay/inbox/:subject         — endpoint inbox (was /api/mesh/agents/:id/messages)
GET  /api/relay/messages/:id/trace     — message trace
SSE  /api/relay/events                 — real-time delivery events
```

### 12. Agent Behavior Policy

When agents receive messages (especially from group channels), Mesh defines the behavior rules:

**Adapter-level filtering** (first gate — configurable per channel):
- `all`: Forward every message (agent monitors the channel)
- `mentions-only`: Forward @mentions and direct replies only
- `none`: Never forward

**Agent-level instructions** (second gate — in manifest or CLAUDE.md):
- When to respond vs. observe silently
- Response style per channel (brief in group, detailed in DM)
- Escalation rules (when to notify a human)

The adapter does crude filtering; the agent makes nuanced judgment calls. This mirrors how Discord/Slack bots work, but with LLM-level contextual understanding.

---

## Research Completed

Four deep research reports saved to `research/mesh/`:

1. **`discovery-patterns.md`** — Service discovery (Consul, etcd, ZooKeeper), filesystem scanning (systemd, VS Code, Obsidian, Next.js), A2A Agent Cards, Claude Code subagent format, chokidar vs polling
2. **`communication-protocols.md`** — FIPA ACL, Contract Net Protocol, modern frameworks (AutoGen, CrewAI, LangGraph, Swarm, MetaGPT), IPC options (Unix sockets, Maildir, SQLite), loop prevention (9 mechanisms)
3. **`access-control-coordination.md`** — RBAC limitations for agents, capability-based security (ocap/UCAN), Android/iOS permission models, Erlang supervision trees, budget envelopes, saga pattern, prompt injection as real threat vector
4. **`architecture-analogies.md`** — Service mesh (Istio/Linkerd), OS IPC (Mach ports, D-Bus, XPC), pub/sub (NATS), mesh networking (Bluetooth/Zigbee), A2A/MCP protocols, full OS concept mapping table

### Key Research Convergences

1. **OS analogy > service mesh analogy** — D-Bus, Mach ports, Linux namespaces are richer precedents than Istio/Linkerd for single-machine
2. **A2A Agent Cards are the industry standard** — Google's protocol (April 2025, now Linux Foundation) defines the manifest format to align with
3. **Real threat = misconfiguration + prompt injection**, not cryptographic adversaries
4. **Budget envelopes are non-negotiable safety** — hop_count, maxHops, ancestorChain, TTL, callBudgetRemaining
5. **Erlang/OTP supervision trees** map cleanly to agent coordination (MaxRestarts + MaxTime = circuit breaker)

---

## Analogous Systems Reference

| System | What We Borrow |
|---|---|
| D-Bus | Two-bus model (project bus + system bus), name registry, signals |
| Mach ports | Capability-based access, transferable port rights for direct channels |
| NATS | Hierarchical topic naming with wildcards (`*` and `>`) |
| A2A Protocol | Agent Card manifest format, task state machine, skill declarations |
| Maildir | Lock-free atomic message queuing via POSIX rename |
| systemd | Filesystem scanning, priority layering, drop-in config |
| Erlang/OTP | Supervision trees, restart strategies, MaxRestarts/MaxTime |
| Android | Manifest-declared permissions, runtime grant/deny for dangerous ops |
| Contract Net | Task announcement → bid → award → result lifecycle |

---

## Open Questions for Design Discussion

- ~~Should the topic/event bus be in-process EventEmitter (Phase 1) upgradable to embedded NATS?~~ **Answered:** Relay uses NATS-style hierarchical subjects with in-process matching (~30 lines). No EventEmitter vs NATS decision needed — it's a custom implementation using the NATS subject convention.
- How does lazy activation work? (Agent not running, message arrives — start it?)
- Should Mesh support both clean delegation (task inputs only) and context handoff (full session)?
- How does the Console UI visualize the mesh? Topology graph? Message timeline?
- What's the CLI surface? `dorkos mesh list`, `dorkos mesh send`, `dorkos mesh status`?
- How does Mesh interact with Wing (persistent memory) when Wing is built?
- How does agent behavior policy interact with the manifest format? (See decision #12)
- Should agent runtime selection (Claude Code vs Codex vs OpenCode) live in Mesh manifests?

---

## Implementation Phases (Draft — revised for Relay-first)

> **Prerequisite:** Relay must be designed and built first. Mesh Phase 1 depends on Relay being operational.

**Phase 1 — Discovery + Registry:** (after Relay exists)
- MeshRegistry service (in-memory + SQLite persistence)
- Filesystem scanner with chokidar
- `.dork/agent.json` manifest format
- Auto-registration when AgentManager creates sessions
- Configure Relay inboxes for discovered agents
- HTTP routes: GET /api/mesh/agents

**Phase 2 — Agent Networking:**
- Access control rules (Mesh writes, Relay enforces)
- Budget policies per agent/project
- MCP tools: mesh_discover, mesh_topology
- Agent-to-agent messaging via Relay

**Phase 3 — Observability + Advanced:**
- Supervision trees (agent-level supervisors)
- Console UI: topology view, agent status
- Cross-project visibility configuration
- Lazy activation (start agent on incoming message)
- CLI commands (dorkos mesh ...)
