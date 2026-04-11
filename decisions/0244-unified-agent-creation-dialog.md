---
number: 244
title: Unified Three-Tab Agent Creation Dialog
status: draft
created: 2026-04-11
spec: standardize-agent-creation-flow
superseded-by: null
---

# 0244. Unified Three-Tab Agent Creation Dialog

## Status

Draft (auto-extracted from spec: standardize-agent-creation-flow)

## Context

DorkOS has 5+ entry points for creating agents, using two different dialog systems (`CreateAgentDialog` via Zustand store and `AgentDialog` via app-store), two different hooks (`useCreateAgent` and `useInitAgent`), and a separate dialog for filesystem discovery. The dashboard sidebar and session sidebar are wired to the wrong dialog (editing instead of creation). This inconsistency confuses users and creates maintenance burden.

## Decision

Replace the current `CreateAgentDialog` with a unified three-tab dialog: "New Agent" (from scratch), "From Template" (marketplace), and "Import" (filesystem scan via reused `DiscoveryView` component). All entry points in the app will open this same dialog via `useAgentCreationStore.open(tab?)`. The store gains an optional `initialTab` parameter so entry points can pre-focus on a specific tab (e.g., sidebar "Import project" opens directly to the Import tab).

## Consequences

### Positive

- Single mental model for users: one dialog handles all "add agent" flows
- Fixes two bugs (sidebar/session entry points opening wrong dialog)
- Net reduction in components (separate discovery dialog deleted)
- Reuses `DiscoveryView` as-is for the Import tab

### Negative

- Dialog is slightly larger to accommodate three tab contents
- Tab 1 and Tab 2 share name/location fields but cannot easily share a single instance (different submit behavior)
- The Import tab's "Create" footer button must be conditionally hidden since DiscoveryView has its own actions
