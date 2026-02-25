---
title: Mesh Spec Sequence
description: Overview and index for the 4-spec Mesh build sequence.
created: 2026-02-24
module: mesh
totalSpecs: 4
parallelizable: [[3, 4]]
estimatedPhases:
  - specs: [1, 2]
    description: "Core library + server/client integration — minimum viable Mesh"
  - specs: [3, 4]
    description: "Network topology + observability — can run in parallel"
---

# Mesh Spec Sequence — Overview

Mesh is the agent discovery and network topology layer for DorkOS. It's being built across 4 specs, each designed as a standalone `/ideate` run.

## Execution Order

```
  Spec 1: Core Library          (no dependencies — start here)
       │
       v
  Spec 2: Server & Client       (blocked by 1)
       │
       ├──────────────┐
       v              v
  Spec 3: Topology    Spec 4: Observability    ← CAN RUN IN PARALLEL
```

| Spec | Title | Prompt File | Blocked By | Parallel With | Risk | Complexity |
|---|---|---|---|---|---|---|
| 1 | Mesh Core Library | `01-mesh-core-library.md` | — | — | High | High |
| 2 | Server & Client Integration | `02-mesh-server-client-integration.md` | Spec 1 | — | Medium | Medium |
| 3 | Network Topology | `03-mesh-network-topology.md` | Spec 2 | **Spec 4** | Medium | High |
| 4 | Observability & Lifecycle | `04-mesh-observability-lifecycle.md` | Spec 2 | **Spec 3** | Medium | Medium |

## Dependency on Relay

**Mesh depends on Relay. Relay depends on nothing.** Mesh registers endpoints in Relay and writes access control rules that Relay enforces. The `@dorkos/relay` package must be available before Mesh Spec 1 begins. Relay Specs 1-2 (core library + server integration) must be complete. Relay Specs 3-6 are not required — Mesh works with the base Relay.

**Agent activation is NOT Mesh's responsibility.** When a message arrives for an agent, Relay's runtime adapters (see [Relay Spec 6](../relay-specs/06-relay-runtime-adapters.md)) handle starting the agent session. Mesh is the phone book — it knows where agents live. Relay's runtime adapters are the phones — they know how to start a conversation.

## Key Design Decisions

These decisions are baked into the spec sequence:

1. **Discovery is not registration.** Discovery finds candidates. Registration is an intentional act (human or agent approved). Only registered agents get Relay endpoints and network visibility.
2. **Pluggable discovery strategies.** Not hardcoded to `.claude/`. Strategies for Claude Code, Cursor, Codex ship built-in. Custom strategies are configurable.
3. **`.dork/agent.json` is Mesh's artifact.** Written at registration time. Also importable if hand-authored. The manifest's presence IS the registration.
4. **Three approval interfaces.** Console UI, MCP tools (agent-driven), CLI. All converge on the same core operations.
5. **Deny list is persistent.** Denied candidates don't resurface. Stored in Mesh's SQLite, not in the project directory.

## Frontmatter Reference

Each spec file includes YAML frontmatter with these fields:

| Field | Purpose |
|---|---|
| `spec` | Spec number (1-4) |
| `order` | Execution order (3 and 4 share order 3 — they're parallel) |
| `status` | `not-started` / `ideating` / `specified` / `in-progress` / `complete` |
| `blockedBy` | Spec numbers that must be complete before starting |
| `blocks` | Spec numbers that this spec blocks |
| `parallelWith` | Spec numbers that can run simultaneously with this one |
| `litepaperPhase` | Which litepaper roadmap phase this implements |
| `complexity` | `low` / `medium` / `high` |
| `risk` | `low` / `medium` / `high` — architectural risk level |
| `estimatedFiles` | Approximate number of files created/modified |
| `newPackages` | New workspace packages created (if any) |
| `primaryWorkspaces` | Which monorepo workspaces are affected |
| `touchesServer` | Whether `apps/server` is modified |
| `touchesClient` | Whether `apps/client` is modified |
| `verification` | Checklist of conditions that prove the spec is complete |
| `notes` | Key things to know before starting |

## How to Use

1. Check the spec's `blockedBy` — make sure those specs are `complete`
2. Copy the **Prompt** section (inside the code block) from the spec file
3. Run `/ideate <paste prompt here>`
4. Update the spec's `status` frontmatter as you progress
5. After implementation, run through the `verification` checklist

Each prompt is self-contained — it includes all the context the /ideate exploration and research agents need.

## Source Documents

All specs reference these shared source materials:

- [Mesh Litepaper](../../../meta/modules/mesh-litepaper.md) — vision, agent lifecycle, discovery strategies, registration workflow
- [Relay Litepaper](../../../meta/modules/relay-litepaper.md) — messaging layer that Mesh builds on
- [Main DorkOS Litepaper](../../../meta/dorkos-litepaper.md) — system-level architecture
- [Relay Spec Sequence](../relay-specs/00-overview.md) — the Relay build that Mesh depends on
- Existing Relay code: `packages/relay/`, `apps/server/src/routes/relay.ts`, `apps/client/src/layers/features/relay/`
