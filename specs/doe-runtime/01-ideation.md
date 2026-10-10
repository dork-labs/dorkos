---
slug: doe-runtime
number: 261008-052829
created: 2026-10-08
status: ideation
---

# Use the DorkOS business engine in the app

**Slug:** doe-runtime
**Author:** Codex
**Date:** 2026-10-08

## 1) Intent & Assumptions

DOR-2787 exposes the merged standalone engine as a normal runtime choice named DorkOS. DOR-2786 is merged and closed. The person selects an explicit model and bill; unavailable credentials or credits refuse. The host owns accounts, permissions, tools, resource roots, display events and schedules. The engine owns model messages and compaction. Defaults, onboarding, Runs on ordering, the status-bar item and the beat runner remain separate tickets.

## 2) Pre-reading Log

Read vision context 16 before prompt 15, the north-star documents, vision reset plan, runtime research, proactive agents and role-play research, runtime guide, AgentRuntime and conformance contracts. Read the engine's public contracts, capability registry and MCP projection, authenticated MCP injection, credits resolver, credential store, context assembly and Harness discovery. Two read-only workers independently mapped resources/tools and credentials/platform surfaces; their reports agree with these boundaries.

## 3) Codebase Map

`services/runtimes/doe/` adapts engine contracts. Shared runtime schemas, capability matrix, credits contracts and config migration admit the new runtime. Composition registers it before session broadcasting. Session EventLog supplies display history; engine SQLite retains lossless model history independently. Harness supplies source trees directly. Existing MCP auth and turn leases preserve caller identity. The client adds a settings card and ordinary choice with no default change. Search, memory, room, schedule and ledger censuses must include the fourth runtime.

## 5) Research

Reuse the package delivered by PR #2683, including Pi core, deferred search, MCP client, resources, builder, SQLite history and compaction. Reuse the platform's encrypted credential store, credits client, event projection and authenticated MCP boundary. Do not create another model loop, auth store, vendor projection, permission system or scheduler. A singular credits protocol is insufficient; explicit supported formats and a selected format are needed. Engine MCP aliases have hash suffixes, so context must teach exact callable names. Host DorkOS aliases can remain bare when wrapping authenticated MCP calls; foreign aliases remain distinct.

## 6) Decisions

| Decision                | Choice                                                 | Reason                                                                     |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Runtime identity        | `doe`, app label DorkOS                                | Explicit brief                                                             |
| Display / model history | EventLog / engine SQLite                               | Bounded display history cannot replace full model records                  |
| Credentials             | Explicit config and encrypted references               | No ambient SDK login or silent payer change                                |
| Tools                   | Registry-derived metadata, authenticated MCP execution | Automatic new capabilities without bypassing caller gates                  |
| Resources               | Direct canonical Harness source roots                  | No vendor-owned trees                                                      |
| Workflow                | Canonical task JSON and autonomous merging             | User explicitly authorized unavailable Task API fallback and full delivery |

No product intent questions remain; existing contracts settle routine implementation choices.
