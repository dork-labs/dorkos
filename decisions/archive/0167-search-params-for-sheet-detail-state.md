---
number: 167
title: Use Search Params for Sheet Detail State
status: proposed
created: 2026-03-20
spec: attention-item-detail-navigation
superseded-by: null
---

# 0167. Use Search Params for Sheet Detail State

## Status

Proposed

## Context

The dashboard's "Needs Attention" section has "View" buttons that need to open detail Sheets for specific items (dead letters, failed runs, offline agents). The state for which Sheet is open and which item is focused needs to be stored somewhere. The existing pattern uses Zustand (`setPulseOpen`, `setRelayOpen`, `setMeshOpen`) for subsystem panel state, but this approach is not deep-linkable, doesn't support browser back button, and loses state on page refresh.

## Decision

Use TanStack Router search params on the dashboard route (`/?detail=dead-letter&itemId=abc`) to drive Sheet open state and item selection. This follows the existing pattern established on the `/session` route with `?session=` and `?dir=` search params. Zustand panel state setters are removed from attention item action handlers — they continue to be used by subsystem status cards for their own click handlers.

## Consequences

### Positive

- Deep-linkable URLs — attention item detail views can be shared and bookmarked
- Browser back button closes the Sheet naturally (no custom history management)
- State survives page refresh — Sheet reopens to the correct item
- Type-safe via Zod validation on the route search schema
- Consistent with existing TanStack Router search param patterns in the codebase

### Negative

- Slightly more setup than extending Zustand state (route schema, navigate calls)
- Two state management patterns coexist: Zustand for subsystem panel open/close, search params for attention detail Sheets
- URL can look noisy with multiple search params
