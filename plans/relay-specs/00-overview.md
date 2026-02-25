---
title: Relay Spec Sequence
description: Overview and index for the 6-spec Relay build sequence.
created: 2026-02-24
module: relay
totalSpecs: 6
parallelizable: [[3, 4]]
estimatedPhases:
  - specs: [1, 2]
    description: "Core library + server/client integration — minimum viable Relay"
  - specs: [3, 4]
    description: "Reliability + external adapters — can run in parallel"
  - specs: [6]
    description: "Unified adapter system + Claude Code runtime adapter"
  - specs: [5]
    description: "Convergence — Pulse/Console migration, full unification"
---

# Relay Spec Sequence — Overview

Relay is the universal message bus for DorkOS. It's being built across 6 specs, each designed as a standalone `/ideate` run.

## Execution Order

```
  Spec 1: Core Library          (no dependencies — start here)
       │
       v
  Spec 2: Server & Client       (blocked by 1)
       │
       ├──────────────┐
       v              v
  Spec 3: Reliability  Spec 4: External Adapters    ← CAN RUN IN PARALLEL
       │              │
       │              v
       │         Spec 6: Unified Adapters + Claude Code  (blocked by 4)
       │              │
       └──────┬───────┘
              v
  Spec 5: Convergence           (blocked by 3 AND 6)
```

| Spec | Title | Prompt File | Blocked By | Parallel With | Risk | Complexity |
|---|---|---|---|---|---|---|
| 1 | Relay Core Library | `01-relay-core-library.md` | — | — | High | High |
| 2 | Server & Client Integration | `02-relay-server-client-integration.md` | Spec 1 | — | Medium | Medium |
| 3 | Advanced Reliability | `03-relay-advanced-reliability.md` | Spec 2 | **Spec 4** | Low | Medium |
| 4 | External Adapters | `04-relay-external-adapters.md` | Spec 2 | **Spec 3** | Medium | High |
| 5 | Convergence | `05-relay-convergence.md` | Specs 3 & 6 | — | High | High |
| 6 | Unified Adapters + Claude Code | `06-relay-runtime-adapters.md` | Spec 4 | **Spec 3** | High | High |

## Frontmatter Reference

Each spec file includes YAML frontmatter with these fields:

| Field | Purpose |
|---|---|
| `spec` | Spec number (1-6) |
| `order` | Execution order |
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

- [Relay Litepaper](../../../meta/modules/relay-litepaper.md) — vision and architecture
- [Relay Design Doc](../2026-02-24-relay-design.md) — technical decisions and interfaces
- [Mesh Litepaper](../../../meta/modules/mesh-litepaper.md) — discovery layer that builds on Relay
- [Mesh Design Doc](../2026-02-24-mesh-design.md) — Mesh technical decisions
- [Litepaper Review](../2026-02-24-litepaper-review.md) — open design questions (OQ-1 through OQ-8)
- [Main DorkOS Litepaper](../../../meta/dorkos-litepaper.md) — system-level architecture
- Research: `research/mesh/` — communication protocols, architecture analogies, access control, discovery patterns
- Research: `research/20260224_agent_messaging_transport_libraries.md` — transport library evaluation
