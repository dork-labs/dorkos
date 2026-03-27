---
number: 156
title: Use Code-Based Route Definitions Over File-Based Routing
status: accepted
created: 2026-03-20
spec: dashboard-home-route
superseded-by: null
---

# 0156. Use Code-Based Route Definitions Over File-Based Routing

## Status

Accepted

## Context

TanStack Router supports two routing modes: file-based routing (using `@tanstack/router-vite-plugin` to auto-generate routes from a directory structure) and code-based routing (manually defining routes in TypeScript). File-based routing is TanStack Router's recommended default for new projects and offers automatic code splitting and type generation. However, DorkOS has an unusual constraint: it uses Feature-Sliced Design (FSD) with a strict unidirectional layer hierarchy, and the dev playground is intentionally excluded from the router (handled by `window.location.pathname.startsWith('/dev')` before RouterProvider is reached). The route tree is small (3 routes initially) and the app shell is a shared layout concern that sits outside any single FSD feature.

## Decision

Use code-based route definitions in a single `apps/client/src/router.ts` file at the app root (outside FSD layers, since routes are app-level orchestration). Routes are explicitly constructed with `createRootRouteWithContext`, `createRoute`, and assembled via `addChildren`. The `@tanstack/router-vite-plugin` is not installed. This keeps the route tree explicit and auditable, avoids coupling the router's file scanning to FSD directory conventions, and preserves the dev playground's pre-router exit path without configuration workarounds.

## Consequences

### Positive

- Route tree is explicit and fully visible in one file — no magic file scanning or generated artifacts
- No conflict between file-based route directory conventions and FSD layer structure
- Dev playground exclusion before RouterProvider is trivially preserved — no plugin configuration needed
- Type registration via `declare module '@tanstack/react-router'` gives full type safety without a code generator
- Easier to reason about route relationships and add conditional logic (e.g., `beforeLoad` redirects)

### Negative

- Route-level code splitting must be added manually via dynamic `import()` in route component definitions (not automatic)
- As the route tree grows, `router.ts` becomes a coordination point that must be maintained by hand
- Diverges from TanStack Router's recommended default (file-based), which may conflict with future documentation or tooling assumptions
