---
number: 154
title: Adopt TanStack Router for Client-Side Routing
status: draft
created: 2026-03-20
spec: dashboard-home-route
superseded-by: null
---

# 0154. Adopt TanStack Router for Client-Side Routing

## Status

Draft (auto-extracted from spec: dashboard-home-route)

## Context

The DorkOS client currently has no router. The entire app renders `<ChatPanel>` at `/` with URL state managed by nuqs (`?session=`, `?dir=`). This works for a single-view app but blocks the product's evolution toward a multi-view "mission control" experience described in the litepaper (VL-03: Multi-Session Command Center). The app cannot add dashboard, settings, or other views without a router, and the dev playground already uses raw `window.location.pathname` as a workaround. The project already uses TanStack Query and TanStack Virtual, making ecosystem alignment a natural consideration.

## Decision

Adopt `@tanstack/react-router` as the client-side routing library. Code-based route definitions are used (not file-based), giving explicit control over the route tree. The router uses `createRootRouteWithContext` to inject `QueryClient` into router context, enabling route loaders to prefetch data for future dashboard content. TanStack Router is chosen over React Router v7 primarily for its first-class type-safe routes and search params via Zod schemas, tighter TanStack ecosystem cohesion, and the ability to eliminate nuqs as a separate dependency entirely.

## Consequences

### Positive

- Type-safe routes and search params — Zod schemas colocated with route definitions are the single source of truth for URL shape
- Tighter TanStack ecosystem cohesion — Query, Virtual, and Router all share the same mental model and integration patterns
- `defaultPreload: 'intent'` fires route loaders on hover/focus for instant navigation feel
- Router context pattern (`createRootRouteWithContext`) enables future route-level data prefetching without architectural changes
- Eliminates the nuqs dependency entirely — one fewer library to maintain

### Negative

- Larger bundle than React Router v7 (~45KB vs ~20KB, net ~4KB gzipped after removing nuqs)
- Newer library with a smaller community ecosystem than React Router
- Requires rewriting `useSessionId`, `useDirectoryState`, and updating hook-level test mocks
- TanStack Router-specific patterns (validateSearch, pathless layout routes) have a learning curve
