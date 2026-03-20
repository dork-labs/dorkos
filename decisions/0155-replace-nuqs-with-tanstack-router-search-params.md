---
number: 155
title: Replace nuqs with TanStack Router Search Params
status: draft
created: 2026-03-20
spec: dashboard-home-route
superseded-by: null
---

# 0155. Replace nuqs with TanStack Router Search Params

## Status

Draft (auto-extracted from spec: dashboard-home-route)

## Context

The DorkOS client uses nuqs (`^2.8.8`) for URL search param state (`?session=`, `?dir=`). With the introduction of TanStack Router (ADR-0154), the router provides its own first-class search param system via `validateSearch` and `Route.useSearch()`. Running both nuqs and TanStack Router's search params would mean two competing URL state systems.

## Decision

Remove nuqs entirely. Rewrite `useSessionId()` and `useDirectoryState()` to use TanStack Router's `validateSearch` with Zod schemas and `useSearch()` / `useNavigate()` for search param access and updates. The hooks maintain their existing public API (`[value, setter]`) so consumer components require zero changes.

## Consequences

### Positive

- Single source of truth for URL state (router owns both path and search params)
- Eliminates a dependency — one fewer library to maintain
- Search param schemas are Zod-validated and type-safe at the route definition level
- No risk of drift between nuqs parsers and route expectations

### Negative

- Requires rewriting 2 hook implementations and updating 1 test file that mocks nuqs directly
- Hooks must handle being called outside the session route (solved via `useSessionSearch` helper)
- Embedded (Obsidian) mode still uses Zustand — dual-mode logic preserved but implementation changes
