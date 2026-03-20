---
number: 157
title: Use Pathless Layout Route for Shared App Shell
status: draft
created: 2026-03-20
spec: dashboard-home-route
superseded-by: null
---

# 0157. Use Pathless Layout Route for Shared App Shell

## Status

Draft (auto-extracted from spec: dashboard-home-route)

## Context

The DorkOS standalone app shell includes a sidebar, header, `DialogHost`, `CommandPaletteDialog`, `ShortcutsPanel`, and `Toaster` that must be shared across all routed views (`/` dashboard and `/session` chat). The naive approach is to nest content routes as children of a path-bearing layout route (e.g., `/app/` as a parent), but this would add an unwanted URL segment and break the intended URL structure (`/` and `/session`). Alternatively, each route could render the shell independently, but this duplicates markup, breaks dialog state across navigation, and prevents shared layout animations.

## Decision

Use a TanStack Router pathless layout route — a route created with `id: '_shell'` instead of a `path` — as the parent for both the index route (`/`) and the session route (`/session`). The `AppShell` component is extracted from `App.tsx` into `apps/client/src/AppShell.tsx` and assigned as the component of this pathless route. It renders sidebar, header, shared overlays, and an `<Outlet>` where route content renders. The pathless route adds no URL segment, so both child routes keep their clean paths while sharing a single shell instance across navigations.

## Consequences

### Positive

- Both `/` and `/session` share one shell instance — dialog state, sidebar state, and animations persist across navigations without remounting
- No URL pollution — neither route gets an artificial path prefix from the layout parent
- `AppShell.tsx` becomes the canonical location for standalone mode shell logic, shrinking `App.tsx` to embedded-mode-only code
- The pattern is idiomatic TanStack Router — `id`-based pathless routes are a first-class feature, not a workaround
- Shared overlays (`DialogHost`, `CommandPaletteDialog`, `Toaster`) render once at shell level, preserving their internal state across route transitions

### Negative

- Pathless routes are a less familiar pattern than standard nested routes — developers new to TanStack Router may not recognize `id: '_shell'` as a layout boundary at first glance
- `App.tsx` and `AppShell.tsx` become two separate entry points for the two modes (embedded vs standalone), requiring clear documentation of which file owns which rendering path
