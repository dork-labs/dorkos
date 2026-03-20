---
number: 161
title: Route-Aware Sidebar & Header Slot Pattern via Private Switch Hooks
status: draft
created: 2026-03-20
spec: dynamic-sidebar-content
superseded-by: null
---

# 0161. Route-Aware Sidebar & Header Slot Pattern via Private Switch Hooks

## Status

Draft (auto-extracted from spec: dynamic-sidebar-content)

## Context

After introducing TanStack Router (spec 154), the AppShell renders a single sidebar and header regardless of which route is active. The dashboard route shows the same session-list sidebar as the chat route, which is confusing. We need a flexible system for route-dependent sidebar and header content that supports animated transitions.

Five approaches were evaluated: Outlet Context, Content Map/Switch Hook, Context/Provider, Switch Inside AgentSidebar, and Compound Route Components. The key trade-offs were synchronous rendering (no flash), FSD compliance, extensibility, and animation friendliness.

## Decision

Use private switch hooks (`useSidebarSlot`, `useHeaderSlot`) in AppShell that read the current pathname via `useRouterState` and return `{ key, body/content }` tuples. The `key` drives `AnimatePresence` cross-fade transitions. The hooks are private to AppShell (not exported), keeping the pattern simple and contained.

The sidebar footer (`SidebarFooterBar`) and static chrome (`SidebarRail`, `SidebarTrigger`) render outside the `AnimatePresence` wrapper and are route-agnostic.

## Consequences

### Positive

- Synchronous render — no flash of empty sidebar during route transitions
- FSD-compliant — AppShell is app-level orchestration, can import from any layer
- Extensible — add a new route case with one line; can also read Zustand, feature flags, or query params
- Trivial animation — AnimatePresence + key change handles cross-fade automatically
- Clean separation — sidebar footer stays static, body animates

### Negative

- AppShell imports all sidebar variants (mitigated by lazy loading if variants grow heavy)
- Adding a new route requires editing AppShell's switch hooks (acceptable centralization for app-level orchestration)
