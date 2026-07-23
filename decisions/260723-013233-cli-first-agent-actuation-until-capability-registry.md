---
id: 260723-013233
title: CLI-first agent actuation, hand-registered tools until the Capability Registry
status: accepted
created: 2026-07-23
spec: agents-as-operators
superseded-by: null
---

# 260723-013233. CLI-first agent actuation, hand-registered tools until the Capability Registry

## Status

Accepted

## Context

DorkOS agents must be able to do anything a user can do, but the capability surface had drifted across four hand-maintained projections (in-session MCP, external `/mcp`, CLI, OpenAPI). Only the claude-code runtime can receive DorkOS's in-process MCP server; Codex gets a single scoped `control_ui` tool and OpenCode gets none, while every runtime can execute shell commands. External 2026 evidence also shows CLIs are substantially cheaper and more reliable for agents than large MCP tool schemas.

## Decision

We will treat the `dorkos` CLI as the universal agent actuation surface: operator verbs (`agent`, `task`, `activity`, `version`) with a stable `--json` contract, reachable from every runtime. The MCP servers stay as the structured layer, with new tools hand-registered on both servers via transport-neutral descriptor tables (`marketplace-tool-descriptors.ts`, `operator-tool-descriptors.ts`) that import no SDK. Phase 2 replaces hand-registration and CLI internals with projections generated from a single Capability Registry; command names, flags, and tool names are the stable contract that generation must preserve.

## Consequences

### Positive

- Agents in Codex and OpenCode sessions gain full DorkOS actuation today, without waiting for MCP injection support that may never exist.
- The descriptor-table pattern eliminated the in-session/external drift class (marketplace tools were external-only before it).
- Phase 2's registry has concrete, shipped call sites to generalize from instead of a speculative design.

### Negative

- Until the registry lands, adding a capability still means touching several files by hand (descriptors, both registrations, CLI verb, OpenAPI); drift remains possible by omission.
- The in-session tool count grew to ~55, raising per-turn schema cost until registry-driven curation arrives.
