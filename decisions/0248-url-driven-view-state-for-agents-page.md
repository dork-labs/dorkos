---
number: 248
title: URL-Driven View State for Agents Page
status: draft
created: 2026-04-11
spec: mesh-panel-consolidation
superseded-by: null
---

# 0248. URL-Driven View State for Agents Page

## Status

Draft (auto-extracted from spec: mesh-panel-consolidation)

## Context

The Agents page needs to support 4 views (List, Topology, Denied, Access) plus an optional detail panel for topology node selection. The two main options for view state management are: (1) local React state (useState), or (2) URL search params via TanStack Router's `validateSearch` with a Zod schema. The existing page already uses `?view=list|topology` via TanStack Router search params.

## Decision

Use TanStack Router's `validateSearch` with a Zod enum for all view state: `z.enum(['list', 'topology', 'denied', 'access']).default('list')` plus an optional `agent` string param for the topology detail panel. View switching navigates with `navigate({ search: (prev) => ({ ...prev, view: newView }) })` to preserve other params (sort, filters). This extends the existing pattern rather than introducing a new state mechanism.

## Consequences

### Positive

- Views are bookmarkable, shareable, and work with browser back/forward
- Type-safe via Zod validation — invalid view params fall back to default
- Consistent with existing pattern (already used for list/topology)
- Selected agent in topology is URL-encoded (`?agent=<id>`), enabling deep-links to specific agent health panels
- Functional search param update `(prev) => ({ ...prev, view })` preserves sort/filter state across view switches

### Negative

- Every view switch triggers a router navigation (minimal overhead, but worth noting)
- URL becomes slightly more complex with additional params
