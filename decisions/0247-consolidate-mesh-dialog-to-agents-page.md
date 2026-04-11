---
number: 247
title: Consolidate Mesh Dialog to Agents Page
status: proposed
created: 2026-04-11
spec: mesh-panel-consolidation
superseded-by: null
---

# 0247. Consolidate Mesh Dialog to Agents Page

## Status

Proposed

## Context

The app has two overlapping surfaces for agent/mesh management: a MeshPanel dialog (4 tabs: Topology, Discovery, Denied, Access) opened from command palette, status cards, feature promos, and URL deep-links; and a dedicated `/agents` page with List and Topology views. They share the same TopologyGraph component and useTopology() hook but differ in additional functionality. This split-brain UX forces users to guess which surface has what capability, and the dialog — with 4 tabs, a topology graph, and a detail panel — has outgrown the modal pattern per NN/Group guidance and industry precedent (Linear, GitHub, Vercel).

## Decision

Eliminate the MeshPanel dialog entirely. Migrate its unique functionality (Denied view, Access view, AgentHealthDetail split-pane) to the `/agents` page as new URL-driven view modes (`?view=denied`, `?view=access`). Redirect all dialog entry points (command palette, status card, feature promo) to page navigation via `navigate()`. Remove the dialog infrastructure: MeshDialogWrapper, `meshOpen` Zustand state, `useMeshDeepLink`, and DispatcherStore mesh property. Discovery remains as a header-button dialog since it is a transient action, not a persistent view.

## Consequences

### Positive

- Single source of truth for all agent/mesh management — no split-brain UX
- Reduced maintenance burden — one surface instead of two with overlapping functionality
- URL-driven view state enables bookmarking and sharing of specific views
- Removes ~500 lines of dialog infrastructure and one Zustand slice entry
- Command palette actions become navigation (consistent with other page-level features)

### Negative

- Users lose "quick access from anywhere" without leaving their current context (mitigated: command palette → navigate is a single keystroke difference)
- 4-tab bar on the Agents page is denser than the previous 2-tab version (mitigated: 2+2 visual grouping, well within NN/Group's 5-6 tab threshold)
- One-time migration effort: ~15 files modified, ~5 deleted, ~10 tests updated
